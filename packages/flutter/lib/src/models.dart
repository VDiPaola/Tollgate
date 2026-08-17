/// The vocabulary the client speaks, mirroring `@tollgate/core`'s.
///
/// Kept deliberately small. Everything here is either read from the server's
/// JSON or read from the store's own product listing, and nothing is computed
/// on the device: what a customer is entitled to is a server answer, because a
/// device can be told to say anything.
library;

/// A payment processor.
enum TollgateStore { apple, google, stripe, fake }

TollgateStore? _storeFrom(String? value) => switch (value) {
  'apple' => TollgateStore.apple,
  'google' => TollgateStore.google,
  'stripe' => TollgateStore.stripe,
  'fake' => TollgateStore.fake,
  _ => null,
};

/// What kind of thing is being sold.
enum TollgateProductKind { subscription, consumable, nonConsumable }

/// One entitlement's current state.
///
/// [active] already has the clock applied by the server, so it does not need
/// re-checking against [expiresAt] here. The other fields are for showing the
/// customer what is going on, not for deciding what they may do.
class Entitlement {
  final String key;
  final bool active;
  final TollgateStore? store;
  final String? productId;
  final DateTime? periodStart;
  final DateTime? expiresAt;
  final bool willRenew;
  final bool inGracePeriod;

  /// When the customer was first seen to have turned renewal off.
  final DateTime? unsubscribeDetectedAt;

  /// When a renewal payment was first seen to be failing.
  final DateTime? billingIssueDetectedAt;

  const Entitlement({
    required this.key,
    required this.active,
    this.store,
    this.productId,
    this.periodStart,
    this.expiresAt,
    this.willRenew = false,
    this.inGracePeriod = false,
    this.unsubscribeDetectedAt,
    this.billingIssueDetectedAt,
  });

  factory Entitlement.fromJson(Map<String, dynamic> json) => Entitlement(
    key: json['key'] as String,
    active: json['active'] as bool? ?? false,
    store: _storeFrom(json['store'] as String?),
    productId: json['productId'] as String?,
    periodStart: _date(json['periodStart']),
    expiresAt: _date(json['expiresAt']),
    willRenew: json['willRenew'] as bool? ?? false,
    inGracePeriod: json['inGracePeriod'] as bool? ?? false,
    unsubscribeDetectedAt: _date(json['unsubscribeDetectedAt']),
    billingIssueDetectedAt: _date(json['billingIssueDetectedAt']),
  );

  /// Whether this subscription is running out and nobody has renewed it.
  ///
  /// The honest signal for a win-back prompt: still entitled, but on its way
  /// out. Not the same as inactive, and not the same as a billing failure.
  bool get lapsing => active && !willRenew && expiresAt != null;
}

/// Everything the client knows about who this customer is to Tollgate.
class CustomerInfo {
  final String userId;

  /// Attached to every store purchase, and the only thing that lets a renewal
  /// notification years from now be traced back to this account.
  final String appAccountToken;

  final Map<String, Entitlement> entitlements;

  /// Set when a refund or chargeback has been recorded against them.
  final DateTime? flaggedAt;
  final String? flagReason;

  const CustomerInfo({
    required this.userId,
    required this.appAccountToken,
    this.entitlements = const {},
    this.flaggedAt,
    this.flagReason,
  });

  factory CustomerInfo.fromJson(Map<String, dynamic> json) {
    final list = entitlementsFrom(json['entitlements']);
    return CustomerInfo(
      userId: json['userId'] as String,
      appAccountToken: json['appAccountToken'] as String,
      entitlements: {for (final e in list) e.key: e},
      flaggedAt: _date(json['flaggedAt']),
      flagReason: json['flagReason'] as String?,
    );
  }

  bool isActive(String key) => entitlements[key]?.active ?? false;

  CustomerInfo withEntitlements(List<Entitlement> list) => CustomerInfo(
    userId: userId,
    appAccountToken: appAccountToken,
    entitlements: {for (final e in list) e.key: e},
    flaggedAt: flaggedAt,
    flagReason: flagReason,
  );
}

/// Something the customer can buy, priced by the store it is sold through.
///
/// The price is always the store's own localised string rather than anything
/// this app worked out. Apple and Google both format money for the account's
/// country, tax rules and currency, and none of that is knowable on the device
/// from a number in a database.
class TollgateProduct {
  /// The store's SKU.
  final String storeProductId;

