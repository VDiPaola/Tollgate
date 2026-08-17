# Google Play setup

Everything needed to make Tollgate's Google adapter work, and which environment
variable each step produces.

Google Play has **no sandbox environment**. Unlike Stripe and Apple, there is one
set of credentials and one API. A purchase is a test purchase because of *who
bought it*, not because of which environment it happened in, and the API marks
it with a `testPurchase` field. Everything below is therefore set up once and
used by both testing and production.

## Order of work

Step 3 is the slow one. Its permissions take a day or two to propagate, and
until they do, every API call fails in a way indistinguishable from a
misconfiguration. Do it before anything that depends on it.

| Step | Produces |
| --- | --- |
| 1. Play Console app entry | `GOOGLE_PLAY_PACKAGE_NAME` |
| 2. Google Cloud project and API | nothing directly, unblocks the rest |
| 3. Service account and its Play grants | `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` |
| 4. Pub/Sub topic and push subscription | `GOOGLE_PUBSUB_AUDIENCE`, `GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_RTDN_TOPIC` |
| 5. Products | rows in `tollgate.store_products` |
| 6. A test device | a purchase token to verify against |

## 1. The Play Console app entry

Create the app in Play Console. Its **package name** must match the
`applicationId` in the Android build exactly.

```kotlin
// android/app/build.gradle.kts
android {
    defaultConfig {
        applicationId = "com.example.app"
    }
}
```

A mismatch fails every purchase attempt with an error that does not mention the
package name, so it is worth checking rather than assuming.

> `GOOGLE_PLAY_PACKAGE_NAME` is this value.

Also add at least one Google account under **Setup > License testing**. License
testers buy through the real purchase flow without being charged, and they can
sideload builds that have not been uploaded to Play. Without one, there is no
way to test a purchase at all.

## 2. A Google Cloud project

In Play Console, open **Setup > API access** and link a Google Cloud project.
Creating a new one from that screen is fine and keeps billing credentials
separate from any other Cloud work.

In the Cloud console for that project, enable the **Google Play Android
Developer API**. Without it every call returns 403, whatever the permissions
say.

## 3. A service account, and its Play Console grants

**Create it.** Cloud console > **IAM & Admin > Service accounts**. It needs no
Cloud IAM roles; its authority comes entirely from Play Console.

**Create a JSON key** for it and download the file. This is a credential that can
read revenue data and issue refunds. It should live in a secret store, never in
version control.

**Encode it.** The private key inside the JSON contains newlines, and a newline
in a `.env` value is either a parse error or a silently truncated key depending
on the reader. Base64 avoids the question:

```bash
base64 -w0 service-account.json                 # Linux, macOS, Git Bash
```
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\service-account.json"))
```

> `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` is the encoded output. It carries the
> client email, the private key and the project id, so nothing else has to be
> kept in step with it.

**Grant it access.** Play Console > **Users and permissions > Invite new user**,
using the service account's email address (it ends in
`.iam.gserviceaccount.com`). Scoped to the app, grant:

| Permission | Why it is needed |
| --- | --- |
| View financial data, orders, and cancellation survey responses | Reading purchase and subscription state |
| Manage orders and subscriptions | Acknowledging, consuming and refunding |

**Then wait.** These grants commonly take a day or two to take effect. During
that window the API returns permission errors that look exactly like a bad key
or a missing API, and re-checking the other steps will not help.

## 4. Real-time developer notifications

Play publishes subscription and purchase state changes to a Cloud Pub/Sub topic.
A notification only says that *something* changed; the handler still calls the
Play Developer API for the actual state.

**a. Create a topic** in the same Cloud project, for example `play-rtdn`.

**b. Let Play publish to it.** On the topic's permissions, add this principal
exactly as written:

```
google-play-developer-notifications@system.gserviceaccount.com
```

with the role **Pub/Sub Publisher**. This is Google's own account, not the
service account from step 3. If the console refuses to add it, the project has
the Domain Restricted Sharing organisation policy enabled and needs an exception
for it.

**c. Create a push subscription** on the topic:

| Setting | Value |
| --- | --- |
| Delivery type | Push |
| Endpoint URL | `https://<project-ref>.supabase.co/functions/v1/tollgate-google` |
| Authentication | Enabled, nominating a service account |
| Audience | the same endpoint URL |

Authentication is not optional. The endpoint is public, so the Google-signed
token on each push request is the only thing separating a real delivery from any
other POST that reaches it. Tollgate rejects anything it cannot verify.

> `GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL` is the nominated service account.
> `GOOGLE_PUBSUB_AUDIENCE` is the audience value.

**d. Point Play at the topic.** Play Console > **Monetise with Play >
Monetisation setup > Real-time developer notifications**. Enter the full topic
name and enable one-time product notifications as well as subscriptions, since
consumables need them.

```
projects/<project-id>/topics/play-rtdn
```

**Send test notification** confirms the wiring before any handler exists.

