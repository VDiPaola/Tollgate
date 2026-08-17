-- Tollgate: schema.
--
-- Everything lives in its own `tollgate` schema so this pack can be installed
-- into a project that already has tables, and so a host app can tell at a
-- glance which of its tables it is responsible for. Nothing here is specific
-- to any one app: what a product actually grants is a jsonb blob and the name
-- of one of the host's own functions.
--
-- Copy both migration files into your project's migrations directory with your
-- own timestamp prefixes, keeping their order.
--
-- Access model: every table is RLS-enabled and only `tollgate.entitlements` is
-- readable by an ordinary signed-in user, so a client can subscribe to its own
-- entitlements over realtime. Everything else is reached through the functions
-- in 0002, which are service-role only. No client is ever trusted with what it
-- bought.

create schema if not exists tollgate;

grant usage on schema tollgate to service_role, authenticated;


-- ---------------------------------------------------------------------------
-- stores: a table rather than an enum, because adding a payment processor
-- should be an INSERT in a migration and not an ALTER TYPE that cannot be used
-- in the same transaction that adds it.
-- ---------------------------------------------------------------------------
create table tollgate.stores (
  id text primary key,
  name text not null
);

insert into tollgate.stores (id, name) values
  ('apple',  'Apple App Store'),
  ('google', 'Google Play'),
  ('stripe', 'Stripe'),
  ('fake',   'Fake store (development only)');

-- ---------------------------------------------------------------------------
-- config: one row, holding the decisions a host app makes once.
-- ---------------------------------------------------------------------------
create table tollgate.config (
  id boolean primary key default true check (id),

  -- A function called when a consumable is delivered, in the same transaction
  -- that marks it delivered. Named without its argument list; the signature is
  -- fixed at (uuid, text, jsonb, uuid) and validated by a trigger below.
  --   (p_user, p_product_id, p_grant_payload, p_purchase_id) returns jsonb
  grant_hook text,

  -- Its opposite, for refunds and chargebacks. Signature is fixed at
  --   (p_user, p_product_id, p_grant_payload, p_purchase_id, p_clawback)
  --   (uuid, text, jsonb, uuid, text) returns jsonb
  revoke_hook text,

  -- The search_path the hooks are called under.
  --
  -- Everything in this pack runs with an empty search_path, which is correct
  -- for the pack and wrong for the hooks: a host app's function that says
  -- `insert into wallet` would inherit the empty path and fail to find its own
  -- table, in the middle of a payment. Rather than making every host app write
  -- schema-qualified hooks, the path is restored for the duration of the call
  -- and set back afterwards. Point it at whichever schema the app's own tables
  -- live in.
  hook_search_path text not null default 'public',

  -- What the revoke hook is told to do. 'revoke' takes the goods back even if
  -- that leaves a balance negative, which is the honest record of what
  -- happened; 'keep' reports the refund and leaves the balance alone. Either
  -- way the customer is flagged.
  clawback text not null default 'revoke'
    check (clawback in ('revoke', 'keep')),

  -- Extra days an expired subscription keeps its entitlement. This is slack
  -- for silence, not an override: it covers the gap between a renewal being
  -- charged and anybody being told about it. A store that actually says the
  -- subscription is over ends it immediately, window or no window.
  grace_days int not null default 3 check (grace_days between 0 and 30),

  -- Note what is NOT here: which environment this deployment is. A store's test
  -- purchase arrives through the same API as a real one, so whether to honour
  -- one is the single most security-relevant setting in this pack, and it is
  -- the only one that differs between a laptop and production. A row in this
  -- table travels with the migration that creates it and then has to be
  -- remembered and changed by hand on every stack, which is how a development
  -- value reaches production. It is a deployment's own environment variable
  -- instead; see TollgateOptions.environment.

  updated_at timestamptz not null default now()
);

insert into tollgate.config (id) values (true);

