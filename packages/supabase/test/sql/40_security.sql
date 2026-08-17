-- Who is allowed to do what.
--
-- Postgres grants EXECUTE on new functions to PUBLIC. A pack that forgets one
-- revoke lets any signed-in client call record_purchase and grant itself a
-- subscription, so this file exists to make that failure loud.

\set ON_ERROR_STOP on

-- --- an ordinary user cannot write anything ---------------------------------
do $$
declare
  u uuid := t_user('33333333-3333-4333-8333-000000000001');
  denied boolean;
begin
  perform tollgate.record_purchase(u, t_purchase(p_txn => 'sa1', p_original => 'sa'));

  set local role authenticated;

  denied := false;
  begin
    perform tollgate.record_purchase(u, t_purchase(p_txn => 'sa2', p_original => 'sa2'));
  exception when insufficient_privilege then
    denied := true;
  end;
  perform t_assert(denied, 'record_purchase must be out of reach of a client');

  denied := false;
  begin
    perform tollgate.revoke_purchase('fake', 'sa', null, 'nope', null);
  exception when insufficient_privilege then
    denied := true;
  end;
  perform t_assert(denied, 'and so must revoke_purchase');

  denied := false;
  begin
    perform tollgate.recompute_entitlements(u);
  exception when insufficient_privilege then
    denied := true;
  end;
  perform t_assert(denied, 'and recompute_entitlements');

  denied := false;
  begin
    perform tollgate.get_entitlements(u);
  exception when insufficient_privilege then
    denied := true;
  end;
  perform t_assert(denied, 'reading somebody else by id is server-only too');

  reset role;
  perform t_ok('an ordinary user cannot write anything');
end
$$;

-- --- anon cannot reach the pack at all --------------------------------------
do $$
declare
  denied boolean := false;
begin
  set local role anon;
  begin
    perform tollgate.my_entitlements();
  exception when insufficient_privilege then
    denied := true;
  end;
  reset role;
  perform t_assert(denied, 'a signed-out visitor has no entitlements to ask about');
  perform t_ok('anon cannot reach the pack at all');
end
$$;

-- --- a user reads their own entitlements, and only their own ----------------
do $$
declare
  me uuid := t_user('33333333-3333-4333-8333-000000000002');
  them uuid := t_user('33333333-3333-4333-8333-000000000003');
  seen jsonb;
  n int;
begin
  perform tollgate.record_purchase(me, t_purchase(p_txn => 'sb1', p_original => 'sb'));
  perform tollgate.record_purchase(them, t_purchase(p_txn => 'sc1', p_original => 'sc'));

  perform set_config('tollgate.test_uid', me::text, true);
  set local role authenticated;

  seen := tollgate.my_entitlements();
  perform t_eq(jsonb_array_length(seen), 1, 'one entitlement');
  perform t_eq(seen -> 0 ->> 'active', 'true', 'and it is mine and active');

  -- The table itself is readable, but RLS narrows it to one row.
  select count(*)::int into n from tollgate.entitlements;
  perform t_eq(n, 1, 'RLS hides everybody else');

  reset role;
  perform t_ok('a user reads their own entitlements, and only their own');
end
$$;

-- --- a user cannot write their own entitlements -----------------------------
do $$
declare
  me uuid := t_user('33333333-3333-4333-8333-000000000004');
  denied boolean := false;
begin
  perform tollgate.record_purchase(me, t_purchase(
    p_txn => 'sd1', p_original => 'sd',
    p_status => 'expired', p_will_renew => false,
    p_expires => now() - interval '90 days'
  ));

  perform set_config('tollgate.test_uid', me::text, true);
  set local role authenticated;
  begin
    update tollgate.entitlements set active = true, expires_at = now() + interval '99 years'
    where user_id = me;
  exception when insufficient_privilege then
    denied := true;
  end;
  reset role;

  perform t_assert(denied, 'select only, or the entitlement is worth nothing');
  perform t_assert(
    not tollgate.has_entitlement(me, 'premium'),
    'and the entitlement is still off'
  );
  perform t_ok('a user cannot write their own entitlements');
end
$$;

-- --- my_customer mints and returns only the caller's own token --------------
do $$
declare
  me uuid := t_user('33333333-3333-4333-8333-000000000005');
  info jsonb;
begin
  perform set_config('tollgate.test_uid', me::text, true);
  set local role authenticated;
  info := tollgate.my_customer();
  reset role;

  perform t_eq((info ->> 'userId')::uuid, me, 'it is me');
  perform t_assert(info ->> 'appAccountToken' is not null, 'and I have a token to attach');
  perform t_ok('my_customer mints and returns only the callers own token');
end
$$;

-- --- a hook that does not exist is refused at configuration time ------------
do $$
declare
  denied boolean := false;
