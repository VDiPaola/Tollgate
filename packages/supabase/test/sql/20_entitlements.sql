-- Entitlement derivation, against real Postgres.
--
-- These are the same scenarios as packages/core/test/subscription_test.ts. The
-- two implementations are expected to agree, and this one is authoritative.
--
-- Time is expressed as explicit expiry timestamps rather than by moving a
-- clock, which is both simpler and closer to what a store actually sends.

\set ON_ERROR_STOP on

-- --- a fresh subscription grants its entitlement ----------------------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-000000000001');
  r jsonb;
  e jsonb;
begin
  r := tollgate.record_purchase(u, t_purchase(p_txn => 'a1', p_original => 'a'));
  perform t_eq(r ->> 'created', 'true', 'first record creates');
  perform t_eq(r ->> 'productId', 'premium_monthly', 'SKU maps to the product');

  e := tollgate.get_entitlements(u) -> 0;
  perform t_eq(e ->> 'key', 'premium', 'premium exists');
  perform t_eq(e ->> 'active', 'true', 'and is active');
  perform t_eq(e ->> 'willRenew', 'true', 'and will renew');
  perform t_assert(e ->> 'unsubscribeDetectedAt' is null, 'nothing to win back yet');
  perform t_assert(tollgate.has_entitlement(u, 'premium'), 'has_entitlement agrees');
  perform t_ok('a fresh subscription grants its entitlement');
end
$$;

-- --- cancelling keeps access until the period actually ends -----------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-000000000002');
  e jsonb;
begin
  perform tollgate.record_purchase(u, t_purchase(p_txn => 'b1', p_original => 'b'));

  -- The store now says: not renewing, but paid up for another three weeks.
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'b1', p_original => 'b',
    p_status => 'canceled', p_will_renew => false,
    p_expires => now() + interval '21 days'
  ));

  e := tollgate.get_entitlements(u) -> 0;
  perform t_eq(e ->> 'active', 'true', 'a cancelled subscription is still paid for');
  perform t_eq(e ->> 'willRenew', 'false', 'but it will not renew');
  perform t_assert(e ->> 'unsubscribeDetectedAt' is not null, 'the unsubscribe is dated');

  -- And once the paid time is gone, and the slack with it.
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'b1', p_original => 'b',
    p_status => 'canceled', p_will_renew => false,
    p_expires => now() - interval '5 days'
  ));
  perform t_assert(not tollgate.has_entitlement(u, 'premium'), 'access ends with the period');
  perform t_ok('cancelling keeps access until the period actually ends');
end
$$;

-- --- renewal: two transactions, one subscription ----------------------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-000000000003');
  e jsonb;
  n int;
begin
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'c1', p_original => 'c', p_expires => now() + interval '1 day'
  ));
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'c2', p_original => 'c', p_expires => now() + interval '31 days'
  ));

  select count(*) into n from tollgate.purchases where user_id = u;
  perform t_eq(n, 2, 'a renewal is a new transaction, not an overwrite');

  select count(distinct original_transaction_id) into n
  from tollgate.purchases where user_id = u;
  perform t_eq(n, 1, 'both belong to one subscription');

  e := tollgate.get_entitlements(u) -> 0;
  perform t_eq(e ->> 'active', 'true', 'still entitled');
  perform t_assert(
    (e ->> 'expiresAt')::timestamptz > now() + interval '30 days',
    'the winning purchase is the one that runs longest'
  );
  perform t_ok('renewal extends without losing the original');
end
$$;

-- --- grace keeps access, hold does not --------------------------------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-000000000004');
  e jsonb;
begin
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'd1', p_original => 'd', p_status => 'grace'
  ));
  e := tollgate.get_entitlements(u) -> 0;
  perform t_eq(e ->> 'active', 'true', 'grace means keep serving them');
  perform t_eq(e ->> 'inGracePeriod', 'true', 'and say so');
  perform t_assert(e ->> 'billingIssueDetectedAt' is not null, 'the billing issue is dated');

  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'd1', p_original => 'd', p_status => 'on_hold'
  ));
  perform t_assert(not tollgate.has_entitlement(u, 'premium'), 'on hold means stop');
  perform t_ok('grace keeps access, hold does not');
end
$$;

-- --- the grace window is slack for silence, not an override -----------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-000000000005');
begin
  -- A monthly subscription whose period ended yesterday, with nothing said
  -- since. Ordinary renewal lag, and it must not log a paying customer out.
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'e1', p_original => 'e',
    p_purchased => now() - interval '30 days',
    p_expires => now() - interval '1 day'
  ));
  perform t_assert(tollgate.has_entitlement(u, 'premium'), '3-day window absorbs lag');

  -- Five days of silence is no longer ordinary.
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'e1', p_original => 'e',
    p_purchased => now() - interval '35 days',
    p_expires => now() - interval '5 days'
  ));
  perform t_assert(not tollgate.has_entitlement(u, 'premium'), 'past the window it ends');

  -- Back inside the window, but this time the store has actually spoken.
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'e1', p_original => 'e',
    p_status => 'expired', p_will_renew => false,
    p_purchased => now() - interval '30 days',
    p_expires => now() - interval '1 day'
  ));
  perform t_assert(
    not tollgate.has_entitlement(u, 'premium'),
    'what the store says beats the window'
  );
  perform t_ok('the grace window is slack for silence, not an override');
