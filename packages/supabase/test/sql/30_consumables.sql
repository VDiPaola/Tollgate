-- Consumables and the grant hook.
--
-- Mirrors packages/core/test/consumable_test.ts. Exactly-once delivery is the
-- property being pinned down: a double grant hands out free goods, a missed one
-- takes money for nothing, and both are one redelivery away.

\set ON_ERROR_STOP on

-- --- buying a consumable runs the hook once and delivers --------------------
do $$
declare
  u uuid := t_user('22222222-2222-4222-8222-000000000001');
  r jsonb;
begin
  r := tollgate.record_purchase(u, t_purchase(
    p_txn => 'ca1', p_original => 'ca',
    p_sku => 'sku.gems.medium', p_kind => 'consumable'
  ));
  perform t_eq(r ->> 'granted', 'true', 'it was delivered');
  perform t_eq(r -> 'grantResult' ->> 'balance', '500', 'the hook returned the balance');
  perform t_eq(r -> 'entitlements', '[]'::jsonb, 'a gem pack unlocks nothing');
  perform t_eq(
    (select gems from app_wallet where user_id = u), 500, 'the wallet has the gems'
  );
  perform t_ok('buying a consumable runs the hook once and delivers');
end
$$;

-- --- recording the same transaction twice pays out once ---------------------
do $$
declare
  u uuid := t_user('22222222-2222-4222-8222-000000000002');
  r jsonb;
begin
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'cb1', p_original => 'cb',
    p_sku => 'sku.gems.medium', p_kind => 'consumable'
  ));
  -- A client that lost the response and retried, or a webhook racing it.
  r := tollgate.record_purchase(u, t_purchase(
    p_txn => 'cb1', p_original => 'cb',
    p_sku => 'sku.gems.medium', p_kind => 'consumable'
  ));

  perform t_eq(r ->> 'granted', 'false', 'the second call delivers nothing');
  perform t_eq(r ->> 'created', 'false', 'and knows it is a repeat');
  perform t_eq((select gems from app_wallet where user_id = u), 500, 'paid once');
  perform t_eq(
    (select count(*)::int from app_wallet_ledger where user_id = u),
    1, 'and the ledger says so once'
  );
  perform t_ok('recording the same transaction twice pays out once');
end
$$;

-- --- a consumable is not delivered until the payment settles ----------------
do $$
declare
  u uuid := t_user('22222222-2222-4222-8222-000000000003');
  r jsonb;
begin
  -- Google's deferred purchases sit pending for days before the money arrives.
  r := tollgate.record_purchase(u, t_purchase(
    p_txn => 'cc1', p_original => 'cc',
    p_sku => 'sku.gems.medium', p_kind => 'consumable', p_status => 'pending'
  ));
  perform t_eq(r ->> 'granted', 'false', 'nothing is owed until the money arrives');
  perform t_assert(
    (select gems from app_wallet where user_id = u) is null, 'no wallet yet'
  );

  r := tollgate.record_purchase(u, t_purchase(
    p_txn => 'cc1', p_original => 'cc',
    p_sku => 'sku.gems.medium', p_kind => 'consumable', p_status => 'active'
  ));
  perform t_eq(r ->> 'granted', 'true', 'and delivered once it does');
  perform t_eq((select gems from app_wallet where user_id = u), 500, 'in full');
  perform t_ok('a consumable is not delivered until the payment settles');
end
$$;

-- --- a refund claws the gems back, into the negative if it has to -----------
do $$
declare
  u uuid := t_user('22222222-2222-4222-8222-000000000004');
  r jsonb;
begin
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'cd1', p_original => 'cd',
    p_sku => 'sku.gems.medium', p_kind => 'consumable'
  ));
  -- Spent before the refund landed, which is the whole problem.
  update app_wallet set gems = gems - 400 where user_id = u;

  r := tollgate.revoke_purchase('fake', 'cd', null, 'refund', 'chargeback in test');
  perform t_eq(r ->> 'clawedBack', 'true', 'the hook ran');
  perform t_eq(
    (select gems from app_wallet where user_id = u), -400,
    'the debt is real and is recorded as such'
  );
  perform t_eq(
    (select count(*)::int from app_wallet_ledger where user_id = u), 2,
    'both movements are in the ledger'
  );
  perform t_assert(
    (select flagged_at from tollgate.customers where user_id = u) is not null,
    'and the customer is flagged'
  );
  perform t_ok('a refund claws the gems back, into the negative if it has to');