-- ---------------------------------------------------------------------------
-- entitlement_defs: the things a purchase can unlock, named by the host app.
-- ---------------------------------------------------------------------------
create table tollgate.entitlement_defs (
  key text primary key,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- products: what is for sale, independent of who sells it.
--
-- The split between this and store_products is the point of the whole pack: a
-- monthly subscription is one product with an Apple SKU, a Google SKU and a
-- Stripe price, and everything downstream reasons about the product.
-- ---------------------------------------------------------------------------
create table tollgate.products (
  id text primary key,
  kind text not null
    check (kind in ('subscription', 'consumable', 'non_consumable')),

  -- What it unlocks, for the kinds that unlock something.
  entitlement_key text references tollgate.entitlement_defs (key)
    on delete restrict,

  -- What it delivers, for consumables. Opaque to Tollgate and handed straight
  -- to the grant hook: `{"gems": 500}` means nothing here and everything to
  -- the app that wrote the hook.
  grant_payload jsonb,

  enabled boolean not null default true,
  created_at timestamptz not null default now(),

  -- A consumable delivers and unlocks nothing; the other kinds unlock and do
  -- not deliver. Mixing the two would raise a question this pack has no answer
  -- to yet: whether a subscription's payload is delivered once or on every
  -- renewal.
  constraint products_grant_shape check (
    case kind
      when 'consumable'
        then entitlement_key is null and grant_payload is not null
      else entitlement_key is not null and grant_payload is null
    end
  )
);

-- ---------------------------------------------------------------------------
-- store_products: the SKU each store knows a product by.
-- ---------------------------------------------------------------------------
create table tollgate.store_products (
  id bigint generated always as identity primary key,
  store text not null references tollgate.stores (id),
  store_product_id text not null,

  -- The variant of the SKU, where a store has such a thing. Google fills this
  -- two ways: a subscription's BASE PLAN, which carries the price and billing
  -- period, and under Billing 8 a one-time product's PURCHASE OPTION, which
  -- does the same job for a single purchase. Both play the same part here, so
  -- they share the column despite Google's two names for it.
  --
  -- Null means a catch-all matching every variant of that SKU, which is the
  -- right default unless two variants genuinely need to map to different
  -- products.
  base_plan_id text,

  product_id text not null references tollgate.products (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- coalesce, not a plain unique, so two rows for the same SKU with no base plan
-- collide rather than both being allowed through as distinct nulls.
create unique index store_products_sku
  on tollgate.store_products (store, store_product_id, coalesce(base_plan_id, ''));
create index store_products_product on tollgate.store_products (product_id);

-- ---------------------------------------------------------------------------
-- customers: one row per user, and the token that makes stores usable.
--
-- app_account_token is the only thing tying an Apple or Google transaction to
-- a user of this app. Neither store knows who your users are. Apple carries it
-- as `appAccountToken`, Google as `obfuscatedAccountId`, and an app that does
-- not attach one gets renewal notifications two years later naming a
-- transaction and nothing else.
-- ---------------------------------------------------------------------------
create table tollgate.customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  app_account_token uuid not null unique default gen_random_uuid(),

  -- Set when a refund or chargeback has been recorded. Never cleared
  -- automatically: the history in customer_flags is what a human reads to
  -- decide whether this is one bad month or a pattern.
  flagged_at timestamptz,
  flag_reason text,

  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- customer_aliases: store-side identifiers, mapped back to a user.
--
-- Written on every successful verification, because the next thing that
-- happens is a notification carrying only that identifier.
-- ---------------------------------------------------------------------------
create table tollgate.customer_aliases (
  store text not null references tollgate.stores (id),
  alias text not null,
  user_id uuid not null references tollgate.customers (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (store, alias)
);

create index customer_aliases_user on tollgate.customer_aliases (user_id);

-- ---------------------------------------------------------------------------
-- purchases: one row per store transaction. Append-mostly.
-- ---------------------------------------------------------------------------
create table tollgate.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references tollgate.customers (user_id) on delete cascade,
  store text not null references tollgate.stores (id),

  -- This exact transaction. With `store` it is the idempotency key, and every
  -- write path is an upsert onto it: a redelivered notification, a client
  -- retry and a webhook racing a direct verification all land on one row.
  store_transaction_id text not null,

  -- The subscription this belongs to, stable across renewals, and what a
  -- notification names. Equal to store_transaction_id for one-off purchases.
  original_transaction_id text not null,

  store_product_id text not null,
  base_plan_id text,

  -- Null when nothing maps the SKU. The purchase is still recorded: losing the
  -- record of a payment already taken cannot be fixed later, whereas adding the
  -- mapping and replaying can.
  product_id text references tollgate.products (id) on delete set null,

  kind text not null
    check (kind in ('subscription', 'consumable', 'non_consumable')),
  status text not null check (status in (
    'pending', 'active', 'grace', 'on_hold', 'paused',
    'canceled', 'expired', 'revoked'
  )),
  environment text not null default 'production'
    check (environment in ('production', 'sandbox')),
  offer_type text not null default 'none'
    check (offer_type in ('none', 'trial', 'intro', 'promo')),

  quantity int not null default 1 check (quantity > 0),
  purchased_at timestamptz not null,
  expires_at timestamptz,
  will_renew boolean not null default false,
  revoked_at timestamptz,

  -- Consumables only: when the grant hook ran. This, and not whether the row
  -- was new, is what makes delivery exactly-once.
  granted_at timestamptz,

  price_amount_micros bigint,
  price_currency text,
  raw jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (store, store_transaction_id)
);

create index purchases_user on tollgate.purchases (user_id);
create index purchases_original
  on tollgate.purchases (store, original_transaction_id);
-- The restore and repair pass walks these.
create index purchases_live on tollgate.purchases (user_id)
  where kind <> 'consumable' and revoked_at is null;

-- ---------------------------------------------------------------------------
-- entitlements: the derived answer, and the only table an app reads.
--
-- `active` is a CACHE of what the store last said, not the live truth. It
-- cannot be, because the commonest way to stop being entitled is for time to
-- pass and nothing at all to happen. Read through tollgate.get_entitlements()
-- or tollgate.has_entitlement(), which apply the clock. The column exists so a
-- realtime subscriber gets pushed something meaningful when state changes.
-- ---------------------------------------------------------------------------
create table tollgate.entitlements (
  user_id uuid not null references tollgate.customers (user_id) on delete cascade,
  key text not null references tollgate.entitlement_defs (key) on delete cascade,

  active boolean not null default false,
  store text references tollgate.stores (id),
  product_id text references tollgate.products (id) on delete set null,
  purchase_id uuid references tollgate.purchases (id) on delete set null,

  period_start timestamptz,
  expires_at timestamptz,
  will_renew boolean not null default false,
  in_grace_period boolean not null default false,

  -- When the customer was first seen to have turned renewal off, and when a
  -- renewal payment was first seen to be failing. Both are sticky while the
  -- condition holds and cleared when it stops, so "how long has this been
  -- true" is answerable, which is what a win-back prompt needs.
  unsubscribe_detected_at timestamptz,
  billing_issue_detected_at timestamptz,

  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---------------------------------------------------------------------------
-- customer_flags: why a customer is flagged, kept as history.
-- ---------------------------------------------------------------------------
create table tollgate.customer_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references tollgate.customers (user_id) on delete cascade,
  purchase_id uuid references tollgate.purchases (id) on delete set null,
  reason text not null,
  detail text,
  created_at timestamptz not null default now()
);

create index customer_flags_user on tollgate.customer_flags (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- events: every store notification, verified, whole, and deduplicated.
-- ---------------------------------------------------------------------------
create table tollgate.events (
  id uuid primary key default gen_random_uuid(),
  store text not null references tollgate.stores (id),

  -- The store's own id for the event. Every store redelivers on a non-2xx and
  -- some redeliver anyway; without this, a redelivered refund is processed
  -- twice and a redelivered consumable pays out twice.
  store_event_id text not null,

  event_type text not null,
  user_id uuid references tollgate.customers (user_id) on delete set null,
  payload jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,

  unique (store, store_event_id)
);

-- Finding events that were received and never finished, which is what a stuck
-- handler looks like from the outside.
create index events_unfinished on tollgate.events (received_at)
  where processed_at is null;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create function tollgate.touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger purchases_touch before update on tollgate.purchases
  for each row execute function tollgate.touch();
create trigger entitlements_touch before update on tollgate.entitlements
  for each row execute function tollgate.touch();
create trigger config_touch before update on tollgate.config
  for each row execute function tollgate.touch();

-- ---------------------------------------------------------------------------
-- Hook validation, and normalisation to a schema-qualified name.
--
-- The hooks are called with EXECUTE from functions that run with an empty
-- search_path, so an unqualified name that resolves perfectly well when it is
-- configured fails to resolve at all when it is called, in the middle of a
-- payment. Validation therefore does two jobs: it checks that the name resolves
-- to a function with the expected signature, and it rewrites the stored value
-- to `schema.function` so the call site cannot depend on a search_path it does
-- not have.
--
-- A trigger rather than a CHECK because to_regprocedure is stable, not
-- immutable, and because a CHECK cannot rewrite the row.
-- ---------------------------------------------------------------------------
create function tollgate.qualified_hook(p_name text, p_args text)
returns text
language plpgsql
as $$
declare
  v_oid oid := to_regprocedure(p_name || '(' || p_args || ')');
  v_out text;
begin
  if v_oid is null then
    return null;
  end if;
  select quote_ident(n.nspname) || '.' || quote_ident(p.proname)
    into v_out
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.oid = v_oid;
  return v_out;
end;
$$;

create function tollgate.validate_hooks()
returns trigger
language plpgsql
as $$
declare
  v text;
begin
  if new.grant_hook is not null then
    v := tollgate.qualified_hook(new.grant_hook, 'uuid,text,jsonb,uuid');
    if v is null then
      raise exception
        'grant_hook "%" does not name a function (uuid, text, jsonb, uuid). '
        'Expected (p_user, p_product_id, p_grant_payload, p_purchase_id).',
        new.grant_hook;
    end if;
    new.grant_hook := v;
  end if;

  if new.revoke_hook is not null then
    v := tollgate.qualified_hook(new.revoke_hook, 'uuid,text,jsonb,uuid,text');
    if v is null then
      raise exception
        'revoke_hook "%" does not name a function (uuid, text, jsonb, uuid, text). '
        'Expected (p_user, p_product_id, p_grant_payload, p_purchase_id, p_clawback).',
        new.revoke_hook;
    end if;
    new.revoke_hook := v;
  end if;

  return new;
end;
$$;

create trigger config_validate_hooks before insert or update on tollgate.config
  for each row execute function tollgate.validate_hooks();

-- ---------------------------------------------------------------------------
-- RLS and grants.
--
-- Service role bypasses RLS, which is how the edge functions write. The only
-- thing a signed-in user may touch directly is their own entitlements row, and
-- only to read it, so a client can hold a realtime subscription on it.
-- ---------------------------------------------------------------------------
alter table tollgate.stores            enable row level security;
alter table tollgate.config            enable row level security;
alter table tollgate.entitlement_defs  enable row level security;
alter table tollgate.products          enable row level security;
alter table tollgate.store_products    enable row level security;
alter table tollgate.customers         enable row level security;
alter table tollgate.customer_aliases  enable row level security;
alter table tollgate.purchases         enable row level security;
alter table tollgate.entitlements      enable row level security;
alter table tollgate.customer_flags    enable row level security;
alter table tollgate.events            enable row level security;

create policy "own entitlements are readable" on tollgate.entitlements
  for select to authenticated using (user_id = (select auth.uid()));

grant select on tollgate.entitlements to authenticated;
grant all on all tables in schema tollgate to service_role;
grant usage, select on all sequences in schema tollgate to service_role;
