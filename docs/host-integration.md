# Installing Tollgate into a host app

What it takes to go from an empty project to a purchase that grants something.
Ordered so each step can be verified before the next one depends on it.

Tollgate is a library. There is no Tollgate server: everything it knows lives in
the host project's own `tollgate` schema.

## 1. The SQL pack

Copy both migrations into the project, keeping their order, with timestamps that
do not collide with anything already there:

```
packages/supabase/migrations/0001_tollgate_schema.sql
packages/supabase/migrations/0002_tollgate_functions.sql
```

Expose the schema to PostgREST, or every call fails with
`Invalid schema: tollgate`:

```toml
[api]
schemas = ["public", "graphql_public", "tollgate"]
```

**Editing that file is not enough on a running stack.** PostgREST takes its
schema list from an environment variable fixed when its container is created,
so a local stack that is already up keeps the old list however many times the
config is saved. Either restart the stack, or tell PostgREST live from the
database, which avoids the downtime:

```sql
alter role authenticator
  set pgrst.db_schemas = 'public,graphql_public,tollgate';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
```

The same is true of a hosted project, where exposing a schema is a dashboard
setting that restarts the API.

Once it is exposed, an anon caller gets `permission denied for schema tollgate`
rather than `Invalid schema`. That is the correct end state: the pack grants
`usage` to `authenticated` and `service_role` only, and everything except the
two `my_*` readers is service-role only on top of that.

## 2. The catalogue and the hooks

A migration of the host's own, describing what is sold and what delivering it
means. Keeping it separate from the pack is what lets the pack be replaced
wholesale when the library moves on.

```sql
insert into tollgate.entitlement_defs (key, name) values ('premium', 'Premium');

insert into tollgate.products (id, kind, entitlement_key) values
  ('premium_monthly', 'subscription', 'premium');
insert into tollgate.products (id, kind, grant_payload) values
  ('gems_small', 'consumable', '{"gem_pack": "gems_small"}');

insert into tollgate.store_products
  (store, store_product_id, base_plan_id, product_id) values
  ('google', 'premium.sub', 'monthly', 'premium_monthly'),
  ('google', 'gems.1',      null,      'gems_small');
```

Then two functions with fixed signatures, and a config row pointing at them:

```sql
create function public.tollgate_grant(
  p_user uuid, p_product text, p_payload jsonb, p_purchase uuid
) returns jsonb ...;

create function public.tollgate_revoke(
  p_user uuid, p_product text, p_payload jsonb, p_purchase uuid, p_clawback text
) returns jsonb ...;

update tollgate.config set
  grant_hook = 'tollgate_grant',
  revoke_hook = 'tollgate_revoke',
  hook_search_path = 'public',
  sandbox = 'allow';   -- development stacks only
```

The names are validated and rewritten to schema-qualified form on write, so a
typo fails here rather than in the middle of a payment.

`sandbox = 'allow'` matters more than it looks. Google has no test environment:
a licence tester's purchase arrives through the same API as a real one, marked
by a flag. A development stack must accept those, and production must not.

**Verify before going further.** Drive the hooks directly, inside a transaction
that rolls back, so nothing is left behind:

```sql
begin;
select tollgate.record_purchase('<a real user id>', jsonb_build_object(
  'store','google','storeTransactionId','TEST-1','originalTransactionId','tok',
  'storeProductId','gems.1','kind','consumable','status','active',
  'environment','sandbox','offerType','none','quantity',1,
  'purchasedAt',now(),'willRenew',false));
rollback;
```

`granted` should be true and the returned `grantResult` should show the balance
moving. Running it twice in one transaction should grant once.

## 3. The edge functions

Until the packages are published, vendor them:

```
deno task vendor ../<host>/supabase/functions/_shared/tollgate
```

Supabase resolves function imports relative to the functions directory, so a
path escaping it neither serves locally nor survives a deploy. Nothing in a
vendored tree should be edited; run the task again instead.

Two functions. The client one:

