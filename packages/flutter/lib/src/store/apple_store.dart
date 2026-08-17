/// The App Store, through the official `in_app_purchase` plugin.
///
/// StoreKit 2 only, and deliberately so. `appAccountToken` exists only in
/// StoreKit 2; StoreKit 1's nearest equivalent, `applicationUsername`, is not
/// carried on the server-side transaction at all. A purchase made without one
/// is a payment that no notification can ever be traced back to an account, so
/// the StoreKit 1 path refuses to sell rather than selling something nobody can
/// be given.
///
/// The plugin has defaulted to StoreKit 2 since 0.4, and it falls back to
/// StoreKit 1 only where StoreKit 2 is unavailable, which is iOS below 15.
library;

import 'dart:async';

import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_storekit/in_app_purchase_storekit.dart';
import 'package:in_app_purchase_storekit/store_kit_2_wrappers.dart';

import '../models.dart';
import 'store.dart';

class AppleStoreClient implements StoreClient {
  @override
  TollgateStore get store => TollgateStore.apple;

  final InAppPurchase _iap;
  final _controller = StreamController<StorePurchase>.broadcast();
  StreamSubscription<List<PurchaseDetails>>? _subscription;

  AppleStoreClient({InAppPurchase? iap}) : _iap = iap ?? InAppPurchase.instance {
    _subscription = _iap.purchaseStream.listen(
      _onPurchases,
      onError: (Object e) => _controller.addError(e),
    );
  }

  /// Whether this device can buy through StoreKit 2.
  ///
  /// False on a device signed out of the App Store, and false on iOS below 15,
  /// where StoreKit 2 does not exist. Reporting false rather than selling
  /// through StoreKit 1 is the point: see the note at the top of this file.
  @override
  Future<bool> available() async =>
      storeKit2 && await _iap.isAvailable();

  /// Whether the plugin is on its StoreKit 2 path.
  static bool get storeKit2 => InAppPurchaseStoreKitPlatform.isStoreKit2Enabled;

  @override
  Future<List<TollgateProduct>> products(Set<String> storeProductIds) async {
    if (storeProductIds.isEmpty) return const [];
    final response = await _iap.queryProductDetails(storeProductIds);

    // Thrown only when nothing came back at all. A catalogue with one bad SKU
    // should still sell the others, and the usual cause is a product that
    // exists in the database but is not "Ready to Submit" in App Store Connect.
    if (response.error != null && response.productDetails.isEmpty) {
      throw StateError(
        'The App Store refused the product lookup: ${response.error!.message}',
      );
    }

    return response.productDetails.map(_toProduct).toList();
  }

  TollgateProduct _toProduct(ProductDetails details) => TollgateProduct(
    storeProductId: details.id,
    // Apple sells one product at one price. There is no base plan or purchase
    // option to choose between, so nothing goes here and nothing has to be
    // passed back at purchase time, unlike Google's offer token.
    variantId: null,
    title: details.title,
    description: details.description,
    // The store's own localised string. Never rebuilt from rawPrice: Apple
    // formats for the account's storefront, including where the symbol goes.
    price: details.price,
    rawPrice: details.rawPrice,
    currencyCode: details.currencyCode,
    kind: _kindOf(details),
  );

  /// What kind of thing the App Store is selling.
  ///
  /// Apple states this outright, which Google does not: a Play one-time product
  /// looks identical whether the app uses it up or not, so the Google client
  /// has to be told. Nothing here needs telling.
  ///
  /// A non-renewing subscription is a one-time purchase that happens to expire,
  /// so it maps to non-consumable. The server keeps its expiry.
  TollgateProductKind _kindOf(ProductDetails details) {
    if (details is AppStoreProduct2Details) {
      return switch (details.sk2Product.type) {
        SK2ProductType.autoRenewable => TollgateProductKind.subscription,
        SK2ProductType.consumable => TollgateProductKind.consumable,
        SK2ProductType.nonConsumable ||
        SK2ProductType.nonRenewable => TollgateProductKind.nonConsumable,
      };
    }
    return TollgateProductKind.nonConsumable;
  }

  @override
  Stream<StorePurchase> get purchases => _controller.stream;

  @override
  Future<bool> buy(
    TollgateProduct product, {
    required String appAccountToken,
  }) async {
    if (!storeKit2) {
      // Refused rather than sold. A StoreKit 1 purchase carries no
      // appAccountToken, so the server would take the money and have no way of
      // knowing whose it was, now or at any renewal afterwards.
      throw StateError(
        'This device is on StoreKit 1, where a purchase cannot be tied to an '
        'account. Buying needs iOS 15 or later.',
      );
    }

    final response = await _iap.queryProductDetails({product.storeProductId});
    final details = response.productDetails.firstWhere(
      (d) => d.id == product.storeProductId,
      orElse: () => throw StateError(
        'The App Store does not sell "${product.storeProductId}". It has to '
        'exist in App Store Connect and be cleared for sale first.',
      ),
    );

    final param = PurchaseParam(
      productDetails: details,
      // The whole of the identity mechanism on iOS. The plugin passes this to
      // StoreKit as `appAccountToken`, and it comes back on the server's view
      // of the transaction. Apple requires it to be a UUID and silently drops
      // anything else, which is why Tollgate's account token is one.
      applicationUserName: appAccountToken,
    );

    if (product.kind == TollgateProductKind.consumable) {
      // On iOS this is the same call underneath. `autoConsume` has no meaning
      // here, since Apple has nothing to consume: a consumable is finished
      // like anything else, and only after the server has recorded it.
      return await _iap.buyConsumable(purchaseParam: param);
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

  /// Ask StoreKit to re-deliver everything this Apple ID owns.
  ///
  /// Apple requires an app selling non-consumables or subscriptions to offer
  /// this, and it is also the repair path after a reinstall.
  @override
  Future<void> restore() => _iap.restorePurchases();

  void _onPurchases(List<PurchaseDetails> list) {
    for (final details in list) {
      _controller.add(
        StorePurchase(
          // The JWS representation of the transaction, which is what StoreKit 2
          // gives instead of a receipt. It is signed by Apple, so the server
          // can read which transaction it names without trusting the device,
          // and then goes and asks Apple for the state anyway.
          //
          // The transaction id stands in when the plugin has no JWS to hand,
          // which happens on some restored transactions. The server accepts
          // either, since it looks the purchase up either way.
          token: details.verificationData.serverVerificationData.isNotEmpty
              ? details.verificationData.serverVerificationData
              : details.purchaseID ?? '',
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
