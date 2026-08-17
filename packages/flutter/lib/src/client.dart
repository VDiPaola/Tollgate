/// The client.
///
/// One object, one purchase call, whichever store the device is on. It owns the
/// order things happen in; the store clients own the platform SDKs and the
/// backend owns everything that decides what a customer is entitled to.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'backend.dart';
import 'models.dart';
import 'store/store.dart';
import 'store/apple_store.dart';
import 'store/google_store.dart';

/// Something to write diagnostics to. Purchases fail in ways nobody can
/// reproduce, so the paths that swallow an error all report through this.
typedef TollgateLogger = void Function(String message, [Object? detail]);

class Tollgate {
  static Tollgate? _instance;

  static Tollgate get instance {
    final it = _instance;
    if (it == null) {
      throw StateError('Tollgate.configure() has not been called.');
    }
    return it;
  }

  final TollgateBackend _backend;
  final StoreClient? _store;
  final TollgateLogger _log;

  final _customer = ValueNotifier<CustomerInfo?>(null);
  final _entitlements = StreamController<List<Entitlement>>.broadcast();
  StreamSubscription<StorePurchase>? _storeSub;

  /// Completes when the store reports the outcome of the purchase in flight,
  /// along with the SKU it is waiting for.
  ///
  /// The SKU is not decoration. Stores deliver purchases nobody just asked for,
  /// and they arrive on the same stream: one left pending by an earlier
  /// failure, one made on another device, one that finally settled. Any of
  /// those landing while a purchase is in flight would otherwise complete the
  /// waiting call with a different purchase's outcome, and the buyer would be
  /// shown the wrong answer about their own payment.
  Completer<PurchaseResult>? _pending;
  String? _pendingProductId;

  /// Whether a purchase is being recorded right now.
  ///
  /// Settling with the store can fail while that is still in flight, and the
  /// plugin reports the failure as an error on the same stream the purchase
  /// came in on. Without this, that error resolves the buyer's call before the
  /// recording it is racing has had a chance to succeed.
  bool _recording = false;

  /// Purchase tokens this session has already recorded with the server.
  ///
  /// Settling with the store can fail after the goods are safely delivered, and
  /// the failure comes back through the purchase stream as an error rather than
  /// as an exception. Without this, a purchase that was recorded, credited and
  /// merely settled by somebody else is reported to the buyer as failed.
  final Set<String> _recorded = {};

  Tollgate._(this._backend, this._store, this._log);

  /// Set up the client and start listening to the store.
  ///
  /// Listening starts here rather than at the first purchase because stores
  /// deliver purchases nobody asked for: one interrupted by a crash, one made
  /// on another device, one that settled days after a slow payment. Those
  /// arrive shortly after launch and are lost if nothing is listening.
  static Future<Tollgate> configure({
    required TollgateBackend backend,
    StoreClient? store,
    TollgateLogger? logger,
  }) async {
    _instance?.dispose();

    final client = Tollgate._(
      backend,
      store ?? _defaultStore(),
      logger ?? _defaultLogger,
    );
    await client._start();
    _instance = client;
    return client;
  }

  static StoreClient? _defaultStore() {
    // Chosen by platform rather than by asking, because the two clients pull in
    // different plugins and only one of them can work here.
    if (kIsWeb) return null;
    return switch (defaultTargetPlatform) {
      TargetPlatform.android => GoogleStoreClient(),
      TargetPlatform.iOS || TargetPlatform.macOS => AppleStoreClient(),
      // Web, Windows and Linux have no in-app store. They buy through the web
      // checkout the host app already has, so a null store is a normal state
      // rather than a failure.
      _ => null,
    };
  }

  static void _defaultLogger(String message, [Object? detail]) {
    debugPrint('[tollgate] $message${detail == null ? '' : ' $detail'}');
  }

  Future<void> _start() async {
    _storeSub = _store?.purchases.listen(
      _onStorePurchase,
      onError: (Object e) => _log('store stream error', e),
    );
    try {
      _customer.value = await _backend.customer();
    } catch (e) {
      // Not fatal. The app should still open when billing is unreachable, and
      // the token is fetched again before any purchase.
      _log('could not load the customer', e);
    }
  }

  /// The customer, or null before the first successful load.
  ValueListenable<CustomerInfo?> get customer => _customer;

