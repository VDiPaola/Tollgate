/// Tollgate: one purchase API over Google Play, the App Store and Stripe.
///
/// ```dart
/// await Tollgate.configure(backend: MyBackend());
///
/// final products = await Tollgate.instance.products(
///   {'premium', 'gem.1'},
///   consumables: {'gem.1'},
/// );
/// final result = await Tollgate.instance.purchase(products.first);
///
/// if (Tollgate.instance.isActive('premium')) { ... }
/// ```
///
/// Nothing here decides what a customer is entitled to. The device asks a
/// store to take a payment, hands the store's proof to a server, and is told
/// the answer. A device that could decide its own entitlements would be a
/// device that could grant itself a subscription.
library;

export 'src/backend.dart';
export 'src/client.dart' show Tollgate, TollgateLogger;
export 'src/models.dart';
export 'src/store/store.dart';
export 'src/store/google_store.dart' show GoogleStoreClient;
