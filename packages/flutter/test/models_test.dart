// Wire-format parsing, which is where a shape disagreement between the server
// and the SDK's own core turned into a cast error at startup.

import 'package:flutter_test/flutter_test.dart';
import 'package:tollgate/tollgate.dart';

void main() {
  const row = {
    'key': 'premium',
    'active': true,
    'store': 'google',
    'willRenew': true,
    'expiresAt': '2026-09-16T10:00:00.000Z',
  };

  test('entitlements parse from an array', () {
    final list = entitlementsFrom([row]);
    expect(list.single.key, 'premium');
    expect(list.single.active, isTrue);
    expect(list.single.store, TollgateStore.google);
  });

  test('entitlements parse from a keyed map', () {
    // The shape core holds them in. Read leniently because the punishment for
    // a mismatch is a paying customer locked out at startup.
    final list = entitlementsFrom({'premium': row});
    expect(list.single.key, 'premium');
  });

  test('missing or unreadable entitlements are empty, not fatal', () {
    expect(entitlementsFrom(null), isEmpty);
    expect(entitlementsFrom('nonsense'), isEmpty);
  });

  test('a customer parses with entitlements in either shape', () {
    const base = {
      'userId': 'u',
      'appAccountToken': '11111111-1111-4111-8111-111111111111',
    };
    final fromList = CustomerInfo.fromJson({...base, 'entitlements': [row]});
    final fromMap = CustomerInfo.fromJson({
      ...base,
      'entitlements': {'premium': row},
    });

    expect(fromList.isActive('premium'), isTrue);
    expect(fromMap.isActive('premium'), isTrue);
    expect(CustomerInfo.fromJson(base).entitlements, isEmpty);
  });

  test('lapsing means paid up but not renewing', () {
    final renewing = Entitlement.fromJson(row);
    expect(renewing.lapsing, isFalse);

    final ending = Entitlement.fromJson({...row, 'willRenew': false});
    expect(ending.active, isTrue);
    expect(ending.lapsing, isTrue);
  });
}