  /// The variant, where the store has such a thing: a Google base plan on a
  /// subscription, or a Billing 8 purchase option on a one-time product.
  final String? variantId;

  final String title;
  final String description;

  /// Ready to print. Never assembled from [rawPrice] and [currencyCode].
  final String price;

  final double rawPrice;
  final String currencyCode;
  final TollgateProductKind kind;

  /// Opaque, and required to buy a specific Google offer. Passed straight back.
  final String? offerToken;

  const TollgateProduct({
    required this.storeProductId,
    required this.title,
    required this.description,
    required this.price,
    required this.rawPrice,
    required this.currencyCode,
    required this.kind,
    this.variantId,
    this.offerToken,
  });
}

/// A product as one store sells it, straight from the server's catalogue.
///
/// The bridge between what an app wants to sell and what a store calls it. An
/// app knows it wants `premium_monthly`; the store has never heard of that and
/// wants `standard.sub`. Asking for the mapping keeps store ids out of the
/// binary, where changing one would mean shipping a release.
class StoreProduct {
  final String productId;
  final TollgateProductKind kind;
  final String? entitlementKey;
  final String storeProductId;
  final String? basePlanId;

  const StoreProduct({
    required this.productId,
    required this.kind,
    required this.storeProductId,
    this.entitlementKey,
    this.basePlanId,
  });

  factory StoreProduct.fromJson(Map<String, dynamic> json) => StoreProduct(
    productId: json['productId'] as String,
    kind: switch (json['kind'] as String?) {
      'subscription' => TollgateProductKind.subscription,
      'consumable' => TollgateProductKind.consumable,
      _ => TollgateProductKind.nonConsumable,
    },
    storeProductId: json['storeProductId'] as String,
    entitlementKey: json['entitlementKey'] as String?,
    basePlanId: json['basePlanId'] as String?,
  );
}

/// What happened when a purchase was attempted.
class PurchaseResult {
  final PurchaseOutcome outcome;

  /// Whether the goods are delivered for this purchase, by any path.
  ///
  /// This is the one to show a buyer. A store notification routinely reaches
  /// the server a couple of hundred milliseconds before the device that made
  /// the purchase, does the delivering, and leaves this call's own [granted]
  /// false for goods that were very much handed over.
  final bool delivered;

  /// Whether this particular call ran the grant hook. Diagnostic only: false
  /// is the ordinary case when a store notification got there first.
  final bool granted;

  /// The customer's entitlements after the server recorded it. Null when
  /// nothing reached the server.
  final List<Entitlement>? entitlements;

  /// Whatever the host app's grant hook returned, for a consumable.
  final Object? grantResult;

  /// Set when [outcome] is [PurchaseOutcome.failed].
  final String? message;

  const PurchaseResult(
    this.outcome, {
    this.entitlements,
    this.delivered = false,
    this.granted = false,
    this.grantResult,
    this.message,
  });

  bool get succeeded => outcome == PurchaseOutcome.purchased;
}

enum PurchaseOutcome {
  purchased,

  /// The customer backed out. Not an error and not worth reporting to them.
  cancelled,

  /// The store took the order but the money has not arrived: a slow payment
  /// method, or a child asking a parent. Nothing is granted yet, and a
  /// notification will follow when it settles.
  pending,

  failed,
}

/// Entitlements from either wire shape.
///
/// The server sends an array. It is read leniently anyway, because the same
/// data is a keyed map inside the SDK's own core and a mismatch between the two
/// is an easy mistake to make on either side; the failure it produces is a cast
/// error at startup that stops a paying customer using what they bought, which
/// is far too harsh a punishment for a shape disagreement.
List<Entitlement> entitlementsFrom(Object? value) {
  if (value is List) {
    return value
        .whereType<Map<String, dynamic>>()
        .map(Entitlement.fromJson)
        .toList();
  }
  if (value is Map) {
    return value.values
        .whereType<Map<String, dynamic>>()
        .map(Entitlement.fromJson)
        .toList();
  }
  return const [];
}

DateTime? _date(Object? value) =>
    value is String ? DateTime.tryParse(value)?.toUtc() : null;
