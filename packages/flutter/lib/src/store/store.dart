/// What a store's client SDK has to be able to do.
///
/// One implementation per platform, chosen at runtime. Everything here is
/// device-side only: no implementation of this decides anything about
/// entitlements, and none of them talks to a Tollgate server.
library;

import '../models.dart';

/// A purchase the store's SDK has surfaced to the app.
class StorePurchase {
  /// The store's proof, handed to the server for verification. On Google this
  /// is the purchase token.
  final String token;

  final String storeProductId;
  final StorePurchaseStatus status;

  /// Whether the store is still waiting to be told the goods were handed over.
  /// Until it is, Play re-delivers the purchase on every app start, and after
  /// three days it refunds it.
  final bool needsCompletion;

  final String? errorMessage;

  /// The SDK's own object, needed to complete the purchase later.
  final Object native;

  const StorePurchase({
    required this.token,
    required this.storeProductId,
    required this.status,
    required this.needsCompletion,
    required this.native,
    this.errorMessage,
  });
}

enum StorePurchaseStatus { purchased, pending, cancelled, error, restored }

abstract class StoreClient {
  TollgateStore get store;

  /// Whether this device can buy anything at all. False on an emulator without
  /// Play services, or a device signed out of the store.
  Future<bool> available();

  /// Look up SKUs, priced and described by the store itself.
  Future<List<TollgateProduct>> products(Set<String> storeProductIds);

  /// Everything the store reports: new purchases, restored ones, and failures.
  ///
  /// Stores push purchases the app did not ask for. A purchase interrupted by
  /// a crash, one completed on another device, and one that finally settled
  /// after a slow payment method all arrive here unprompted, which is why this
  /// is a stream rather than a return value from [buy].
  Stream<StorePurchase> get purchases;

  /// Start a purchase. Resolves when the flow has been handed to the store,
  /// not when it finishes; the result arrives on [purchases].
  ///
  /// Returns false when the store declined to open the flow at all, which it
  /// does for something already owned. That case reports nothing on
  /// [purchases], so a caller that ignores this answer waits forever for an
  /// outcome that is never coming.
  ///
  /// [appAccountToken] is attached to the purchase itself. It cannot be added
  /// afterwards, and without it a renewal notification years from now names a
  /// transaction and nothing else.
  Future<bool> buy(
    TollgateProduct product, {
    required String appAccountToken,
  });

  /// Tell the store the goods were handed over.
  ///
  /// Called only after the server has confirmed it recorded the purchase.
  /// The other order loses purchases: Play forgets consumed ones and Billing 8
  /// removed the ability to query them back, so completing first and then
  /// failing to record leaves nothing to recover from.
  Future<void> complete(StorePurchase purchase);

  /// Ask the store to re-deliver past purchases, onto [purchases].
  Future<void> restore();

  void dispose();
}