end
$$;

-- --- the window never outlasts the period it is covering --------------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-00000000000f');
begin
  -- A store test subscription bills every few minutes. A flat three days of
  -- slack kept Premium switched on for hours after Google had marked it
  -- expired, while the store's own screen said there was no subscription.
  -- Forty minutes past a thirty minute period is more than a whole period
  -- late, so it is over however the window is measured.
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'n1', p_original => 'n',
    p_purchased => now() - interval '70 minutes',
    p_expires => now() - interval '40 minutes'
  ));
  perform t_assert(
    not tollgate.has_entitlement(u, 'premium'),
    'a period and a third past the end is not renewal lag'
  );

  -- One minute past the same period is still ordinary lag.
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'n1', p_original => 'n',
    p_purchased => now() - interval '31 minutes',
    p_expires => now() - interval '1 minute'
  ));
  perform t_assert(
    tollgate.has_entitlement(u, 'premium'),
    'but a minute is not'
  );

  -- And a monthly subscription still gets the full configured window.
  perform t_eq(
    tollgate.grace_for(now() - interval '30 days', now()),
    interval '3 days',
    'a long period is capped by the configured days, not by itself'
  );
  perform t_eq(
    tollgate.grace_for(now() - interval '30 minutes', now()),
    interval '30 minutes',
    'and a short one is capped by itself'
  );
  perform t_ok('the window never outlasts the period it is covering');
end
$$;

-- --- a refund pulls access immediately, whatever the expiry says ------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-000000000006');
  r jsonb;
  c record;
begin
  perform tollgate.record_purchase(u, t_purchase(p_txn => 'f1', p_original => 'f'));
  perform t_assert(tollgate.has_entitlement(u, 'premium'), 'entitled first');

  r := tollgate.revoke_purchase('fake', 'f', null, 'store_revoked', 'refunded in test');
  perform t_eq(r ->> 'found', 'true', 'the purchase was found');
  perform t_assert(not tollgate.has_entitlement(u, 'premium'), 'access stops at once');

  select flagged_at, flag_reason into c from tollgate.customers where user_id = u;
  perform t_assert(c.flagged_at is not null, 'the customer is flagged');
  perform t_eq(c.flag_reason, 'store_revoked', 'with the reason');
  perform t_eq(
    (select count(*)::int from tollgate.customer_flags where user_id = u),
    1, 'and the flag is kept as history'
  );
  perform t_ok('a refund pulls access immediately');
end
$$;

-- --- a lifetime purchase never expires --------------------------------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-000000000007');
  e jsonb;
begin
  perform tollgate.record_purchase(u, jsonb_build_object(
    'store', 'fake', 'storeTransactionId', 'g1', 'originalTransactionId', 'g',
    'storeProductId', 'sku.lifetime', 'kind', 'non_consumable',
    'status', 'active', 'environment', 'production', 'offerType', 'none',
    'quantity', 1, 'purchasedAt', now() - interval '400 days',
    'expiresAt', null, 'willRenew', false
  ));
  e := tollgate.get_entitlements(u) -> 0;
  perform t_eq(e ->> 'active', 'true', 'still entitled after a year');
  perform t_assert(e ->> 'expiresAt' is null, 'and has no expiry to check');
  perform t_ok('a lifetime purchase never expires');
end
$$;

-- --- an entitling purchase outranks an expired one on another store ---------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-000000000008');
  e jsonb;
begin
  -- Subscribed on the web a year ago, lapsed.
  perform tollgate.record_purchase(u, t_purchase(
    p_store => 'stripe', p_txn => 'h1', p_original => 'h',
    p_sku => 'price_premium_monthly', p_status => 'expired',
    p_will_renew => false, p_expires => now() - interval '300 days'
  ));
  -- Resubscribed on a phone today.
  perform tollgate.record_purchase(u, t_purchase(
    p_store => 'google', p_txn => 'h2', p_original => 'h2',
    p_sku => 'premium', p_status => 'active'
  ) || jsonb_build_object('basePlanId', 'monthly'));

  e := tollgate.get_entitlements(u) -> 0;
  perform t_eq(e ->> 'active', 'true', 'the live subscription wins');
  perform t_eq(e ->> 'store', 'google', 'and it is the one reported');
  perform t_ok('a live purchase outranks a lapsed one on another store');
end
$$;

-- --- base plans are part of the SKU key -------------------------------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-000000000009');
  r jsonb;