begin
  begin
    update tollgate.config set grant_hook = 'no_such_function';
  exception when others then
    denied := true;
  end;
  perform t_assert(denied, 'a typo must fail here, not in the middle of a payment');

  denied := false;
  begin
    -- Right name, wrong signature.
    update tollgate.config set revoke_hook = 'app_credit_gems';
  exception when others then
    denied := true;
  end;
  perform t_assert(denied, 'the signature is part of the contract');

  -- Stored schema-qualified, whatever was written. The call sites run with an
  -- empty search_path and could not resolve a bare name.
  perform t_eq(
    (select revoke_hook from tollgate.config where id), 'public.app_debit_gems',
    'and the working configuration survived, qualified'
  );
  perform t_eq(
    (select grant_hook from tollgate.config where id), 'public.app_credit_gems',
    'as did the grant hook'
  );
  perform t_ok('a hook that does not exist is refused at configuration time');
end
$$;

-- --- a hook may use its own unqualified tables ------------------------------
do $$
declare
  u uuid := t_user('33333333-3333-4333-8333-000000000006');
  r jsonb;
begin
  -- app_credit_gems says `insert into app_wallet`, with no schema on it, which
  -- is what anybody would write. It is called from a function whose
  -- search_path is empty, so this only works because the pack restores one
  -- around the call.
  r := tollgate.record_purchase(u, t_purchase(
    p_txn => 'se1', p_original => 'se',
    p_sku => 'sku.gems.medium', p_kind => 'consumable'
  ));
  perform t_eq(r ->> 'granted', 'true', 'the hook found its own tables');

  -- And the pack's own empty search_path is back afterwards, so nothing that
  -- runs later in this transaction inherits the hook's.
  perform t_eq(current_setting('search_path'), '"$user", public', 'caller path untouched');
  perform t_ok('a hook may use its own unqualified tables');
end
$$;

-- --- product shape constraints ----------------------------------------------
do $$
declare
  denied boolean := false;
begin
  begin
    insert into tollgate.products (id, kind, entitlement_key)
    values ('bad_consumable', 'consumable', 'premium');
  exception when check_violation then
    denied := true;
  end;
  perform t_assert(denied, 'a consumable cannot unlock an entitlement');

  denied := false;
  begin
    insert into tollgate.products (id, kind, grant_payload)
    values ('bad_sub', 'subscription', '{"gems": 1}'::jsonb);
  exception when check_violation then
    denied := true;
  end;
  perform t_assert(denied, 'and a subscription cannot deliver goods');

  denied := false;
  begin
    insert into tollgate.store_products (store, store_product_id, product_id)
    values ('fake', 'sku.premium.monthly', 'premium_monthly');
  exception when unique_violation then
    denied := true;
  end;
  perform t_assert(denied, 'one SKU maps to one product, nulls included');
  perform t_ok('product shape constraints hold');
end
$$;

\echo '  -- security: all passed'

-- --- nothing is reachable that should not be, enumerated -------------------
--
-- The audit rather than a spot check. Every earlier case names one function it
-- expects to be refused, which is exactly the check that passes while the
-- function added last week sits wide open. This one asks the database what is
-- actually reachable and compares it against the two that are meant to be.
--
-- It exists because that happened: `store_skus` and `grace_for` were added in
-- later migrations, after the pack's blanket revoke had already run, and were
-- world-executable from the moment they were created.
do $$
declare
  v_leaked text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'tollgate'
    and p.proname not in ('my_entitlements', 'my_customer')
    and (has_function_privilege('anon', p.oid, 'execute')
         or has_function_privilege('authenticated', p.oid, 'execute'));

  perform t_assert(
    v_leaked is null,
    'these tollgate functions are reachable by a client: ' ||
      coalesce(v_leaked, '')
  );

  -- And the two that are meant to be, still are. A revoke that took everything
  -- would pass the check above and break the app.
  perform t_assert(
    has_function_privilege('authenticated', 'tollgate.my_entitlements()', 'execute'),
    'a signed-in user must still be able to read their own entitlements'
  );
  perform t_assert(
    has_function_privilege('authenticated', 'tollgate.my_customer()', 'execute'),
    'and still be able to get the token it has to attach to a purchase'
  );

  perform t_ok('nothing is reachable that should not be');
end
$$;

-- --- the platform will not deny it for us --------------------------------
--
-- Recorded because it is worth knowing and easy to assume otherwise. The
-- obvious structural guard, telling Postgres to stop granting EXECUTE to
-- PUBLIC on new functions in this schema, reports success on Supabase and does
-- nothing. If this test ever starts failing, the platform has been fixed and
-- the note in 0002 can go.
do $$
declare
  v_open boolean;
begin
  alter default privileges in schema tollgate
    revoke execute on functions from public;

  create function tollgate.pretend_new_function()
  returns int language sql immutable as $fn$ select 1 $fn$;

  select has_function_privilege('anon', 'tollgate.pretend_new_function()', 'execute')
    into v_open;

  drop function tollgate.pretend_new_function();

  perform t_assert(
    v_open,
    'alter default privileges now works; drop the warning in 0002 and rely on it'
  );
  perform t_ok('the platform will not deny it for us, so the audit above is the guard');
end
$$;