end
$$;

-- --- the keep policy reports the refund and leaves the balance alone --------
do $$
declare
  u uuid := t_user('22222222-2222-4222-8222-000000000005');
  r jsonb;
begin
  update tollgate.config set clawback = 'keep';

  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'ce1', p_original => 'ce',
    p_sku => 'sku.gems.medium', p_kind => 'consumable'
  ));
  update app_wallet set gems = gems - 400 where user_id = u;

  r := tollgate.revoke_purchase('fake', 'ce', null, 'refund', null);
  perform t_eq(r -> 'clawbackResult' ->> 'kept', 'true', 'the hook was told to keep');
  perform t_eq(
    (select gems from app_wallet where user_id = u), 100, 'absorbed, not clawed back'
  );
  perform t_assert(
    (select flagged_at from tollgate.customers where user_id = u) is not null,
    'flagged either way, which is the point of flagging'
  );

  update tollgate.config set clawback = 'revoke';
  perform t_ok('the keep policy reports the refund and leaves the balance alone');
end
$$;

-- --- an undelivered consumable is not clawed back ---------------------------
do $$
declare
  u uuid := t_user('22222222-2222-4222-8222-000000000006');
  r jsonb;
begin
  -- Never settled, so never delivered.
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'cf1', p_original => 'cf',
    p_sku => 'sku.gems.medium', p_kind => 'consumable', p_status => 'pending'
  ));

  r := tollgate.revoke_purchase('fake', 'cf', null, 'refund', null);
  perform t_eq(r ->> 'found', 'true', 'the purchase exists');
  perform t_eq(r ->> 'clawedBack', 'false', 'but there is nothing to take back');
  perform t_assert(
    (select gems from app_wallet where user_id = u) is null,
    'and no wallet was touched'
  );
  perform t_ok('an undelivered consumable is not clawed back');
end
$$;

-- --- a revoked consumable is not re-delivered by a later record -------------
do $$
declare
  u uuid := t_user('22222222-2222-4222-8222-000000000007');
  r jsonb;
begin
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'cg1', p_original => 'cg',
    p_sku => 'sku.gems.medium', p_kind => 'consumable'
  ));
  perform tollgate.revoke_purchase('fake', 'cg', null, 'refund', null);

  -- A stale notification about the original purchase arrives afterwards.
  r := tollgate.record_purchase(u, t_purchase(
    p_txn => 'cg1', p_original => 'cg',
    p_sku => 'sku.gems.medium', p_kind => 'consumable'
  ));
  perform t_eq(r ->> 'granted', 'false', 'the delivered stamp survives the refund');
  perform t_eq(
    (select gems from app_wallet where user_id = u), 0,
    'so the refunded gems are not handed back out'
  );
  perform t_ok('a revoked consumable is not re-delivered by a later record');
end
$$;

-- --- events are deduplicated ------------------------------------------------
do $$
begin
  perform t_eq(
    tollgate.record_event('fake', 'evt_1', 'PURCHASED', null, '{}'::jsonb),
    true, 'a new event is recorded'
  );
  perform t_eq(
    tollgate.record_event('fake', 'evt_1', 'PURCHASED', null, '{}'::jsonb),
    false, 'and a redelivery is recognised'
  );
  perform tollgate.finish_event('fake', 'evt_1', null);
  perform t_assert(
    (select processed_at from tollgate.events
     where store = 'fake' and store_event_id = 'evt_1') is not null,
    'finishing it is recorded'
  );
  -- Two stores can legitimately use the same event id.
  perform t_eq(
    tollgate.record_event('google', 'evt_1', 'PURCHASED', null, '{}'::jsonb),
    true, 'event ids are scoped to their store'
  );
  perform t_ok('events are deduplicated');
end
$$;

\echo '  -- consumables: all passed'
