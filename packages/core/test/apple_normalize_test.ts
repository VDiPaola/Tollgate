/**
 * Apple's payloads, translated.
 *
 * Every case here is a decision that costs somebody something when it is wrong:
 * cutting off a customer Apple is still covering, serving one it has stopped
 * covering, or telling a paying customer their subscription is ending.
 */

import { assertEquals } from '@std/assert';

import {
  kindOf,
  normalizeTransaction,
  offerTypeOf,
  subscriptionStatus,
} from '../src/adapters/apple/normalize.ts';
import type {
  AppleRenewalInfo,
  AppleTransactionInfo,
} from '../src/adapters/apple/types.ts';

const PURCHASED = Date.parse('2026-08-01T10:00:00.000Z');
const EXPIRES = Date.parse('2026-09-01T10:00:00.000Z');

function subscription(
  over: Partial<AppleTransactionInfo> = {},
): AppleTransactionInfo {
  return {
    transactionId: '2000000000000002',
    originalTransactionId: '2000000000000001',
    bundleId: 'com.example.app',
    productId: 'premium.monthly',
    type: 'Auto-Renewable Subscription',
    purchaseDate: PURCHASED,
    originalPurchaseDate: PURCHASED,
    expiresDate: EXPIRES,
    quantity: 1,
    inAppOwnershipType: 'PURCHASED',
    appAccountToken: '11111111-1111-4111-8111-111111111111',
    environment: 'Production',
    price: 9990,
    currency: 'GBP',
    ...over,
  };
}

function renewal(over: Partial<AppleRenewalInfo> = {}): AppleRenewalInfo {
  return {
    originalTransactionId: '2000000000000001',
    autoRenewProductId: 'premium.monthly',
    autoRenewStatus: 1,
    ...over,
  };
}

Deno.test('an active subscription carries its ids, price and expiry across', () => {
  const p = normalizeTransaction(subscription(), {
    environment: 'production',
    status: 1,
    renewal: renewal(),
  });

  assertEquals(p.store, 'apple');
  // Per-renewal, so each billing period gets its own row.
  assertEquals(p.storeTransactionId, '2000000000000002');
  // Stable across renewals, which is what notifications name.
  assertEquals(p.originalTransactionId, '2000000000000001');
  assertEquals(p.storeProductId, 'premium.monthly');
  assertEquals(p.kind, 'subscription');
  assertEquals(p.status, 'active');
  assertEquals(p.willRenew, true);
  assertEquals(p.expiresAt, new Date(EXPIRES).toISOString());
  assertEquals(p.purchasedAt, new Date(PURCHASED).toISOString());
  assertEquals(p.appAccountToken, '11111111-1111-4111-8111-111111111111');
  // Apple reports milliunits, Tollgate stores micros.
  assertEquals(p.priceAmountMicros, 9_990_000);
  assertEquals(p.priceCurrency, 'gbp');
  assertEquals(p.revokedAt, null);
});

Deno.test('renewal turned off is cancelled, not expired', () => {
  const p = normalizeTransaction(subscription(), {
    environment: 'production',
    status: 1,
    renewal: renewal({ autoRenewStatus: 0 }),
  });

  // Still paid for until the expiry. Reading this as the end of access is the
  // commonest way to take somebody's money and then take the thing they bought.
  assertEquals(p.status, 'canceled');
  assertEquals(p.willRenew, false);
  assertEquals(p.expiresAt, new Date(EXPIRES).toISOString());
});

Deno.test('billing retry stops access and a billing grace period does not', () => {
  const retry = normalizeTransaction(subscription(), {
    environment: 'production',
    status: 3,
    renewal: renewal({ isInBillingRetryPeriod: true }),
  });
  assertEquals(retry.status, 'on_hold');

  const graceEnds = Date.parse('2026-09-17T10:00:00.000Z');
  const grace = normalizeTransaction(subscription(), {
    environment: 'production',
    status: 4,
    renewal: renewal({
      isInBillingRetryPeriod: true,
      gracePeriodExpiresDate: graceEnds,
    }),
  });
  assertEquals(grace.status, 'grace');
  // The end of the grace Apple is granting, not the paid period that has
  // already run out. Apple's grace can run to sixteen days, far longer than the
  // slack the database applies to a store that has simply gone quiet.
  assertEquals(grace.expiresAt, new Date(graceEnds).toISOString());
});

