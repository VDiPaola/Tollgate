# App Store setup

[← Documentation](README.md) · [Project overview](../README.md)

Everything needed to make Tollgate's Apple adapter work, and which environment
variable each step produces.

Apple, unlike Google, **does have a real sandbox**: a separate API host holding
separate transactions, bought with separate Apple IDs. A sandbox transaction is
simply absent from production, which is why every lookup that misses is retried
against the other host rather than reported as a purchase that does not exist.

> [!WARNING]
> This setup cannot be completed without a paid **Apple Developer Program**
> membership and a **Mac**. Xcode only runs on macOS, and an iOS app cannot be
> built, signed, or installed on a device without it. Tollgate's server path is
> covered by signed-payload tests, but its device path has not yet been
> validated on Apple hardware.

## Before you begin

- Confirm you can manage the app in App Store Connect.
- Accept the Paid Applications Agreement and complete the required banking and
  tax details.
- Keep [`.env.example`](../.env.example) open; every generated value maps to a
  documented environment variable there.
- Prepare a Mac, Xcode, and a physical Apple device for end-to-end testing.

## Order of work

| Step | Produces |
| --- | --- |
| 1. App record and bundle id | `APPLE_BUNDLE_ID` |
| 2. In-App Purchase key | `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_BASE64` |
| 3. Products | rows in `tollgate.store_products` |
| 4. Server notifications V2 | nothing; wires the endpoint |
| 5. A sandbox tester and a device | a transaction to verify against |

## 1. The app record

Create the app in App Store Connect. Its **bundle id** must match the Xcode
project's exactly.

> [!NOTE]
> `APPLE_BUNDLE_ID` is this value.

Apple checks it twice, in places that fail differently. The API token carries it
as a claim and is refused with a bare 401 if it is not the bundle the key was
issued for, and every signed transaction carries it too, which is what stops one
app's purchase being presented to another app's server.

Paid apps and in-app purchases also need the **Paid Applications Agreement**
accepted and the bank and tax details completed, under Business. Until that is
done, products stay in "Missing Metadata" and cannot be bought even in sandbox.

## 2. An In-App Purchase key

App Store Connect > **Users and Access > Integrations > In-App Purchase**, then
**Generate In-App Purchase Key**.

This is not the same as an App Store Connect API key, and the two are not
interchangeable: only an In-App Purchase key can call the App Store Server API.

- The **Issuer ID** is shown once at the top of the Keys page and is the same for
  every key on the account.
- The **Key ID** is per key.
- The **`.p8` file** downloads once. Apple will not let it be downloaded again,
  so losing it means revoking the key and issuing another.

> [!NOTE]
> `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY_BASE64`, the last
> being the `.p8` file's contents base64-encoded:
>
> ```bash
> base64 -w0 AuthKey_ABCD123456.p8                # Linux, macOS, Git Bash
> ```
> ```powershell
> [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\AuthKey_ABCD123456.p8"))
> ```

The key is a credential that can read every transaction the account has ever
taken. It belongs in a secret store, never in version control.

## 3. Products

App Store Connect > the app > **Monetization > In-App Purchases** or
**Subscriptions**. Apple has four product types and states which one a product
is, both in the store listing the app reads and on the signed transaction, so
nothing has to be told what a product is the way Google's side does.

| App Store Connect type | Tollgate `kind` |
| --- | --- |
| Auto-Renewable Subscription | `subscription` |
| Consumable | `consumable` |
| Non-Consumable | `non_consumable` |
| Non-Renewing Subscription | `non_consumable`, with an expiry |

Map each product id into `tollgate.store_products`:

```sql
insert into tollgate.store_products
  (store, store_product_id, base_plan_id, product_id)
values
  ('apple', 'com.example.premium.monthly', null, 'premium_monthly'),
  ('apple', 'com.example.gems.1',          null, 'gems_medium');
```

`base_plan_id` is always null for Apple. It exists for Google, where one SKU is
sold through several base plans or purchase options at different prices. Apple
sells one product at one price and puts the alternatives in a **subscription
group**, which is a set of products a customer chooses between rather than a set
of ways to buy one product, so each one is simply its own row.

