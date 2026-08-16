/**
 * Play's payloads, translated.
 *
 * Every fixture is shaped like a real Play Developer API response. Pure
 * functions, so none of this needs credentials, a network, or a device.
 */

import { assert, assertEquals } from '@std/assert';

import {
  moneyToMicros,
  normalizeProduct,
  normalizeSubscription,
  productStatus,
  subscriptionStatus,
} from '../src/adapters/google/normalize.ts';
import type {
  ProductPurchase,
  SubscriptionPurchaseV2,
} from '../src/adapters/google/types.ts';
import { purchaseEntitles } from '../src/types.ts';

const TOKEN = 'kjadfhkjasdhf.AO-J1Oxxxxxxxxxxxxxxxxxxxxxxx';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

function subscription(
  over: Partial<SubscriptionPurchaseV2> = {},
): SubscriptionPurchaseV2 {
  return {
    startTime: '2026-08-01T10:00:00.000Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: 'GPA.3355-1234-5678-90123',
    regionCode: 'GB',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: ACCOUNT },
    lineItems: [{
      productId: 'premium',
      expiryTime: '2026-09-01T10:00:00.000Z',
      offerDetails: { basePlanId: 'monthly' },
      autoRenewingPlan: {
        autoRenewEnabled: true,
        recurringPrice: { currencyCode: 'GBP', units: '5', nanos: 990000000 },
      },
    }],
    ...over,
  };
}

Deno.test('an active subscription normalizes completely', () => {
  const p = normalizeSubscription(subscription(), { purchaseToken: TOKEN });

  assertEquals(p.store, 'google');
  assertEquals(p.kind, 'subscription');
  assertEquals(p.status, 'active');
  assertEquals(p.storeProductId, 'premium');
  assertEquals(p.basePlanId, 'monthly');
  assertEquals(p.expiresAt, '2026-09-01T10:00:00.000Z');
  assert(p.willRenew);
  assertEquals(p.appAccountToken, ACCOUNT);
  assertEquals(p.environment, 'production');
  assert(purchaseEntitles(p, new Date('2026-08-15T00:00:00Z')));
});

Deno.test('the token is the original id and the order id is the transaction', () => {
  const p = normalizeSubscription(subscription(), { purchaseToken: TOKEN });

  // The token survives renewals and is what every notification names, so it is
  // what alias lookups key on. The order id changes each period, which is what
  // gives each renewal its own row.
  assertEquals(p.originalTransactionId, TOKEN);
  assertEquals(p.storeTransactionId, 'GPA.3355-1234-5678-90123');

  const renewed = normalizeSubscription(
    subscription({ latestOrderId: 'GPA.3355-1234-5678-90123..0' }),
    { purchaseToken: TOKEN },
  );
  assertEquals(renewed.originalTransactionId, TOKEN);
  assert(renewed.storeTransactionId !== p.storeTransactionId);
});

Deno.test('a subscription with no order id still records, keyed on the token', () => {
  const p = normalizeSubscription(
    subscription({ latestOrderId: undefined }),
    { purchaseToken: TOKEN },
  );
  // Collapsing to one row that gets updated in place is a worse record than one
  // row per period, and a far better outcome than dropping the purchase.
  assertEquals(p.storeTransactionId, TOKEN);
  assertEquals(p.originalTransactionId, TOKEN);
});

Deno.test('every Play subscription state maps somewhere deliberate', () => {
  const cases: Array<[string, string, boolean]> = [
    // state, normalized, whether it should still entitle
    ['SUBSCRIPTION_STATE_ACTIVE', 'active', true],
    ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'grace', true],
    ['SUBSCRIPTION_STATE_CANCELED', 'canceled', true],
    ['SUBSCRIPTION_STATE_ON_HOLD', 'on_hold', false],
    ['SUBSCRIPTION_STATE_PAUSED', 'paused', false],
    ['SUBSCRIPTION_STATE_EXPIRED', 'expired', false],
    ['SUBSCRIPTION_STATE_PENDING', 'pending', false],
    ['SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', 'expired', false],
    ['SUBSCRIPTION_STATE_UNSPECIFIED', 'pending', false],
    ['SOMETHING_GOOGLE_ADDS_LATER', 'pending', false],
  ];

  for (const [state, expected, entitles] of cases) {
    assertEquals(subscriptionStatus(state), expected, state);
    const p = normalizeSubscription(
      subscription({ subscriptionState: state as never }),
      { purchaseToken: TOKEN },
    );
    assertEquals(
      purchaseEntitles(p, new Date('2026-08-15T00:00:00Z')),
      entitles,
      `${state} should ${entitles ? '' : 'not '}entitle`,
    );
  }
});