Deno.test('a revocation outranks whatever the subscription status says', () => {
  const revoked = Date.parse('2026-08-15T09:00:00.000Z');
  const p = normalizeTransaction(
    subscription({ revocationDate: revoked, revocationReason: 1 }),
    { environment: 'production', status: 1, renewal: renewal() },
  );

  assertEquals(p.status, 'revoked');
  assertEquals(p.revokedAt, new Date(revoked).toISOString());
});

Deno.test('a status Apple has not published yet grants nothing', () => {
  assertEquals(subscriptionStatus(99, renewal()), 'pending');
  assertEquals(subscriptionStatus(undefined, undefined), 'pending');
});

Deno.test('a subscription with no renewal info is assumed to renew', () => {
  // The alternative is telling a paying customer their subscription is ending
  // because one of the two payloads was missing.
  const p = normalizeTransaction(subscription(), {
    environment: 'production',
    status: 1,
  });
  assertEquals(p.willRenew, true);

  const expired = normalizeTransaction(subscription(), {
    environment: 'production',
    status: 2,
  });
  assertEquals(expired.willRenew, false);
});

Deno.test('a consumable is active, unexpiring and counted', () => {
  const p = normalizeTransaction(
    subscription({
      type: 'Consumable',
      productId: 'gems.1',
      quantity: 3,
      expiresDate: undefined,
      transactionId: '3000000000000001',
      originalTransactionId: '3000000000000001',
    }),
    { environment: 'production' },
  );

  assertEquals(p.kind, 'consumable');
  assertEquals(p.status, 'active');
  assertEquals(p.expiresAt, null);
  assertEquals(p.willRenew, false);
  assertEquals(p.quantity, 3);
});

Deno.test('a non-renewing subscription keeps its expiry', () => {
  const p = normalizeTransaction(
    subscription({ type: 'Non-Renewing Subscription' }),
    { environment: 'production' },
  );

  // Bought once and never renewed, so it is a one-time purchase. It does run
  // out, and that date is the only thing that ends it.
  assertEquals(p.kind, 'non_consumable');
  assertEquals(p.expiresAt, new Date(EXPIRES).toISOString());
  assertEquals(p.willRenew, false);
});

Deno.test('Apple states the product kind outright, unlike Play', () => {
  assertEquals(kindOf('Auto-Renewable Subscription'), 'subscription');
  assertEquals(kindOf('Consumable'), 'consumable');
  assertEquals(kindOf('Non-Consumable'), 'non_consumable');
  assertEquals(kindOf('Non-Renewing Subscription'), 'non_consumable');
  assertEquals(kindOf(undefined), undefined);
});

Deno.test('only the discount type tells a free trial from a cheap first month', () => {
  assertEquals(
    offerTypeOf(subscription({ offerType: 1, offerDiscountType: 'FREE_TRIAL' })),
    'trial',
  );
  assertEquals(
    offerTypeOf(subscription({ offerType: 1, offerDiscountType: 'PAY_UP_FRONT' })),
    'intro',
  );
  assertEquals(offerTypeOf(subscription({ offerType: 2 })), 'promo');
  assertEquals(offerTypeOf(subscription({ offerType: 3 })), 'promo');
  assertEquals(offerTypeOf(subscription()), 'none');
});

Deno.test('a payload that does not name its environment takes the host it came from', () => {
  const stated = normalizeTransaction(
    subscription({ environment: 'Sandbox' }),
    { environment: 'production', status: 1 },
  );
  assertEquals(stated.environment, 'sandbox');

  // Sandbox and production are separate hosts holding separate transactions, so
  // whichever one answered is the truthful fallback. Defaulting to production
  // would hand the paid product to anybody with a simulator.
  const silent = normalizeTransaction(
    subscription({ environment: undefined }),
    { environment: 'sandbox', status: 1 },
  );
  assertEquals(silent.environment, 'sandbox');
});
