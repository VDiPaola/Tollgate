# @tollgate/supabase

The SQL pack and its Postgres-backed `Persistence`.

## Installing into a project

**1. Copy the migrations.** Both files, into your project's migrations
directory, with your own timestamp prefixes and in this order:

```
migrations/0001_tollgate_schema.sql     -> 20260901000000_tollgate_schema.sql
migrations/0002_tollgate_functions.sql  -> 20260901000001_tollgate_functions.sql
```

They assume `auth.users`, `auth.uid()` and the `anon` / `authenticated` /
`service_role` roles exist, and nothing else.

**2. Expose the schema to PostgREST.** In `supabase/config.toml`:

```toml
[api]
schemas = ["public", "graphql_public", "tollgate"]
```

Without this every call fails with `Invalid schema: tollgate`.

Saving the file is not enough on a stack that is already running: PostgREST
reads its schema list from an environment variable fixed when its container was
created. Restart the stack, or apply it live from the database instead:

```sql
alter role authenticator
  set pgrst.db_schemas = 'public,graphql_public,tollgate';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
```

**3. Describe what you sell.** In your own migration, not in the pack:

```sql
insert into tollgate.entitlement_defs (key, name) values
  ('premium', 'Premium');

insert into tollgate.products (id, kind, entitlement_key) values
  ('premium_monthly', 'subscription', 'premium');

insert into tollgate.products (id, kind, grant_payload) values
  ('gems_medium', 'consumable', '{"gems": 500}');

insert into tollgate.store_products (store, store_product_id, base_plan_id, product_id) values
  ('apple',  'com.example.premium.monthly', null,      'premium_monthly'),
  ('google', 'premium',                     'monthly', 'premium_monthly'),
  ('stripe', 'price_1ABC...',               null,      'premium_monthly');
```

A `store_products` row that names a base plan matches only that plan. A row
leaving it null is a catch-all for every plan of that SKU, and an exact match
always beats a catch-all. Use the catch-all unless different plans of one SKU
need to map to different products, because a plan added in the Play console and
forgotten about here would otherwise be a subscription somebody paid for that
grants nothing.

**4. Point the hooks at your own functions.**

```sql
create function credit_gems(
  p_user uuid, p_product text, p_payload jsonb, p_purchase uuid
) returns jsonb language plpgsql as $$ ... $$;

create function debit_gems(
  p_user uuid, p_product text, p_payload jsonb, p_purchase uuid, p_clawback text
) returns jsonb language plpgsql as $$ ... $$;

update tollgate.config set
  grant_hook = 'credit_gems',
  revoke_hook = 'debit_gems',
  hook_search_path = 'public',
  clawback = 'revoke',
  grace_days = 3,
  sandbox = 'deny';
```

Both signatures are fixed and checked when you set them, so a typo fails here
rather than in the middle of a payment. The stored name is rewritten to a
schema-qualified one, because the call sites run with an empty `search_path`.
Your hook itself may use unqualified names: `hook_search_path` is restored
around the call and set back afterwards.

**5. Read entitlements.** Everywhere your app used to check a plan flag:

```sql
select tollgate.has_entitlement(auth.uid(), 'premium');
```

Never read `tollgate.entitlements.active` directly. It is a cache of what the
store last said, and the commonest way to stop being entitled is for time to
pass and nothing at all to happen. `has_entitlement` and `get_entitlements`
apply the clock; the column exists so a realtime subscriber gets pushed
something when state changes.

## Configuration

| Column | Default | What it decides |
| --- | --- | --- |
| `grant_hook` | null | Called when a consumable is delivered, in the same transaction that marks it delivered |
| `revoke_hook` | null | Called when a delivered consumable is pulled back |
| `hook_search_path` | `public` | The `search_path` the hooks run under |
| `clawback` | `revoke` | `revoke` takes the goods back even into a negative balance, `keep` reports the refund and leaves it alone. Either way the customer is flagged |
| `grace_days` | 3 | Slack for silence between a renewal being charged and anybody being told. Not an override: a store that says the subscription is over ends it at once |
| `sandbox` | `deny` | Whether a store's test environment may grant anything here |

## Access model

Every table is RLS-enabled. A signed-in user may read their own
`tollgate.entitlements` row and nothing else, which is enough to hold a realtime
subscription on it. Every function is revoked from `PUBLIC` and granted to
`service_role`, except `my_entitlements()` and `my_customer()`.

That last part is not decoration. Postgres grants `EXECUTE` on new functions to
`PUBLIC` by default, so a pack that forgets one revoke lets any signed-in client
call `record_purchase` and grant itself a subscription.

## Using the persistence

```ts
import { createClient } from '@supabase/supabase-js';
import { GoogleAdapter, Tollgate } from '@tollgate/core';
import { SupabasePersistence } from '@tollgate/supabase';

const tollgate = new Tollgate({
  adapters: [
    new GoogleAdapter({
      packageName: Deno.env.get('GOOGLE_PLAY_PACKAGE_NAME')!,
      serviceAccount: Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64')!,
      pubsubAudience: Deno.env.get('GOOGLE_PUBSUB_AUDIENCE'),
      pubsubServiceAccountEmail: Deno.env.get(
        'GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL',
      ),
    }),
  ],
  persistence: new SupabasePersistence({
    client: createClient(url, SERVICE_ROLE_KEY),
  }),
});
```

The client must hold the service role key. An anon client gets permission errors
rather than wrong answers, which is the intended failure.

## Tests

```
deno task test:db
```

Creates a throwaway `postgres:17-alpine` container named `tollgate_sqltest`,
installs the pack, runs the cases, and destroys it. It touches no project
database. Starting from bare Postgres rather than a Supabase stack is
deliberate: it proves the pack depends on nothing but the three things listed
in step 1.