Deno.test('a test purchase is marked sandbox, and nothing else is', () => {
  const real = normalizeSubscription(subscription(), { purchaseToken: TOKEN });
  assertEquals(real.environment, 'production');

  // Play sends an empty object here, which is the whole of the signal. Getting
  // this wrong is a free subscription for anyone who can run a test device.
  const test = normalizeSubscription(
    subscription({ testPurchase: {} }),
    { purchaseToken: TOKEN },
  );
  assertEquals(test.environment, 'sandbox');
});

Deno.test('units and nanos become micros', () => {
  assertEquals(moneyToMicros({ units: '5', nanos: 990000000 }), 5_990_000);
  assertEquals(moneyToMicros({ units: '0', nanos: 990000000 }), 990_000);
  assertEquals(moneyToMicros({ units: '1200' }), 1_200_000_000);
  assertEquals(moneyToMicros(undefined), null);

  const p = normalizeSubscription(subscription(), { purchaseToken: TOKEN });
  assertEquals(p.priceAmountMicros, 5_990_000);
  assertEquals(p.priceCurrency, 'gbp');
});

Deno.test('an offer is reported without changing what is granted', () => {
  const trial = normalizeSubscription(
    subscription({
      lineItems: [{
        productId: 'premium',
        expiryTime: '2026-09-01T10:00:00.000Z',
        offerDetails: { basePlanId: 'monthly', offerId: 'welcome', offerTags: ['free-trial'] },
        autoRenewingPlan: { autoRenewEnabled: true },
      }],
    }),
    { purchaseToken: TOKEN },
  );
  assertEquals(trial.offerType, 'trial');
  assertEquals(trial.status, 'active');
  assert(purchaseEntitles(trial, new Date('2026-08-15T00:00:00Z')));
});

// --- one-time products ------------------------------------------------------

function product(over: Partial<ProductPurchase> = {}): ProductPurchase {
  return {
    productId: 'gems_500',
    orderId: 'GPA.3355-9999-8888-77777',
    purchaseTimeMillis: '1786000000000',
    purchaseState: 0,
    consumptionState: 0,
    acknowledgementState: 0,
    quantity: 1,
    obfuscatedExternalAccountId: ACCOUNT,
    ...over,
  };
}

Deno.test('a settled one-time purchase normalizes as active', () => {
  const p = normalizeProduct(product(), {
    purchaseToken: TOKEN,
    productId: 'gems_500',
    consumable: true,
  });

  assertEquals(p.kind, 'consumable');
  assertEquals(p.status, 'active');
  assertEquals(p.storeTransactionId, 'GPA.3355-9999-8888-77777');
  assertEquals(p.expiresAt, null);
  assertEquals(p.willRenew, false);
  assertEquals(p.appAccountToken, ACCOUNT);
});

Deno.test('a pending one-time purchase grants nothing yet', () => {
  // The slow test card, and the real thing behind it: a buyer who chose a
  // payment method that takes days. Delivering here hands over goods nobody
  // has paid for.
  assertEquals(productStatus({ purchaseState: 2 }), 'pending');
  const p = normalizeProduct(product({ purchaseState: 2 }), {
    purchaseToken: TOKEN,
    productId: 'gems_500',
    consumable: true,
  });
  assertEquals(p.status, 'pending');
});

Deno.test('purchaseType 0 means test, and absent means real', () => {
  // The trap: 0 is falsy, so a truthiness check reads every real purchase as a
  // test one and grants nothing to anybody who actually paid.
  const real = normalizeProduct(product(), {
    purchaseToken: TOKEN,
    productId: 'gems_500',
    consumable: true,
  });
  assertEquals(real.environment, 'production');

  const test = normalizeProduct(product({ purchaseType: 0 }), {
    purchaseToken: TOKEN,
    productId: 'gems_500',
    consumable: true,
  });
  assertEquals(test.environment, 'sandbox');

  const promo = normalizeProduct(product({ purchaseType: 1 }), {
    purchaseToken: TOKEN,
    productId: 'gems_500',
    consumable: true,
  });
  assertEquals(promo.environment, 'production');
  assertEquals(promo.offerType, 'promo');
});

Deno.test('quantity survives, because a consumable can be bought in multiples', () => {
  const p = normalizeProduct(product({ quantity: 3 }), {
    purchaseToken: TOKEN,
    productId: 'gems_500',
    consumable: true,
  });
  assertEquals(p.quantity, 3);
});
