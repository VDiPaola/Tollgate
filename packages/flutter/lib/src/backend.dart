/// How the client reaches its own server.
///
/// An interface rather than a hard dependency on Supabase, for one practical
/// reason: this package is a Flutter plugin and pulling a specific
/// `supabase_flutter` version into it would force every host app onto that
/// version. The host passes its own already-configured client instead.
library;

import 'models.dart';

/// The four things the client needs from the server.
///
/// Every one of them is a question only the server can answer. Nothing here
/// has a device-side fallback, because a device that could decide its own
/// entitlements would be a device that could grant itself a subscription.
abstract class TollgateBackend {
  /// The signed-in user's customer record, minting one if needed.
  ///
  /// Called before any purchase, because its `appAccountToken` has to be
  /// attached to the purchase itself, and there is no way to attach it
  /// afterwards.
  Future<CustomerInfo> customer();

  /// Hand a store's proof of purchase over to be verified and recorded.
  ///
  /// [token] is whatever the store gave the device. On Google that is the
  /// purchase token; the server does not trust it and re-reads the purchase
  /// from Play before granting anything.
  Future<Map<String, dynamic>> verify({
    required TollgateStore store,
    required String token,
    required String storeProductId,
    String? variantId,
    TollgateProductKind? kind,
  });

  /// Re-read everything the stores could still change their minds about.
  ///
  /// Both the "restore purchases" button and the repair pass for state that
  /// drifted while notifications were failing.
  Future<List<Entitlement>> refresh();

  /// The customer's entitlements as they stand.
  Future<List<Entitlement>> entitlements();
}

/// Raised when the server refuses or cannot be reached.
class TollgateBackendException implements Exception {
  final String message;
  final Object? cause;

  const TollgateBackendException(this.message, [this.cause]);

  @override
  String toString() => 'TollgateBackendException: $message';
}
