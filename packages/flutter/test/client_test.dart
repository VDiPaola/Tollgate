// The client's ordering rules, with a fake store and a fake backend.
//
// The store SDKs cannot run in a unit test and a real purchase needs a person
// tapping a device, so what is pinned here is the sequencing: what happens
// before what, and what happens when one half fails.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:tollgate/tollgate.dart';

class _FakeBackend implements TollgateBackend {
  int customerCalls = 0;
  int verifyCalls = 0;
  bool failVerify = false;
  /// Held open so a test can land other events while a recording is in flight.
  Completer<void>? blockVerify;
  final List<String> tokensSeen = [];

  @override
  Future<CustomerInfo> customer() async {
    customerCalls++;
    return const CustomerInfo(
      userId: 'user-1',
      appAccountToken: '11111111-1111-4111-8111-111111111111',
    );
  }

  @override
  Future<Map<String, dynamic>> verify({
    required TollgateStore store,
    required String token,
    required String storeProductId,
    String? variantId,
    TollgateProductKind? kind,
  }) async {
    verifyCalls++;
    tokensSeen.add(token);
    if (blockVerify != null) await blockVerify!.future;
    if (failVerify) throw const TollgateBackendException('server is down');
    return {
      'granted': true,
      'delivered': true,
      'grantResult': {'balance': 500},
      'entitlements': [
        {'key': 'premium', 'active': true, 'store': 'google', 'willRenew': true},
      ],
    };
  }

  @override
  Future<List<Entitlement>> refresh() async => const [];

  @override
  Future<List<Entitlement>> entitlements() async => const [];
}

class _FakeStore implements StoreClient {
  @override
  TollgateStore get store => TollgateStore.google;

  final _controller = StreamController<StorePurchase>.broadcast();
  final List<String> completed = [];
  final List<String> accountTokensUsed = [];
  bool failComplete = false;

  @override
  Future<bool> available() async => true;

  @override
  Future<List<TollgateProduct>> products(Set<String> ids) async => const [];

  @override
  Stream<StorePurchase> get purchases => _controller.stream;

  bool refuseBuy = false;

  @override
  Future<bool> buy(
    TollgateProduct product, {
    required String appAccountToken,
  }) async {
    accountTokensUsed.add(appAccountToken);
    return !refuseBuy;
  }

  @override
  Future<void> complete(StorePurchase purchase) async {
    if (failComplete) throw StateError('store refused');
    completed.add(purchase.token);
  }

  @override
  Future<void> restore() async {}

  @override
  void dispose() => _controller.close();

  void emit(
    StorePurchaseStatus status, {
    String token = 'token-1',
    String productId = 'gem.1',
    bool needsCompletion = true,
  }) {
    _controller.add(
      StorePurchase(
        token: token,
        storeProductId: productId,
        status: status,
        needsCompletion: needsCompletion,
        native: const Object(),
      ),
    );
  }
}

const _product = TollgateProduct(
  storeProductId: 'gem.1',
  title: 'Gems',
  description: '500 gems',
  price: '£1.79',
  rawPrice: 1.79,
  currencyCode: 'GBP',
  kind: TollgateProductKind.consumable,
);

