-- Stand-ins for the parts of a Supabase project the pack expects to exist.
--
-- Running against a bare Postgres rather than a whole Supabase stack is
-- deliberate: it proves the pack depends on nothing but these three things, and
-- it means the tests start in about a second.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Supabase reads this out of the request's JWT claims. Here it reads a session
-- setting, so a test can say who it is.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('tollgate.test_uid', true), '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Test helpers
-- ---------------------------------------------------------------------------

create or replace function t_assert(p_cond boolean, p_msg text)
returns void
language plpgsql
as $$
begin
  if p_cond is null or not p_cond then
    raise exception 'ASSERTION FAILED: %', p_msg;
  end if;
end;
$$;

create or replace function t_eq(p_a anyelement, p_b anyelement, p_msg text)
returns void
language plpgsql
as $$
begin
  if p_a is distinct from p_b then
    raise exception 'ASSERTION FAILED: % (got %, expected %)', p_msg, p_a, p_b;
  end if;
end;
$$;

create or replace function t_ok(p_name text)
returns void
language plpgsql
as $$
begin
  raise notice '  ok  %', p_name;
end;
$$;

-- A user that exists, so the customers foreign key is satisfied.
create or replace function t_user(p_id uuid)
returns uuid
language plpgsql
as $$
begin
  insert into auth.users (id, email) values (p_id, p_id::text || '@test.invalid')
  on conflict (id) do nothing;
  return p_id;
end;
$$;

-- The shape tollgate.record_purchase takes, with sensible defaults so a test
-- only names the fields it cares about.
create or replace function t_purchase(
  p_store text default 'fake',
  p_txn text default 'txn_1',
  p_original text default 'orig_1',
  p_sku text default 'sku.premium.monthly',
  p_kind text default 'subscription',
  p_status text default 'active',
  p_expires timestamptz default null,
  p_will_renew boolean default true,
  p_environment text default 'production',
  p_purchased timestamptz default null
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'store', p_store,
    'storeTransactionId', p_txn,
    'originalTransactionId', p_original,
    'storeProductId', p_sku,
    'kind', p_kind,
    'status', p_status,
    'environment', p_environment,
    'offerType', 'none',
    'quantity', 1,
    'purchasedAt', coalesce(p_purchased, now()),
    -- A consumable has no period and never renews, whatever the caller passed.
    'expiresAt', case
      when p_kind = 'consumable' then null
      else coalesce(p_expires, now() + interval '30 days')
    end,
    'willRenew', p_kind <> 'consumable' and p_will_renew,
    'raw', jsonb_build_object('test', true)
  );
$$;
