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
| `packages/flutter` | Dart client. `in_app_purchase` on mobile, `flutter_stripe` on web |
| `packages/js` | Browser and Next.js client |

Core is written against `fetch` and Web Crypto only, with no Node built-ins, so
one build runs in Supabase Edge Functions (Deno) and in a Next.js route handler
(Node). That constraint is not aesthetic. Apple's own
`@apple/app-store-server-library` has documented ES256 curve failures under
Deno, and `googleapis` is Node-only, so both signature paths are implemented
here directly.

## Status

| Phase | | |
| --- | --- | --- |
| 1 | Core, schema pack, fake store, hooks | done |
| 2 | Google Play adapter (Billing 8, RTDN) | server side done, unverified against a real device |
| 3 | Stripe adapter | not started |
| 4 | Flutter and JS clients | not started |
| 5 | First host app integration | not started |
| 6 | Apple adapter | not started |

62 unit tests and 30 SQL cases pass. The Google adapter is tested against
recorded API payloads and a real signing round trip, but has not yet been run
against Google, because that needs credentials and a physical device.

## Documentation

- [Google Play setup](docs/google-setup.md) — the two consoles, and where each
  environment variable comes from
- [`@tollgate/supabase`](packages/supabase/README.md) — installing the SQL pack
  into a project
- [`.env.example`](.env.example) — the credential template

## Development

Deno 2 drives the workspace.

```
deno task check         # type-check every package
deno task test          # unit tests, no database and no credentials needed
deno task test:db       # SQL pack tests, needs Docker
deno task probe:google  # check Google Play credentials, needs .env
```

The SQL tests run against a throwaway Postgres container, not against any
project's database.
