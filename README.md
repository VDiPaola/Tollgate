# Tollgate

One purchase API over Apple's App Store, Google Play and Stripe, backed by your
own Postgres.

Tollgate is a **library, not a service**. There is no Tollgate server holding
your customers. You run the migrations against your own Supabase project, and
that project's database is the only place your entitlements live. Reuse means
installing it again in the next project, not pointing the next project at
shared infrastructure.

## Why it exists

Apple and Google require their own payment processors for digital content
bought inside an app, so a Flutter app that also sells on the web ends up with
three payment processors, three notification formats, three subscription state
machines and three ideas of what "cancelled" means. Tollgate normalises all of
that into one table your app reads:

```sql
select active from tollgate.entitlements where user_id = $1 and key = 'premium';
```

## What it does and does not do

It does:

- verify purchases server-side against the store that issued them, so nothing a
  client sends decides entitlement
- keep one normalised subscription state across stores, updated both by store
  notifications and by direct refresh, so a missed webhook is recoverable
- deliver consumable purchases exactly once, into a SQL function you name
- report refunds and chargebacks, flag the customer, and hand the clawback
  decision back to your app
- map store notifications back to your users, which stores will not do for you

It deliberately does not:

- host a paywall editor, remote offering configuration, or A/B testing
- store or see a card number
- know what your products actually grant. A gem pack is a `grant_payload` blob
  and the name of one of your own functions

## Packages

| Package | What it is |
| --- | --- |
| `packages/core` | Runtime-neutral TypeScript: models, the store adapter contract, orchestration, the fake store |
| `packages/supabase` | The SQL pack, the Postgres-backed persistence, and drop-in edge function handlers |
| `packages/flutter` | Dart client: Play Billing on Android, StoreKit 2 on iOS, and no store at all on web and desktop |

Core is written against `fetch` and Web Crypto only, with no Node built-ins, so
one build runs in Supabase Edge Functions (Deno) and in a Next.js route handler
(Node). That constraint is not aesthetic. Apple's own
`@apple/app-store-server-library` has documented ES256 curve failures under
Deno, and `googleapis` is Node-only, so both signature paths are implemented
here directly.

### There is no browser client, on purpose

Selling on the web means Stripe, and the Stripe adapter deliberately does not
create checkouts: an app that sells through Stripe has already answered
currency, tax and pricing its own way, and taking that over would mean
reimplementing it worse. What is left for a browser client to do is hand a
`sub_…` or `pi_…` id to an endpoint and read back a list of entitlements, which
is a `fetch` call against the app's own Supabase client rather than a package.

The Flutter client already covers a Flutter web build: it detects that there is
no in-app store on the platform, sells nothing itself, and leaves the host app's
existing checkout to it. A separate JavaScript package would earn its place only
for a non-Flutter web front end that wanted the same purchase orchestration, and
until something needs that it would be a package to keep in step for no benefit.

## Status

| Phase | | |
| --- | --- | --- |
| 1 | Core, schema pack, fake store, hooks | done |
| 2 | Google Play adapter (Billing 8, RTDN) | done |
| 3 | Flutter client, Google path | done |
| 4 | Host app integration | done, verified with real Google purchases |
| 5 | Stripe adapter | done; not yet exercised against live Stripe |
| 6 | Apple adapter and the StoreKit 2 client | written and tested; unverifiable without a Mac |
| — | JavaScript client | [dropped](#there-is-no-browser-client-on-purpose) |

130 TypeScript tests, 30 SQL cases and 20 Dart tests pass.

The Flutter client originally sat after Stripe. It was moved ahead because
nothing about Google can be verified without it: a Play purchase needs a person
tapping through the store dialog on a device, so until an app can start that
flow there is no purchase token for the server half to be checked against.

Google is verified end to end on real hardware: purchases, subscriptions,
consumables, renewals, refunds and real-time notifications, all through licence
testing. Stripe is tested against recorded payloads and real signature round
trips, but has not been pointed at a live account yet.

Apple is complete on both sides and proven on neither. The server half is tested
against payloads signed by a throwaway certificate chain the tests hold the keys
to, which covers the cases a captured Apple payload cannot: a forged chain, a
body its signature does not cover, an expired certificate. What it cannot cover
is a real purchase, because that needs an iOS build, which needs Xcode, which
needs a Mac. Treat the Apple path as unproven until one has been through it.

## Documentation

- [Google Play setup](docs/google-setup.md) — the two consoles, and where each
  environment variable comes from
- [App Store setup](docs/apple-setup.md) — the key, the products, the
  notification endpoint, and what needs a Mac
- [`@tollgate/supabase`](packages/supabase/README.md) — installing the SQL pack
  into a project
- [Host app integration](docs/host-integration.md) — installing it into a project
- [`tollgate` (Flutter)](packages/flutter/README.md) — the device client
- [`.env.example`](.env.example) — the credential template

## Development

Deno 2 drives the workspace.

```
deno task check         # type-check every TypeScript package
deno task test          # unit tests: no database, no credentials, needs openssl
deno task test:db       # SQL pack tests, needs Docker
deno task probe:google  # check Google Play credentials, needs .env
deno task revoke:google # cancel a test subscription so it can be bought again
deno task vendor <dir>          # copy the TS packages into a host project
deno task vendor:flutter <dir>  # copy the Dart package into a host project
```

Both take `--check`, which changes nothing and exits non-zero when the copy in
the host project is stale.

`openssl` is a real requirement rather than a convenience. The certificate and
JWS tests build a chain they hold every key to, which is the only way to test
that a forged one is refused; they fail rather than skip when they cannot run.

The Flutter package has its own toolchain:

```
cd packages/flutter && flutter test && flutter analyze
```

All of it runs on every push through [CI](.github/workflows/ci.yml), including
the SQL pack against a Postgres service container.

The SQL tests run against a throwaway Postgres container, not against any
project's database.

## Making a real purchase

A store purchase cannot be automated: it needs a person tapping through the
store's own dialog on a physical device. Reaching that point takes five things,
in this order:

1. The migrations installed into a Supabase project, and the `tollgate` schema
   exposed to PostgREST
2. `entitlement_defs`, `products` and `store_products` rows describing what is
   sold. `deno task probe:google` prints the Google half of those
3. An edge function built from `createClientHandler`, reachable from the device.
   A local `supabase start` works over the LAN if the device uses the machine's
   IP rather than localhost
4. A `TollgateBackend` implementation in the host app, which is about thirty
   lines over an existing Supabase client
5. A debug build installed on a device signed in with a licence-tester account

Only then does a purchase token exist for `GOOGLE_TEST_PURCHASE_TOKEN`, which is
what lets the probe check the server's view of a real purchase.
