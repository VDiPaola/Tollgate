-- Tollgate: functions.
--
-- This file is the authoritative implementation of entitlement derivation.
-- Core's TypeScript has an in-memory copy for fast tests, and where the two
-- disagree, this one is right.
--
-- Everything is security definer with an empty search_path, so every name is
-- schema-qualified. Postgres grants EXECUTE to PUBLIC by default, so every
-- function is explicitly revoked at the bottom of the file and granted back to
-- exactly who should have it.

-- ---------------------------------------------------------------------------
-- The two rules, in one place each.
-- ---------------------------------------------------------------------------

-- Whether the store's own account of a purchase says it should entitle,
-- ignoring the clock entirely. `canceled` counts because a cancelled
-- subscription is still paid for; what ends it is the expiry.
create function tollgate.eligible(p_status text, p_revoked_at timestamptz)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_revoked_at is null
     and p_status in ('active', 'grace', 'canceled');
$$;

-- Eligibility and the clock together, with the configured slack applied.
--
-- The slack is for SILENCE, not an override. It covers the gap between a
-- renewal being charged and anybody being told about it. A store that actually
-- reports the subscription as expired, on hold or revoked ends it immediately,
-- because those statuses fail `eligible` before the window is ever consulted.
create function tollgate.entitles(
  p_status text,
  p_revoked_at timestamptz,
  p_expires_at timestamptz,
  p_grace_days int
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select tollgate.eligible(p_status, p_revoked_at)
     and (
       p_expires_at is null
       or p_expires_at > now() - make_interval(days => p_grace_days)
     );
$$;

-- ---------------------------------------------------------------------------
-- Calling out to the host app.
--
-- The hooks are the one place this pack runs somebody else's code. Two things
-- have to be true at the call site: the name must be schema-qualified, because
-- these functions have no search_path to resolve it with (validate_hooks
-- rewrites it to a qualified name when it is configured), and the hook itself
-- must be able to see its own tables, which means restoring a search_path for
-- the duration of the call.
--
-- Restoring is `set_config(..., true)`, so it lasts to the end of the
-- transaction rather than leaking into the connection, and it is put back
-- immediately afterwards. If the hook raises, the transaction is rolled back
-- and there is nothing left to put back.
-- ---------------------------------------------------------------------------
create function tollgate.run_grant_hook(
  p_hook text,
  p_user uuid,
  p_product text,
  p_payload jsonb,
  p_purchase uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved text := current_setting('search_path');
  v_path text;
  v_result jsonb;
begin
  select hook_search_path into v_path from tollgate.config where id;
  perform set_config('search_path', v_path, true);
  -- p_hook was rewritten to a schema-qualified name by validate_hooks, and
  -- checked against this exact signature, so this is not an arbitrary string.
  execute format('select %s($1, $2, $3, $4)', p_hook)
    into v_result
    using p_user, p_product, p_payload, p_purchase;
  perform set_config('search_path', v_saved, true);
  return v_result;
end;
$$;

create function tollgate.run_revoke_hook(
  p_hook text,
  p_user uuid,
  p_product text,
  p_payload jsonb,
  p_purchase uuid,
  p_clawback text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved text := current_setting('search_path');
  v_path text;
  v_result jsonb;
begin
  select hook_search_path into v_path from tollgate.config where id;
  perform set_config('search_path', v_path, true);
  execute format('select %s($1, $2, $3, $4, $5)', p_hook)
    into v_result
    using p_user, p_product, p_payload, p_purchase, p_clawback;
  perform set_config('search_path', v_saved, true);
  return v_result;
end;
$$;

create function tollgate.grace_days()
returns int
language sql
stable
set search_path = ''
as $$
  select grace_days from tollgate.config where id;
$$;

-- How much slack an entitlement gets past its expiry.
--
-- The window exists to cover the gap between a renewal being charged and
-- anybody being told about it, and a flat number of days is the wrong shape for
-- that. It has to be small enough not to outlast the thing it is covering: a
-- subscription that bills weekly and gets three days of slack is being given
-- most of a period for free, and one that bills every five minutes, as a store
-- test subscription does, is served for days after it ended.
--
-- So it is capped at one billing period. Nothing gets more grace than the
-- length of the thing it is waiting on, and a monthly subscription still gets
-- the full configured window.
create function tollgate.grace_for(
  p_period_start timestamptz,
  p_expires_at timestamptz
)
returns interval
language sql
stable
set search_path = ''
as $$
  select case
    when p_period_start is null or p_expires_at is null
      then make_interval(days => tollgate.grace_days())
    else least(
      make_interval(days => tollgate.grace_days()),
      greatest(p_expires_at - p_period_start, interval '0')
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- Customers and identity
-- ---------------------------------------------------------------------------

create function tollgate.ensure_customer(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v tollgate.customers%rowtype;
begin
  insert into tollgate.customers (user_id) values (p_user)
  on conflict (user_id) do nothing;

  select * into v from tollgate.customers where user_id = p_user;

  return jsonb_build_object(
    'userId', v.user_id,
    'appAccountToken', v.app_account_token,
    'flaggedAt', v.flagged_at,
    'flagReason', v.flag_reason,
    'entitlements', tollgate.get_entitlements(p_user)
  );
end;
$$;

-- Remember that a store-side identifier belongs to a user. Called on every
-- successful verification, because the next thing that happens is a renewal
-- notification a year later carrying that identifier and nothing else.
create function tollgate.link_alias(p_user uuid, p_store text, p_alias text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into tollgate.customer_aliases (store, alias, user_id)
  values (p_store, p_alias, p_user)
  on conflict (store, alias) do update set user_id = excluded.user_id;
end;
$$;

create function tollgate.user_for_alias(p_store text, p_alias text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select user_id from tollgate.customer_aliases
  where store = p_store and alias = p_alias;
$$;

-- The fallback when no alias is stored yet, which is the case for the very
-- first notification about a brand new purchase. That notification can easily
-- beat the client's own verify call.
create function tollgate.user_for_token(p_token uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select user_id from tollgate.customers where app_account_token = p_token;
$$;

create function tollgate.flag_customer(
  p_user uuid,
  p_reason text,
  p_detail text default null,
  p_purchase uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into tollgate.customer_flags (user_id, purchase_id, reason, detail)
  values (p_user, p_purchase, p_reason, p_detail);

  update tollgate.customers
  set flagged_at = now(), flag_reason = p_reason
  where user_id = p_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- Derivation
-- ---------------------------------------------------------------------------

-- Rebuild every entitlement this customer has ever touched, from their
-- purchases.
--
-- The winner per entitlement is whatever keeps them entitled longest. An
-- entitling purchase always outranks a non-entitling one, so an old expired
-- row can never shadow a fresh subscription bought on a different store, which
-- is the situation a customer who switched from web to mobile is in.
create function tollgate.recompute_entitlements(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grace int := tollgate.grace_days();
begin
  insert into tollgate.entitlements as e (
    user_id, key, active, store, product_id, purchase_id,
    period_start, expires_at, will_renew, in_grace_period,
    unsubscribe_detected_at, billing_issue_detected_at, updated_at
  )
  select
    p_user,
    b.key,
    -- Store eligibility only. The clock is applied on read; see the note on
    -- tollgate.entitlements.active.
    b.is_eligible,
    b.store,
    b.product_id,
    b.id,
    b.purchased_at,
    b.expires_at,
    b.will_renew,
    b.status = 'grace',
    case when b.status = 'canceled' or not b.will_renew then now() end,
    case when b.status in ('grace', 'on_hold') then now() end,
    now()
  from (
    select distinct on (pr.entitlement_key)
      pd.id,
      pd.store,
      pd.product_id,
      pd.status,
      pd.purchased_at,
      pd.expires_at,
      pd.will_renew,
      pr.entitlement_key as key,
      tollgate.eligible(pd.status, pd.revoked_at) as is_eligible
    from tollgate.purchases pd
    join tollgate.products pr on pr.id = pd.product_id
    where pd.user_id = p_user
      and pr.entitlement_key is not null
    order by
      pr.entitlement_key,
      tollgate.entitles(pd.status, pd.revoked_at, pd.expires_at, v_grace) desc,
      coalesce(pd.expires_at, 'infinity'::timestamptz) desc,
      pd.purchased_at desc
  ) b
  on conflict (user_id, key) do update set
    active = excluded.active,
    store = excluded.store,
    product_id = excluded.product_id,
    purchase_id = excluded.purchase_id,
    period_start = excluded.period_start,
    expires_at = excluded.expires_at,
    will_renew = excluded.will_renew,
    in_grace_period = excluded.in_grace_period,
    -- Sticky while the condition holds, cleared when it stops. "How long has
    -- this been true" is what a win-back prompt needs, and overwriting the
    -- timestamp on every recompute would always answer "since just now".
    unsubscribe_detected_at = case
      when excluded.unsubscribe_detected_at is null then null
      else coalesce(e.unsubscribe_detected_at, excluded.unsubscribe_detected_at)
    end,
    billing_issue_detected_at = case
      when excluded.billing_issue_detected_at is null then null
      else coalesce(e.billing_issue_detected_at, excluded.billing_issue_detected_at)
    end,
    updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- The customer's entitlements with `active` evaluated against the clock right
-- now, rather than against whenever they were last written.
create function tollgate.get_entitlements(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', e.key,
        'active', e.active and (
          e.expires_at is null
          or e.expires_at >
             now() - tollgate.grace_for(e.period_start, e.expires_at)
        ),
        'store', e.store,
        'productId', e.product_id,
        'periodStart', e.period_start,
        'expiresAt', e.expires_at,
        'willRenew', e.will_renew,
        'inGracePeriod', e.in_grace_period,
        'unsubscribeDetectedAt', e.unsubscribe_detected_at,
        'billingIssueDetectedAt', e.billing_issue_detected_at
      )
      order by e.key
    ),
    '[]'::jsonb
  )
  from tollgate.entitlements e
  where e.user_id = p_user;
$$;

-- The one a host app's own plan logic should call.
create function tollgate.has_entitlement(p_user uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from tollgate.entitlements e
    where e.user_id = p_user
      and e.key = p_key
      and e.active
      and (
        e.expires_at is null
        or e.expires_at > now() - tollgate.grace_for(e.period_start, e.expires_at)
      )
  );
$$;

-- Every purchase a store could still change its mind about. The restore and
-- repair pass walks these. Consumables are excluded: once delivered there is
-- nothing left to change except a refund, which arrives as a notification.
create function tollgate.live_purchases(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(r), '[]'::jsonb)
  from (
    select distinct on (pd.store, pd.original_transaction_id)
      jsonb_build_object(
        'store', pd.store,
        'originalTransactionId', pd.original_transaction_id,
        'storeTransactionId', pd.store_transaction_id,
        'storeProductId', pd.store_product_id,
        'basePlanId', pd.base_plan_id,
        -- Carried because a store may need it to know which endpoint to
        -- answer from: Google splits subscriptions and one-time products
        -- across two resources with different URL shapes.
        'kind', pd.kind
      ) as r
    from tollgate.purchases pd
    where pd.user_id = p_user
      and pd.kind <> 'consumable'
      and pd.revoked_at is null
    order by pd.store, pd.original_transaction_id, pd.purchased_at desc
  ) s;
$$;

-- What a store SKU means to this app. The one place the mapping rule lives, so
-- the answer a quote gets and the answer a purchase gets cannot differ.
--
-- Base plans are Google's, and they are the trap here. A store_products row
-- naming a base plan matches only that plan; a row leaving it null is a
-- catch-all for every plan of that SKU. An exact match always wins, so a
-- product that enumerates its plans is never shadowed by a catch-all sitting
-- alongside it. Without the catch-all, a Google subscription bought on a plan
-- nobody had configured would map to nothing and grant nothing, which is a
-- paid-for subscription that does not work.
create function tollgate.map_sku(
  p_store text,
  p_store_product_id text,
  p_base_plan_id text default null
)
returns table (
  product_id text,
  kind text,
  entitlement_key text,
  grant_payload jsonb,
  base_plan_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  select pr.id, pr.kind, pr.entitlement_key, pr.grant_payload, sp.base_plan_id
  from tollgate.store_products sp
  join tollgate.products pr on pr.id = sp.product_id
  where sp.store = p_store
    and sp.store_product_id = p_store_product_id
    and (sp.base_plan_id is null or sp.base_plan_id = p_base_plan_id)
  order by (sp.base_plan_id is not null) desc
  limit 1;
$$;

create function tollgate.product_for(
  p_store text,
  p_store_product_id text,
  p_base_plan_id text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'productId', m.product_id,
    'kind', m.kind,
    'entitlementKey', m.entitlement_key,
    'grantPayload', m.grant_payload,
    'store', p_store,
    'storeProductId', p_store_product_id,
    'basePlanId', m.base_plan_id
  )
  from tollgate.map_sku(p_store, p_store_product_id, p_base_plan_id) m;
$$;

-- Which SKU each product is sold under, in one store.
--
-- The reverse of product_for, and the direction a client needs: an app knows it
-- wants to sell `premium_monthly` and has to ask a store for a SKU it has never
-- heard of. Without this the store ids would have to be compiled into the app,
-- where changing one means shipping a release.
create function tollgate.store_skus(p_store text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r ->> 'productId'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'productId', pr.id,
      'kind', pr.kind,
      'entitlementKey', pr.entitlement_key,
      'storeProductId', sp.store_product_id,
      'basePlanId', sp.base_plan_id
    ) as r
    from tollgate.store_products sp
    join tollgate.products pr on pr.id = sp.product_id
    where sp.store = p_store
      and pr.enabled
  ) s;
$$;

create function tollgate.get_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'grantHook', grant_hook,
    'revokeHook', revoke_hook,
    'clawback', clawback,
    'graceDays', grace_days
  )
  from tollgate.config where id;
$$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Write a purchase, recompute the customer's entitlements, and deliver a
-- consumable if this is the first time it has settled. One transaction, on
-- purpose: splitting "record it" from "deliver it" is how a consumable gets
-- paid for and never handed over.
create function tollgate.record_purchase(p_user uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_map record;
  v_row tollgate.purchases%rowtype;
  v_prior uuid;
  v_hook text;
  v_granted boolean := false;
  v_grant_result jsonb;
begin
  perform tollgate.ensure_customer(p_user);

  select * into v_map
  from tollgate.map_sku(
    p ->> 'store',
    p ->> 'storeProductId',
    nullif(p ->> 'basePlanId', '')
  );

  select id into v_prior
  from tollgate.purchases
  where store = p ->> 'store'
    and store_transaction_id = p ->> 'storeTransactionId';

  insert into tollgate.purchases as t (
    user_id, store, store_transaction_id, original_transaction_id,
    store_product_id, base_plan_id, product_id, kind, status, environment,
    offer_type, quantity, purchased_at, expires_at, will_renew, revoked_at,
    price_amount_micros, price_currency, raw
  )
  values (
    p_user,
    p ->> 'store',
    p ->> 'storeTransactionId',
    p ->> 'originalTransactionId',
    p ->> 'storeProductId',
    nullif(p ->> 'basePlanId', ''),
    v_map.product_id,
    coalesce(v_map.kind, p ->> 'kind'),
    p ->> 'status',
    coalesce(p ->> 'environment', 'production'),
    coalesce(p ->> 'offerType', 'none'),
    coalesce((p ->> 'quantity')::int, 1),
    (p ->> 'purchasedAt')::timestamptz,
    (p ->> 'expiresAt')::timestamptz,
    coalesce((p ->> 'willRenew')::boolean, false),
    (p ->> 'revokedAt')::timestamptz,
    (p ->> 'priceAmountMicros')::bigint,
    p ->> 'priceCurrency',
    p -> 'raw'
  )
  on conflict (store, store_transaction_id) do update set
    -- Deliberately absent from this list: user_id and granted_at. Re-recording
    -- a transaction must not move it to a different customer, and must not
    -- forget that it was already delivered.
    original_transaction_id = excluded.original_transaction_id,
    store_product_id = excluded.store_product_id,
    base_plan_id = excluded.base_plan_id,
    product_id = excluded.product_id,
    kind = excluded.kind,
    status = excluded.status,
    environment = excluded.environment,
    offer_type = excluded.offer_type,
    quantity = excluded.quantity,
    purchased_at = excluded.purchased_at,
    expires_at = excluded.expires_at,
    will_renew = excluded.will_renew,
    revoked_at = excluded.revoked_at,
    price_amount_micros = excluded.price_amount_micros,
    price_currency = excluded.price_currency,
    raw = excluded.raw
  returning t.* into v_row;

  -- Exactly-once delivery. The stamp is what gates this, not whether the row
  -- was new, so a store redelivering the same transaction pays out nothing.
  if v_map.kind = 'consumable'
     and v_row.granted_at is null
     and v_row.status = 'active'
     and v_row.revoked_at is null then

    select grant_hook into v_hook from tollgate.config where id;
    if v_hook is not null then
      v_grant_result := tollgate.run_grant_hook(
        v_hook, p_user, v_map.product_id, v_map.grant_payload, v_row.id
      );
    end if;

    update tollgate.purchases set granted_at = now() where id = v_row.id;
    v_granted := true;
  end if;

  perform tollgate.recompute_entitlements(p_user);

  return jsonb_build_object(
    'created', v_prior is null,
    'purchaseId', v_row.id,
    'productId', v_map.product_id,
    -- Whether the goods are delivered for this purchase, by anybody.
    --
    -- This is the question a caller actually has, and `granted` is not it:
    -- that says only whether THIS call ran the hook. A store notification
    -- routinely arrives a couple of hundred milliseconds before the device
    -- that made the purchase, does the delivering, and leaves the device's own
    -- call reporting `granted: false` for goods that were very much handed
    -- over. Reporting that to a buyer reads as nothing having happened.
    'delivered', v_granted or v_row.granted_at is not null,
    -- The catalogue's kind, which the caller needs because a store may not
    -- know it. Google cannot tell a consumable from a non-consumable, and the
    -- difference decides whether it is told to consume or only to acknowledge.
    'kind', v_map.kind,
    'granted', v_granted,
    'grantResult', v_grant_result,
    'entitlements', tollgate.get_entitlements(p_user)
  );
end;
$$;

-- Mark a purchase as pulled back by the store, flag the customer, run the
-- revoke hook, and recompute. One transaction, for the same reason as
-- record_purchase.
--
-- With p_txn null this revokes every transaction under the original id, which
-- is what "the subscription was refunded" means. With p_txn set it revokes
-- exactly that one, which is what Apple's per-transaction refunds mean.
create function tollgate.revoke_purchase(
  p_store text,
  p_original text,
  p_txn text default null,
  p_reason text default 'store_revoked',
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_user uuid;
  v_hook text;
  v_clawback text;
  v_found boolean := false;
  v_clawed boolean := false;
  v_result jsonb;
begin
  select revoke_hook, clawback into v_hook, v_clawback
  from tollgate.config where id;

  for v_row in
    select pd.*, pr.kind as product_kind, pr.grant_payload
    from tollgate.purchases pd
    left join tollgate.products pr on pr.id = pd.product_id
    where pd.store = p_store
      and (
        (p_txn is not null and pd.store_transaction_id = p_txn)
        or (p_txn is null and pd.original_transaction_id = p_original)
      )
  loop
    v_found := true;
    v_user := v_row.user_id;

    update tollgate.purchases
    set status = 'revoked',
        revoked_at = coalesce(revoked_at, now()),
        will_renew = false
    where id = v_row.id;

    perform tollgate.flag_customer(v_user, p_reason, p_detail, v_row.id);

    -- Only a consumable that was actually handed over can be clawed back.
    -- Revoking a subscription needs no hook: the entitlement recompute below
    -- takes the access away by itself.
    if v_row.product_kind = 'consumable'
       and v_row.granted_at is not null
       and v_hook is not null then
      v_result := tollgate.run_revoke_hook(
        v_hook, v_user, v_row.product_id, v_row.grant_payload,
        v_row.id, v_clawback
      );
      v_clawed := true;
    end if;
  end loop;

  if v_user is not null then
    perform tollgate.recompute_entitlements(v_user);
  end if;

  return jsonb_build_object(
    'found', v_found,
    'clawedBack', v_clawed,
    'clawbackResult', v_result,
    'entitlements',
      case when v_user is null then '[]'::jsonb
           else tollgate.get_entitlements(v_user) end
  );
end;
$$;

-- Returns false when this event id has been seen before, which is the caller's
-- cue to stop and answer 200 without doing the work twice.
create function tollgate.record_event(
  p_store text,
  p_event_id text,
  p_type text,
  p_user uuid default null,
  p_payload jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into tollgate.events (store, store_event_id, event_type, user_id, payload)
  values (p_store, p_event_id, p_type, p_user, p_payload)
  on conflict (store, store_event_id) do nothing;
  return found;
end;
$$;

create function tollgate.finish_event(
  p_store text,
  p_event_id text,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update tollgate.events
  set processed_at = now(), error = p_error
  where store = p_store and store_event_id = p_event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The client-facing pair. Everything else is for the server.
-- ---------------------------------------------------------------------------

create function tollgate.my_entitlements()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select tollgate.get_entitlements((select auth.uid()));
$$;

-- The client needs its own app account token: it has to attach it to every
-- store purchase, and without it a renewal notification cannot be traced back
-- to anybody. It is an opaque per-account identifier, not a credential.
create function tollgate.my_customer()
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select tollgate.ensure_customer((select auth.uid()));
$$;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- Postgres gives EXECUTE on new functions to PUBLIC, so every one of these has
-- to be taken away explicitly. Missing one would let any signed-in client call
-- record_purchase and grant itself whatever it liked.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A note for whoever adds the next function here.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, so every function in
-- this schema is explicitly revoked at the end of 0002. That revoke runs once,
-- at installation. A function added in a later migration does not get it, and
-- is world-executable from the moment it is created, silently.
--
-- The obvious guard does not work: `alter default privileges in schema tollgate
-- revoke execute on functions from public` reports success on Supabase and has
-- no effect, in any schema and in either the plain or the `for role` form. It
-- records nothing in pg_default_acl. Do not add it back believing it helps.
--
-- What actually guards this is a test. `40_security.sql` asks the database
-- which functions in this schema an anon or authenticated caller can execute,
-- and fails unless the answer is exactly the two `my_*` readers. Adding a
-- function without revoking it breaks the suite, which is the only mechanism
-- here that has ever caught it.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema tollgate from public;

grant execute on all functions in schema tollgate to service_role;

grant execute on function tollgate.my_entitlements() to authenticated;
grant execute on function tollgate.my_customer() to authenticated;