A product needs at least the localisation, price and review screenshot filled in
before it can be bought, even in sandbox.

## 4. App Store Server Notifications V2

App Store Connect > the app > **General > App Information > App Store Server
Notifications**. There are two URL fields, production and sandbox, and they can
point at different deployments or at the same one.

```
https://<project-ref>.supabase.co/functions/v1/tollgate-apple
```

Set the version to **Version 2**. Version 1 is a different, unsigned payload
that this adapter does not accept.

The endpoint is public and must be deployed with JWT verification off, because
the caller is Apple and has no Supabase token:

```toml
[functions.tollgate-apple]
verify_jwt = false
```

What makes that safe is the signature. Every notification arrives as a JWS whose
header carries the certificate chain that signed it, and Tollgate checks that the
chain ends at Apple Root CA G3, whose public key is pinned in the source, before
reading a single field. Nothing else about the request is trusted: there is no
shared secret and no IP range to check, and a notification that fails the
signature check is refused with a 401 rather than retried, because a retry of
something Apple did not send changes nothing.

**Request a test notification** from the same screen once the function is
deployed. It arrives as `notificationType: TEST`, names no purchase, and is
recorded and ignored, which is the intended behaviour for every notification
about nothing in particular.

### One consumption request is not answered

`CONSUMPTION_REQUEST` arrives when a customer asks Apple for a refund on a
consumable and Apple wants the app's opinion on whether to grant it. Answering
means calling back within twelve hours with a description of how much of the
purchase was used. Tollgate records the notification and does not answer it,
which is the same as never having opted in: Apple decides on its own. Answering
it is a per-app judgement about the app's own goods, which is exactly the kind of
decision this library leaves to the host.

## 5. Sandbox testing

Sandbox testers are created in App Store Connect under **Users and Access >
Sandbox > Test Accounts**. Use an email address that is not an Apple ID.

On the device, sign the tester in under **Settings > Developer > Sandbox Apple
Account**, not in the main App Store settings. A debug build then buys against
the sandbox automatically, with no separate flag.

Sandbox subscriptions run on accelerated timers, and the renewal rate is
configurable per tester:

| Production period | Sandbox default |
| --- | --- |
| 1 week | 3 minutes |
| 1 month | 5 minutes |
| 2 months | 10 minutes |
| 3 months | 15 minutes |
| 6 months | 30 minutes |
| 1 year | 1 hour |

A sandbox subscription auto-renews six times and then stops, which is enough to
see renewals arrive, be recorded, and expire.

The one thing worth setting up deliberately is a **billing grace period**, under
the subscription group's settings. It is the difference between the two failure
states that matter: a renewal that fails while the customer keeps access, and
one where they do not. Tollgate maps them to different statuses, and only one of
them keeps serving somebody.

## What the environment variables decide

`APPLE_ENVIRONMENT` says which App Store Server API host to ask **first**. It is
only an optimisation, because a lookup that misses is retried against the other
host anyway.

`TOLLGATE_ENVIRONMENT` decides something else entirely: whether a purchase that
came back marked as a sandbox purchase may grant a real entitlement. That
defaults to production, which refuses them. The two are deliberately separate.
Asking the sandbox host is a question about where to look; honouring a sandbox
purchase is a question about who gets to have the paid product.

## What cannot be automated

Everything about the device. A purchase needs a person tapping through Apple's
own sheet, on hardware, in a build made on a Mac. The server half is verified
without any of that, by signing payloads with a throwaway certificate chain the
tests hold the keys to, which is also the only way to check that a payload signed
by anybody else is refused.

## Reference

- [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi)
- [App Store Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications)
- [Get All Subscription Statuses](https://developer.apple.com/documentation/appstoreserverapi/get-all-subscription-statuses)
- [Testing in the sandbox](https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox)

## Next step

Return to the [host integration guide](host-integration.md#4-the-client) to add
the client and prove a sandbox purchase end to end.