  /// Entitlements as they change. Does not replay; read [customer] for now.
  Stream<List<Entitlement>> get entitlements => _entitlements.stream;

  bool isActive(String key) => _customer.value?.isActive(key) ?? false;

  /// Whether this device can buy through an in-app store at all.
  Future<bool> get storeAvailable async =>
      _store != null && await _store.available();

  /// Look up SKUs, priced by the store.
  ///
  /// [consumables] names which of them the app treats as consumable, and is
  /// only read on Android. Play sells a one-time product without any notion of
  /// whether it is used up, so nothing in its response can answer the question
  /// and the app's own catalogue has to. Apple states the product type, so the
  /// iOS client ignores this and asks the store.
  Future<List<TollgateProduct>> products(
    Set<String> storeProductIds, {
    Set<String> consumables = const {},
  }) async {
    final store = _store;
    if (store == null) return const [];
    if (store is GoogleStoreClient) store.declareConsumables(consumables);
    return await store.products(storeProductIds);
  }

  /// Buy something.
  ///
  /// Resolves when the purchase has been recorded by the server and settled
  /// with the store, or when it failed or was cancelled. A [PurchaseResult] is
  /// returned for every outcome rather than thrown, because a customer backing
  /// out of a payment sheet is not an error.
  Future<PurchaseResult> purchase(TollgateProduct product) async {
    final store = _store;
    if (store == null) {
      return const PurchaseResult(
        PurchaseOutcome.failed,
        message: 'There is no in-app store on this device.',
      );
    }
    if (_pending != null) {
      return const PurchaseResult(
        PurchaseOutcome.failed,
        message: 'Another purchase is already in progress.',
      );
    }

    // Fetched immediately before buying, never cached from configure(). It has
    // to be attached to the purchase itself and cannot be added afterwards, so
    // a stale or missing token here is unrecoverable rather than inconvenient.
    final CustomerInfo customer;
    try {
      customer = await _backend.customer();
      _customer.value = customer;
    } catch (e) {
      // The customer gets a sentence; the log gets the cause. Without this the
      // only thing anybody sees is "could not reach your account", which is
      // equally true of a dead network, a bad token and a response the client
      // could not parse, and those need three different fixes.
      _log('could not load the customer before purchase', e);
      return const PurchaseResult(
        PurchaseOutcome.failed,
        message: 'Could not reach your account. Nothing has been charged.',
      );
    }

    final completer = Completer<PurchaseResult>();
    _pending = completer;
    _pendingProductId = product.storeProductId;
    try {
      final started = await store.buy(
        product,
        appAccountToken: customer.appAccountToken,
      );
      if (!started) {
        // The store declined to open the flow, which it does for something
        // already owned. Nothing will arrive on the purchase stream, so
        // waiting on the completer would hang the caller for good, which is
        // what a permanently disabled button looks like from the outside.
        _clearPending();
        return const PurchaseResult(
          PurchaseOutcome.failed,
          message: 'That could not be bought right now. You may already own it.',
        );
      }
    } catch (e) {
      _clearPending();
      return PurchaseResult(PurchaseOutcome.failed, message: '$e');
    }
    return await completer.future;
  }

  /// Re-read everything the stores could still change their minds about.
  ///
  /// Apple requires an explicit restore control, and this is also the repair
  /// path for state that drifted while notifications were failing.
  Future<List<Entitlement>> restore() async {
    try {
      await _store?.restore();
    } catch (e) {
      _log('the store refused to restore purchases', e);
    }
    final list = await _backend.refresh();
    _publish(list);
    return list;
  }

  /// Re-read entitlements from the server without involving any store.
  Future<List<Entitlement>> reload() async {
    final list = await _backend.entitlements();
    _publish(list);
    return list;
  }