begin
  r := tollgate.record_purchase(u, t_purchase(
    p_store => 'google', p_txn => 'i1', p_original => 'i', p_sku => 'premium'
  ) || jsonb_build_object('basePlanId', 'annual'));
  perform t_eq(r ->> 'productId', 'premium_monthly', 'the annual base plan maps too');

  perform t_eq(
    tollgate.product_for('google', 'premium', 'annual') ->> 'productId',
    'premium_monthly', 'product_for agrees'
  );
  perform t_assert(
    tollgate.product_for('google', 'premium', 'weekly') is null,
    'a SKU that enumerates its plans maps only those plans'
  );

  -- The other configuration: one row with no base plan, catching every plan of
  -- the SKU. This is what stops a plan added in the Play console and forgotten
  -- about here from becoming a subscription somebody paid for that grants
  -- nothing.
  perform t_eq(
    tollgate.product_for('google', 'premium_plus', 'quarterly') ->> 'productId',
    'premium_monthly', 'a null base plan is a catch-all'
  );
  perform t_eq(
    tollgate.product_for('google', 'premium_plus', null) ->> 'productId',
    'premium_monthly', 'including for a purchase that names no plan'
  );
  perform t_ok('base plans map exactly, or through a catch-all');
end
$$;

-- --- an exact base plan beats a catch-all sitting next to it ----------------
do $$
begin
  insert into tollgate.products (id, kind, entitlement_key)
  values ('premium_annual', 'subscription', 'premium');
  insert into tollgate.store_products (store, store_product_id, base_plan_id, product_id)
  values ('google', 'premium_plus', 'annual', 'premium_annual');

  perform t_eq(
    tollgate.product_for('google', 'premium_plus', 'annual') ->> 'productId',
    'premium_annual', 'the specific row wins'
  );
  perform t_eq(
    tollgate.product_for('google', 'premium_plus', 'monthly') ->> 'productId',
    'premium_monthly', 'and everything else still falls through to the catch-all'
  );
  perform t_ok('an exact base plan beats a catch-all sitting next to it');
end
$$;

-- --- an unmapped SKU is recorded and grants nothing -------------------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-00000000000a');
  r jsonb;
begin
  r := tollgate.record_purchase(u, t_purchase(
    p_txn => 'j1', p_original => 'j', p_sku => 'sku.nobody.configured'
  ));
  perform t_assert(r ->> 'productId' is null, 'nothing was mapped');
  perform t_eq(r -> 'entitlements', '[]'::jsonb, 'and nothing was granted');
  perform t_eq(
    (select count(*)::int from tollgate.purchases where user_id = u),
    1,
    'but the payment we took is on record, because that cannot be fixed later'
  );
  perform t_ok('an unmapped SKU is recorded and grants nothing');
end
$$;

-- --- re-recording never moves a purchase to another customer ----------------
do $$
declare
  u1 uuid := t_user('11111111-1111-4111-8111-00000000000b');
  u2 uuid := t_user('11111111-1111-4111-8111-00000000000c');
begin
  perform tollgate.record_purchase(u1, t_purchase(p_txn => 'k1', p_original => 'k'));
  perform tollgate.record_purchase(u2, t_purchase(p_txn => 'k1', p_original => 'k'));

  perform t_eq(
    (select user_id from tollgate.purchases
     where store = 'fake' and store_transaction_id = 'k1'),
    u1,
    'the first owner keeps it'
  );
  perform t_assert(not tollgate.has_entitlement(u2, 'premium'), 'and the second gets nothing');
  perform t_ok('re-recording never moves a purchase to another customer');
end
$$;

-- --- identity ---------------------------------------------------------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-00000000000d');
  info jsonb;
  token uuid;
begin
  info := tollgate.ensure_customer(u);
  token := (info ->> 'appAccountToken')::uuid;
  perform t_assert(token is not null, 'a token is minted');
  perform t_eq(
    (tollgate.ensure_customer(u) ->> 'appAccountToken')::uuid, token,
    'and is stable across calls'
  );
  perform t_eq(tollgate.user_for_token(token), u, 'the token finds its user');

  perform tollgate.link_alias(u, 'apple', '1000000123456789');
  perform t_eq(
    tollgate.user_for_alias('apple', '1000000123456789'), u,
    'and so does a store alias'
  );
  perform t_assert(
    tollgate.user_for_alias('google', '1000000123456789') is null,
    'aliases do not leak across stores'
  );
  perform t_ok('identity: tokens and aliases both resolve');
end
$$;

-- --- live_purchases is the restore and repair worklist ----------------------
do $$
declare
  u uuid := t_user('11111111-1111-4111-8111-00000000000e');
  refs jsonb;
begin
  perform tollgate.record_purchase(u, t_purchase(p_txn => 'm1', p_original => 'm'));
  perform tollgate.record_purchase(u, t_purchase(p_txn => 'm2', p_original => 'm'));
  perform tollgate.record_purchase(u, t_purchase(
    p_txn => 'm3', p_original => 'm3',
    p_sku => 'sku.gems.medium', p_kind => 'consumable'
  ));

  refs := tollgate.live_purchases(u);
  perform t_eq(jsonb_array_length(refs), 1, 'one subscription, not two transactions');
  perform t_eq(refs -> 0 ->> 'originalTransactionId', 'm', 'named by the stable id');
  perform t_ok('live_purchases collapses renewals and skips consumables');
end
$$;

\echo '  -- entitlements: all passed'