void main() {
  late _FakeBackend backend;
  late _FakeStore store;
  late Tollgate tollgate;

  setUp(() async {
    backend = _FakeBackend();
    store = _FakeStore();
    tollgate = await Tollgate.configure(
      backend: backend,
      store: store,
      logger: (_, [_]) {},
    );
  });

  tearDown(() => tollgate.dispose());

  test('the account token is attached to the purchase itself', () async {
    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.purchased);
    await future;

    // Without this the purchase reaches Play carrying no identity, and a
    // renewal notification years later names a transaction and nobody.
    expect(store.accountTokensUsed, ['11111111-1111-4111-8111-111111111111']);
  });

  test('the token is fetched fresh for every purchase', () async {
    final first = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.purchased);
    await first;

    final before = backend.customerCalls;
    final second = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.purchased, token: 'token-2');
    await second;

    expect(backend.customerCalls, greaterThan(before));
  });

  test('the store is settled only after the server has recorded it', () async {
    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.purchased);
    final result = await future;

    expect(result.succeeded, isTrue);
    expect(backend.verifyCalls, 1);
    expect(store.completed, ['token-1']);
  });

  test('a purchase the server could not record is left uncompleted', () async {
    backend.failVerify = true;

    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.purchased);
    final result = await future;

    expect(result.outcome, PurchaseOutcome.failed);
    // The important half. Completing here would consume the purchase at Play,
    // which forgets consumed purchases, leaving money taken and no record of
    // what it bought. Left pending, it is re-delivered on the next app start.
    expect(store.completed, isEmpty);
  });

  test('a purchase recorded but not settled still counts as bought', () async {
    store.failComplete = true;

    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.purchased);
    final result = await future;

    // The customer paid and the goods are credited. The risk left is a
    // store-side auto-refund, which is a log line, not something to put in
    // front of somebody who just paid.
    expect(result.succeeded, isTrue);
    expect(result.grantResult, {'balance': 500});
  });

  test('cancelling is not an error', () async {
    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.cancelled);
    final result = await future;

    expect(result.outcome, PurchaseOutcome.cancelled);
    expect(result.message, isNull);
    expect(backend.verifyCalls, 0);
  });

  test('a pending purchase grants nothing yet', () async {
    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.pending);
    final result = await future;

    // A slow payment method. Nothing is owed until the money arrives, and a
    // store notification will follow when it does.
    expect(result.outcome, PurchaseOutcome.pending);
    expect(backend.verifyCalls, 0);
    expect(store.completed, isEmpty);
  });

  test('a restored purchase is recorded even though nobody asked', () async {
    // Reinstalled app, or a purchase made on another device. It arrives with
    // no purchase call waiting on it, and must not be dropped.
    store.emit(StorePurchaseStatus.restored, token: 'token-old');
    await Future<void>.delayed(Duration.zero);

    expect(backend.tokensSeen, contains('token-old'));
  });

  test('entitlements from a purchase reach listeners', () async {
    final seen = <List<Entitlement>>[];
    final sub = tollgate.entitlements.listen(seen.add);

    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.purchased);
    await future;
    await Future<void>.delayed(Duration.zero);

    expect(seen, isNotEmpty);
    expect(seen.last.single.key, 'premium');
    expect(tollgate.isActive('premium'), isTrue);
    await sub.cancel();
  });

  test('two purchases at once are refused rather than interleaved', () async {
    final first = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    final second = await tollgate.purchase(_product);

    expect(second.outcome, PurchaseOutcome.failed);
    store.emit(StorePurchaseStatus.purchased);
    expect((await first).succeeded, isTrue);
  });

  test('an unrelated purchase does not answer the one in flight', () async {
    // The exact confusion this prevents: a gem purchase is in flight, an old
    // subscription left pending by an earlier failure is re-delivered, and the
    // buyer is shown that one's outcome as though it were their own.
    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);

    store.emit(
      StorePurchaseStatus.purchased,
      token: 'token-someone-elses',
      productId: 'standard.sub',
    );
    await Future<void>.delayed(Duration.zero);

    // Still waiting, and the stray purchase was recorded on its own merits.
    expect(backend.tokensSeen, contains('token-someone-elses'));

    store.emit(StorePurchaseStatus.purchased, token: 'token-mine');
    final result = await future;
    expect(result.succeeded, isTrue);
    expect(store.completed, contains('token-mine'));
  });

  test('granted distinguishes a delivery from a redelivery', () async {
    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.purchased);
    final result = await future;

    // Without this the caller cannot tell "your gems are credited" from
    // "nothing was delivered", and both arrive as a success.
    expect(result.delivered, isTrue);
    expect(result.grantResult, {'balance': 500});
  });

  test('a settling error does not beat the recording it is racing', () async {
    // The real sequence, which cost two wrong fixes to pin down. Play publishes
    // its notification in milliseconds, the server consumes, the plugin's own
    // consume then fails with "you do not own this", and that error arrives
    // while the device is still waiting on its own verify call.
    backend.blockVerify = Completer<void>();

    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);

    store.emit(StorePurchaseStatus.purchased);
    await Future<void>.delayed(Duration.zero);

    // The settling failure, arriving mid-record.
    store.emit(StorePurchaseStatus.error, token: 'token-1');
    await Future<void>.delayed(Duration.zero);

    backend.blockVerify!.complete();
    final result = await future;

    // The recording knows the truth; the settling error is noise.
    expect(result.outcome, PurchaseOutcome.purchased);
    expect(result.grantResult, {'balance': 500});
  });

  test('a settling error after delivery is not a failure either', () async {
    final future = tollgate.purchase(_product);
    await Future<void>.delayed(Duration.zero);
    store.emit(StorePurchaseStatus.purchased);
    expect((await future).succeeded, isTrue);

    // Arriving after everything is done, with nothing waiting on it.
    store.emit(StorePurchaseStatus.error, token: 'token-1');
    await Future<void>.delayed(Duration.zero);
    // Nothing to assert beyond not throwing and not undoing the success.
    expect(tollgate.isActive('premium'), isTrue);
  });

  test('a store that refuses to open the flow fails instead of hanging', () async {
    // Play declines for something already owned and then reports nothing at
    // all, so a caller that waits on the stream waits for ever, which is what a
    // permanently spinning button is.
    store.refuseBuy = true;
    final result = await tollgate.purchase(_product);

    expect(result.outcome, PurchaseOutcome.failed);
    expect(result.message, contains('already own'));
  });
}
