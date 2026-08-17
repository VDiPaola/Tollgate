/// Google Play, through the official `in_app_purchase` plugin.
///
/// The plugin's Android side wraps Play Billing 8, which Google requires for
/// every app update from 31 August 2026.
library;

import 'dart:async';

import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';

import '../models.dart';
import 'store.dart';

class GoogleStoreClient implements StoreClient {
  @override
  TollgateStore get store => TollgateStore.google;

  final InAppPurchase _iap;
  final _controller = StreamController<StorePurchase>.broadcast();
  StreamSubscription<List<PurchaseDetails>>? _subscription;

  /// SKUs the host app treats as consumable.
  ///
  /// This is the authority, not a hint. Play sells one-time products without
  /// any notion of whether they are used up, so nothing in its response can
  /// answer the question, and getting it wrong means buying a gem pack through
  /// `buyNonConsumable` and acknowledging rather than consuming it, which
  /// leaves the customer unable to ever buy a second one.
  final Set<String> _consumables = {};

  GoogleStoreClient({InAppPurchase? iap})
    : _iap = iap ?? InAppPurchase.instance {
    _subscription = _iap.purchaseStream.listen(
      _onPurchases,
      onError: (Object e) => _controller.addError(e),
    );
  }

  @override
  Future<bool> available() => _iap.isAvailable();

  @override
  Future<List<TollgateProduct>> products(Set<String> storeProductIds) async {
    if (storeProductIds.isEmpty) return const [];
    final response = await _iap.queryProductDetails(storeProductIds);

    // Reported rather than thrown. A catalogue with one bad SKU should still
    // sell the others, and the usual cause is a product that exists in the
    // database but was never activated in the Play Console.
    if (response.error != null && response.productDetails.isEmpty) {
      throw StateError(
        'Google Play refused the product lookup: ${response.error!.message}',
      );
    }

    return response.productDetails.map(_toProduct).toList();
  }

  TollgateProduct _toProduct(ProductDetails details) {
    String? variantId;
    String? offerToken;

    // Subscriptions come back one entry per offer, each with its own token,
    // and buying the wrong one charges the wrong price. The token is opaque and
    // has to be handed straight back to the purchase call.
    if (details is GooglePlayProductDetails) {
      offerToken = details.offerToken;
      variantId = _basePlanId(details);
    }

    return TollgateProduct(
      storeProductId: details.id,
      variantId: variantId,
      title: details.title,
      description: details.description,
      // The store's own localised string. Never rebuilt from rawPrice: Play
      // formats for the account's country and currency, including where the
      // symbol goes and whether tax is shown, and none of that is knowable here.
      price: details.price,
      rawPrice: details.rawPrice,
      currencyCode: details.currencyCode,
      kind: _kindOf(details),
      offerToken: offerToken,
    );
  }

  /// The base plan behind a subscription offer.
  ///
  /// Read defensively off the wrapped native object, because it sits a couple
  /// of layers down and the plugin has moved it before. A null base plan simply
  /// falls through to a catch-all row on the server, so failing to find it
  /// costs nothing.
  String? _basePlanId(GooglePlayProductDetails details) {
    try {
      final offers = details.productDetails.subscriptionOfferDetails;
      final index = details.subscriptionIndex;
      if (offers == null || index == null) return null;
      if (index < 0 || index >= offers.length) return null;
      return offers[index].basePlanId;
    } catch (_) {
      return null;
    }
  }

  /// What kind of thing Play is selling.
  ///
  /// The declared consumables are consulted first, because they are the only
  /// source of that answer: Play reports a one-time product identically whether
  /// the app uses it up or not.
  TollgateProductKind _kindOf(ProductDetails details) {
    if (_consumables.contains(details.id)) {
      return TollgateProductKind.consumable;
    }
    if (details is GooglePlayProductDetails) {
      final subs = details.productDetails.subscriptionOfferDetails;
      if (subs != null && subs.isNotEmpty) {
        return TollgateProductKind.subscription;
      }
    }
    return TollgateProductKind.nonConsumable;
  }

  /// Tell this client which SKUs are consumables, from the app's own catalogue.
  ///
  /// Must be called before [products], and it decides between `buyConsumable`
  /// and `buyNonConsumable`.
  void declareConsumables(Set<String> storeProductIds) {
    _consumables.addAll(storeProductIds);
  }

  @override
  Stream<StorePurchase> get purchases => _controller.stream;

  @override
  Future<bool> buy(
    TollgateProduct product, {
    required String appAccountToken,
  }) async {
    final response = await _iap.queryProductDetails({product.storeProductId});
    final details = response.productDetails.firstWhere(
      (d) => d.id == product.storeProductId,
      orElse: () => throw StateError(
        'Google Play does not sell "${product.storeProductId}". It has to be '
        'created and activated in the Play Console first.',
      ),
    );

    final param = GooglePlayPurchaseParam(
      productDetails: details,
      // The whole of the identity mechanism on Android. The plugin passes this
      // to BillingFlowParams.setObfuscatedAccountId, and it comes back on the
      // server's view of the purchase as obfuscatedExternalAccountId. Without
      // it, a renewal notification cannot be traced to an account.
      applicationUserName: appAccountToken,
      offerToken: product.offerToken,
    );

    final consumable = _consumables.contains(product.storeProductId) ||
        product.kind == TollgateProductKind.consumable;
    if (consumable) {
      return await _iap.buyConsumable(
        purchaseParam: param,
        // Consumption happens when `completePurchase` is called, and this
        // client only calls that once the server has confirmed it recorded and
        // granted the purchase. So the timing is controlled by us, not by the
        // plugin, and the ordering rule holds: record, then consume.
        autoConsume: true,
      );
    }
    return await _iap.buyNonConsumable(purchaseParam: param);
  }

  @override
  Future<void> complete(StorePurchase purchase) async {
    final details = purchase.native;
    if (details is! PurchaseDetails) return;
    if (!details.pendingCompletePurchase) return;
    await _iap.completePurchase(details);
  }

  @override
  Future<void> restore() => _iap.restorePurchases();

  void _onPurchases(List<PurchaseDetails> list) {
    for (final details in list) {
      _controller.add(
        StorePurchase(
          // On Android this is the Play purchase token, which is both the
          // proof and the id that survives renewals.
          token: details.verificationData.serverVerificationData,
          storeProductId: details.productID,
          status: switch (details.status) {
            PurchaseStatus.purchased => StorePurchaseStatus.purchased,
            PurchaseStatus.restored => StorePurchaseStatus.restored,
            PurchaseStatus.pending => StorePurchaseStatus.pending,
            PurchaseStatus.canceled => StorePurchaseStatus.cancelled,
            PurchaseStatus.error => StorePurchaseStatus.error,
          },
          needsCompletion: details.pendingCompletePurchase,
          errorMessage: details.error?.message,
          native: details,
        ),
      );
    }
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _controller.close();
  }
}