> `GOOGLE_RTDN_TOPIC` is the full topic name. It is recorded for reference and
> is not read at runtime: a Pub/Sub push carries the *subscription* name, not
> the topic, so there is nothing to compare it against. The guard against a
> subscription pointed at the wrong app is `packageName`, which every developer
> notification carries and which Tollgate checks on each one.

### Serving two environments from one topic

Play holds one topic per app, so test and production notifications arrive
together. Rather than repointing the endpoint before launch, add a **second push
subscription** to the same topic. Pub/Sub delivers every message to every
subscription:

| Subscription | Endpoint | `tollgate.config.sandbox` | Effect |
| --- | --- | --- | --- |
| development | dev stack | `allow` | test purchases grant entitlements |
| production | production stack | `deny` | test purchases are recorded, grant nothing |

## 5. Products

Play Console > **Monetise with Play**. The app needs at least one build uploaded
to a track before products can be created.

- **Subscriptions** carry both a subscription id and one or more **base plan**
  ids. Both are needed: the base plan is what holds the price and billing period.
- **One-time products** are single purchases, used for consumables. Google
  replaced the older "in-app products" model with these, and an app that has
  been migrated no longer answers the legacy `inappproducts` API at all: it
  returns "Please migrate to the new publishing API". Tollgate reads purchase
  state through `purchases.productsv2`, which works either way.

Products must be **active**. Map each into `tollgate.store_products`:

```sql
insert into tollgate.store_products
  (store, store_product_id, base_plan_id, product_id)
values
  ('google', 'premium',  'monthly', 'premium_monthly'),
  ('google', 'gems_500', null,      'gems_medium');
```

`base_plan_id` holds the **variant** of the SKU, and Google fills it two ways: a
subscription's base plan, and under Billing 8 a one-time product's purchase
option. Both mean the same thing here, which is one SKU sold several ways.

A row naming a variant matches only that variant. A row leaving it null is a
catch-all for all of them, and an exact match always wins. The catch-all is the
safer default: a base plan or purchase option added in the Console and never
mapped here would otherwise be something somebody paid for that grants nothing.
Name variants explicitly only when two of them have to grant different things,
such as two purchase options of one product selling different quantities.

`deno task probe:google` prints these rows for the app's real catalogue, so the
ids do not have to be transcribed from the Console by hand.

## 6. Testing on a device

License testers can **sideload a debug build**, so iteration does not require a
Play upload each time. Two conditions: the package name matches the Console
entry, and the Google account signed in on the device is a registered license
tester.

Install **Play Billing Lab** from the Play Store on the test device. It forces a
test subscription into grace period, account hold, pause or cancellation on one
tap, which is the difference between testing the unhappy paths and assuming they
work.

Test purchases run on accelerated timers:

| Production behaviour | Under license testing |
| --- | --- |
| Monthly subscription renewal | every 5 minutes, stopping after 6 renewals |
| Yearly subscription renewal | every 30 minutes |
| Grace period | 5 minutes |
| Account hold | 10 minutes |
| Free trial | 3 minutes |
| Acknowledgement deadline (3 days) | minutes |

Play offers several test payment instruments at checkout:

| Instrument | Exercises |
| --- | --- |
| Test instrument, always approves | the happy path |
| Test instrument, always declines | a failed payment |
| Slow test card, approves after a few minutes | pending purchases, where delivery must wait for settlement |
| Slow test card, declines after a few minutes | a pending purchase that is then rejected |
| Test card, approves then charges back | refund clawback and customer flagging |

## Verifying the setup

```
deno task probe:google
```

Reads `.env` and checks, in the order things actually go wrong: the key decodes,
Google accepts the service account assertion, the Play API answers for this app,
and a supplied purchase token resolves. It prints what Tollgate made of that
purchase in the terms it would store it, including whether the purchase carries
an account token and whether it reads as a test purchase.

Nothing secret is printed. Keys never are, the service account address is partly
masked, and a purchase token appears only as a short prefix, so the output is
safe to paste into a bug report.

The check most worth watching is the access token. It is the one that fails for
a day or two after the Play Console grants are made, and it fails in a way that
looks exactly like a broken key.

## What cannot be automated

A Play purchase requires a person tapping through the Play dialog on a physical
device. No credential grants that, so any test cycle has two halves:

1. A human buys on the device and captures the purchase token.
2. The server side is verified against the Play Developer API from a terminal.

`GOOGLE_TEST_PURCHASE_TOKEN`, `GOOGLE_TEST_PRODUCT_ID` and
`GOOGLE_TEST_BASE_PLAN_ID` exist to carry a real token from the first half to
the second. They are development conveniences and are not read at runtime.

## Reference

- [Test your Play Billing integration](https://developer.android.com/google/play/billing/test)
- [Real-time developer notifications](https://developer.android.com/google/play/billing/getting-ready#configure-rtdn)
- [purchases.subscriptionsv2.get](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get)
- [Play Billing Lab](https://play.google.com/store/apps/details?id=com.google.android.apps.play.billingtestcompanion)
