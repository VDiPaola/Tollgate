-- The catalogue the tests buy from. This is also a worked example of what a
-- host app writes once, in its own migration, after installing the pack.

insert into tollgate.entitlement_defs (key, name, description) values
  ('premium', 'Premium', 'Higher daily limits.');

insert into tollgate.products (id, kind, entitlement_key) values
  ('premium_monthly', 'subscription', 'premium'),
  ('lifetime',        'non_consumable', 'premium');

insert into tollgate.products (id, kind, grant_payload) values
  ('gems_medium', 'consumable', '{"gems": 500}'::jsonb);

insert into tollgate.store_products (store, store_product_id, base_plan_id, product_id) values
  ('fake',   'sku.premium.monthly', null,      'premium_monthly'),
  -- Enumerated base plans: only these two plans of this SKU map.
  ('google', 'premium',             'monthly', 'premium_monthly'),
  ('google', 'premium',             'annual',  'premium_monthly'),
  -- A catch-all: every base plan of this SKU maps, including ones added in the
  -- Play console later and never configured here.
  ('google', 'premium_plus',        null,      'premium_monthly'),
  ('apple',  'com.example.premium.monthly', null, 'premium_monthly'),
  ('stripe', 'price_premium_monthly', null,    'premium_monthly'),
  ('fake',   'sku.lifetime',        null,      'lifetime'),
  ('fake',   'sku.gems.medium',     null,      'gems_medium');

-- ---------------------------------------------------------------------------
-- A host app's ledger, and the two hooks over it.
--
-- Tollgate knows none of this. It knows a product has a grant_payload and the
-- name of a function to hand it to, which is the whole extension point.
-- ---------------------------------------------------------------------------

create table app_wallet (
  user_id uuid primary key,
  gems int not null default 0
);

create table app_wallet_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  purchase_id uuid not null,
  delta int not null,
  created_at timestamptz not null default now()
);

create function app_credit_gems(
  p_user uuid,
  p_product text,
  p_payload jsonb,
  p_purchase uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_gems int := (p_payload ->> 'gems')::int;
  v_balance int;
begin
  insert into app_wallet (user_id, gems) values (p_user, v_gems)
  on conflict (user_id) do update set gems = app_wallet.gems + v_gems
  returning gems into v_balance;

  insert into app_wallet_ledger (user_id, purchase_id, delta)
  values (p_user, p_purchase, v_gems);

  return jsonb_build_object('balance', v_balance, 'granted', v_gems);
end;
$$;

create function app_debit_gems(
  p_user uuid,
  p_product text,
  p_payload jsonb,
  p_purchase uuid,
  p_clawback text
)
returns jsonb
language plpgsql
as $$
declare
  v_gems int := (p_payload ->> 'gems')::int;
  v_balance int;
begin
  if p_clawback = 'keep' then
    select gems into v_balance from app_wallet where user_id = p_user;
    return jsonb_build_object('balance', v_balance, 'kept', true);
  end if;

  -- No floor. A refund of goods already spent leaves a debt, and recording it
  -- as a debt is more honest than pretending the balance was never that high.
  update app_wallet set gems = gems - v_gems
  where user_id = p_user
  returning gems into v_balance;

  insert into app_wallet_ledger (user_id, purchase_id, delta)
  values (p_user, p_purchase, -v_gems);

  return jsonb_build_object('balance', v_balance, 'clawedBack', v_gems);
end;
$$;

update tollgate.config
set grant_hook = 'app_credit_gems',
    revoke_hook = 'app_debit_gems';
