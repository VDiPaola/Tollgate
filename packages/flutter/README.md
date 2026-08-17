# tollgate (Flutter)

The device half. One purchase call regardless of which store the device is on.

Nothing in this package decides what a customer is entitled to. It asks a store
to take a payment, hands the store's proof to a server, and is told the answer.
A device that could decide its own entitlements would be a device that could
grant itself a subscription.

## Setup

Until this is published to pub.dev, copy it into the host repository and depend
on it from there:

```
deno task vendor:flutter ../<host>/packages/tollgate
```

```yaml
dependencies:
  tollgate:
    path: ../packages/tollgate
```

Depending on a sibling checkout directly, with
`path: ../../tollgate/packages/flutter`, works on the machine that has both
repositories and nowhere else. A build runner checks out one repository, so
`flutter pub get` fails on a directory that does not exist, and the failure
lands in a deploy rather than in a local build. A `git:` dependency solves that
for a public repository and swaps it for a credential on every runner if the
repository is private.

So the copy is committed, like any other vendored dependency, and
`deno task vendor:flutter <dir> --check` reports when it has fallen behind the
SDK. That check needs both repositories, so it runs on a laptop before pushing
rather than in CI.

Write a backend, which is the only app-specific part. Over Supabase it is about
thirty lines:

```dart
class SupabaseTollgateBackend implements TollgateBackend {
  SupabaseTollgateBackend(this._client);
  final SupabaseClient _client;

  Future<Map<String, dynamic>> _call(Map<String, dynamic> body) async {
    final res = await _client.functions.invoke('tollgate', body: body);
    if (res.status >= 400) {
      throw TollgateBackendException('${(res.data as Map?)?['error']}');
    }
    return (res.data as Map).cast<String, dynamic>();
  }

  @override
  Future<CustomerInfo> customer() async =>
      CustomerInfo.fromJson(await _call({'action': 'customer'}));

  @override
  Future<Map<String, dynamic>> verify({
    required TollgateStore store,
    required String token,
    required String storeProductId,
    String? variantId,
    TollgateProductKind? kind,
  }) => _call({
    'action': 'verify',
    'store': store.name,
    'token': token,
    'storeProductId': storeProductId,
    'variantId': variantId,
    // The device consumes and acknowledges its own purchases. Both sides doing
    // it is not harmless: Play errors on a second consume, and the client SDK
    // cannot clear a purchase it did not consume, so it re-delivers it forever.
    'completeOnDevice': true,
  });

  @override
  Future<List<Entitlement>> refresh() async => _entitlements({'action': 'refresh'});

  @override
  Future<List<Entitlement>> entitlements() async =>
      _entitlements({'action': 'entitlements'});

  Future<List<Entitlement>> _entitlements(Map<String, dynamic> body) async {
    final data = await _call(body);
    return (data['entitlements'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>()
        .map(Entitlement.fromJson)
        .toList();
  }
}
```

Then configure once, at startup:

```dart
await Tollgate.configure(backend: SupabaseTollgateBackend(supabase));
```

Configuring starts listening to the store immediately, and that timing matters.
Stores deliver purchases nobody asked for: one interrupted by a crash, one made
on another device, one that settled days after a slow payment method. Those
arrive shortly after launch and are lost if nothing is listening yet.

## Which store, on which platform

Chosen automatically, and there is nothing to pass unless a test needs to
substitute one.

| Platform | Store client | Notes |
| --- | --- | --- |
| Android | `GoogleStoreClient` | Play Billing 8 |
| iOS, macOS | `AppleStoreClient` | StoreKit 2 only |
| Web, Windows, Linux | none | `storeAvailable` is false and `purchase` refuses |

A null store is a normal state rather than a failure. Those platforms have no
in-app store to sell through, so the host app's own web checkout does the
selling and Tollgate only reads back what it granted.

**iOS is StoreKit 2 only**, which means iOS 15 or later. StoreKit 1 has no way
to attach an `appAccountToken` to a purchase, so a payment made through it could
never be traced back to an account, at the time or at any renewal afterwards.
The client reports itself unavailable there rather than taking money it cannot
attribute.

## Buying

```dart
final products = await Tollgate.instance.products(
  {'standard.sub', 'gem.1'},
  consumables: {'gem.1'},   // Android only; Apple states the type itself
);

final result = await Tollgate.instance.purchase(products.first);
switch (result.outcome) {
  case PurchaseOutcome.purchased:  // entitlements are already updated
  case PurchaseOutcome.cancelled:  // they backed out; say nothing
  case PurchaseOutcome.pending:    // slow payment; a notification will follow
  case PurchaseOutcome.failed:     // result.message is safe to show
}
```

Always print `product.price`, never a number you formatted. Stores localise
money for the account's country, currency and tax rules, including where the
symbol goes, and none of that is knowable on the device from a raw amount.

## Reading entitlements

```dart
if (Tollgate.instance.isActive('premium')) { ... }

ValueListenableBuilder<CustomerInfo?>(
  valueListenable: Tollgate.instance.customer,
  builder: (context, customer, _) => ...,
);
```

`active` already has the clock applied by the server, so it does not need
re-checking against `expiresAt`.

## Restoring

```dart
await Tollgate.instance.restore();
```

Apple requires an explicit restore control. It is also the repair path for
state that drifted while store notifications were failing.

## Cancelling

An in-app subscription cannot be cancelled from inside an app. The honest
control is a link into the store's own management screen, which the server
supplies.

## The ordering rule

The client tells the store a purchase was delivered **only after** the server
confirms it recorded it. The other order loses purchases: Play forgets consumed
ones and Billing 8 removed the ability to query them back, so completing first
and then failing to record leaves money taken and no record of what it bought.

If recording fails, the purchase is deliberately left uncompleted. The store
re-delivers it on the next app start, which retries the whole thing. The cost
of that is a Play auto-refund if it stays unacknowledged for three days, which
is the better of the two failures. Apple is gentler about the same mistake: an
unfinished transaction is re-delivered on every launch and never auto-refunded,
so the cost there is repetition rather than money.

## What is proven, and what is not

The Android path has been through real purchases on real hardware: subscriptions,
consumables, renewals, refunds and store notifications.

The iOS path has not, and cannot be until there is a Mac to build on. It is
analyzed and type-checked against the real plugin API, and the server half it
talks to is tested, but no Apple purchase has ever been through it. Treat it as
unproven code rather than as a working feature.