```ts
import { createClientHandler } from '../_shared/tollgate/supabase/index.ts';
import { asUser, tollgate } from '../_shared/tollgate.ts';

Deno.serve(createClientHandler({ tollgate, authClient: asUser }));
```

And the notification one, which must be deployed with JWT verification off
because the caller is a store with no Supabase token:

```toml
[functions.tollgate-google]
verify_jwt = false
```

What makes that safe is the Google-signed token on the push request, which the
adapter verifies. It refuses every notification when `pubsubAudience` is unset,
rather than accepting unauthenticated ones.

Both need the store credentials from `.env.example` in the function environment.

> A new function directory 404s until the local edge runtime container is
> recreated: it bakes the function list into its environment at creation, and
> restarting is not enough.

## 4. The client

Add the Flutter package, implement `TollgateBackend` over the project's existing
Supabase client, and call `Tollgate.configure` at startup. Both are written out
in [the Flutter package's README](../packages/flutter/README.md).

## 5. Stripe, if the app also sells on the web

The Stripe adapter deliberately does not create checkouts. Currencies, tax and
what a subscription costs in a given country are questions every app that sells
through Stripe has already answered its own way, and taking that over would mean
reimplementing it worse. The app creates the subscription or payment intent as
it always did and hands the id over; Tollgate verifies, records and keeps it in
step.

Two things have to be true of what the app creates:

- The Stripe **customer** carries the Tollgate account token in metadata, under
  the key given as `accountTokenKey`. Stripe knows nothing about an app's users,
  so without it a renewal webhook names a subscription, a customer and nobody.
- A payment with **no Price attached**, such as a one-off charge for an amount
  worked out server-side, carries what it was for under `productKey`. The
  subscription case needs nothing extra: its price id is the SKU.

Map them into `store_products` like any other store. The price id is worth
deriving from wherever the app already keeps it rather than copying: a second
copy of an id is a second thing to keep in step.

### One webhook endpoint, or two

A new project needs **one**: a Stripe endpoint pointing at the `tollgate-stripe`
function, with its signing secret in `STRIPE_WEBHOOK_SECRET`. Subscribe it to
`customer.subscription.*`, `payment_intent.succeeded`, `charge.refunded` and
`charge.dispute.created`.

Two endpoints are worth it in exactly two situations, and both are common enough
to plan for:

- **The project already handles Stripe webhooks.** Whatever grants access today
  keeps doing so until it is deliberately switched over, and repointing its
  endpoint at Tollgate would break it in the meantime. Stripe delivers every
  event to every endpoint, so adding a second one feeds both and neither has to
  know about the other.
- **The project needs events Tollgate ignores.** Price changes, invoices for
  accounting, anything about the catalogue. Tollgate records those and does
  nothing with them, because pricing is the app's business rather than a
  billing library's.

Stripe issues a signing secret per endpoint, so a second endpoint needs a second
secret. `TOLLGATE_STRIPE_WEBHOOK_SECRET` overrides `STRIPE_WEBHOOK_SECRET` for
that case and is otherwise unset.

The alternative to a second endpoint is one function that does both, which the
handler is shaped for:

```ts
const handleTollgate = createNotificationHandler(tollgate, 'stripe');

Deno.serve(async (req) => {
  // A Request body can only be read once, and both halves verify the signature
  // over the raw bytes, so each needs its own copy.
  await myOwnHandler(req.clone());
  return await handleTollgate(req);
});
```

One endpoint and one secret, at the cost of the two halves failing together.
Two endpoints keep them independent, which is why this project uses two.

## 6. Prove it before switching anything over

Do not repoint the app's existing plan logic at `tollgate.has_entitlement` yet.
Leave whatever grants access today doing its job, and let Tollgate record
alongside it, so an unproven payment path is never the only thing standing
between a paying customer and what they bought.

A debug screen that lists products, buys one and prints what came back is enough
to prove the chain. Switching the app over is a separate, deliberate change once
a real purchase has been through end to end.