  /// A purchase the store has told us about, asked for or not.
  Future<void> _onStorePurchase(StorePurchase purchase) async {
    switch (purchase.status) {
      case StorePurchaseStatus.cancelled:
        _settle(const PurchaseResult(PurchaseOutcome.cancelled), purchase);
        return;

      case StorePurchaseStatus.error:
        if (_recording || _recorded.contains(purchase.token)) {
          // Recorded, or being recorded. The usual cause is the store refusing
          // a second consume because something else settled first, and "you do
          // not own this" is a true statement about a purchase that has been
          // handed over rather than a failed payment.
          //
          // Not settled either way: the recording in flight is the thing that
          // knows the real outcome, and answering here would beat it to it.
          _log('settling error, ignored', purchase.errorMessage);
          return;
        }
        _settle(
          PurchaseResult(
            PurchaseOutcome.failed,
            message: purchase.errorMessage ?? 'The purchase failed.',
          ),
          purchase,
        );
        return;

      case StorePurchaseStatus.pending:
        // A slow payment method, or a child waiting on a parent's approval.
        // Nothing is owed until the money arrives, and a notification will
        // follow when it does.
        _settle(const PurchaseResult(PurchaseOutcome.pending), purchase);
        return;

      case StorePurchaseStatus.purchased:
      case StorePurchaseStatus.restored:
        await _record(purchase);
    }
  }

  Future<void> _record(StorePurchase purchase) async {
    final store = _store!;
    _recording = true;
    try {
      final response = await _backend.verify(
        store: store.store,
        token: purchase.token,
        storeProductId: purchase.storeProductId,
      );

      _recorded.add(purchase.token);
      final list = entitlementsFrom(response['entitlements']);
      _publish(list);

      // Only now. The server has the purchase recorded and any consumable
      // credited, so telling the store it was delivered can no longer lose
      // anything. Doing this first and then failing to record would: Play
      // forgets consumed purchases and Billing 8 removed the ability to query
      // them back.
      if (purchase.needsCompletion) {
        try {
          await store.complete(purchase);
        } catch (e) {
          // The customer has their goods and the server knows it. The risk left
          // is a store-side auto-refund in three days, and the pending purchase
          // is re-delivered on the next app start, which retries this.
          _log('could not settle the purchase with the store', e);
        }
      }

      _settle(
        PurchaseResult(
          PurchaseOutcome.purchased,
          entitlements: list,
          delivered: response['delivered'] == true,
          granted: response['granted'] == true,
          grantResult: response['grantResult'],
        ),
        purchase,
      );
    } catch (e) {
      // Deliberately not completed with the store. An unrecorded purchase must
      // stay pending so it is re-delivered and can be recovered; completing it
      // here would take the money and lose the record.
      _log('could not record the purchase', e);
      _settle(
        PurchaseResult(
          PurchaseOutcome.failed,
          message:
              'The payment went through but could not be confirmed. It will be '
              'retried automatically.',
        ),
        purchase,
      );
    } finally {
      _recording = false;
    }
  }

  void _publish(List<Entitlement> list) {
    final current = _customer.value;
    if (current != null) _customer.value = current.withEntitlements(list);
    if (!_entitlements.isClosed) _entitlements.add(list);
  }

  /// Resolve the purchase in flight, if this outcome belongs to it.
  ///
  /// Two things arrive here that must not resolve it. Purchases nobody is
  /// waiting on, which is normal: restored ones, ones made elsewhere, ones that
  /// settled long after the fact. And purchases for a different SKU than the
  /// one in flight, which would answer the buyer's question with somebody
  /// else's answer.
  ///
  /// An outcome that names **no** product is the exception, and it has to be,
  /// because that is what backing out of the payment sheet looks like. A
  /// cancellation is reported by the store as "the flow you started ended" with
  /// no purchase attached, so the plugin synthesises one carrying an empty
  /// product id and an empty token. Nothing else produces those: they exist
  /// only in response to a purchase this client asked for. Matching them on SKU
  /// leaves the caller waiting for an answer that has already arrived and can
  /// never arrive again, which the buyer sees as a spinner that never stops and
  /// then a button that refuses them for the rest of the session.
  void _settle(PurchaseResult result, [StorePurchase? purchase]) {
    final pending = _pending;
    if (pending == null) return;
    if (purchase != null &&
        purchase.storeProductId.isNotEmpty &&
        _pendingProductId != null &&
        purchase.storeProductId != _pendingProductId) {
      _log(
        'ignoring an unrelated ${purchase.storeProductId} purchase while '
        'waiting on $_pendingProductId',
      );
      return;
    }
    _clearPending();
    if (!pending.isCompleted) pending.complete(result);
  }

  void _clearPending() {
    _pending = null;
    _pendingProductId = null;
  }

  void dispose() {
    _storeSub?.cancel();
    _store?.dispose();
    _entitlements.close();
    _customer.dispose();
    if (identical(_instance, this)) _instance = null;
  }
}
