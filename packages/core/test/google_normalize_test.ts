/**
 * Play's payloads, translated.
 *
 * Every fixture is shaped like a real Play Developer API response. Pure
 * functions, so none of this needs credentials, a network, or a device.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';

import {
  moneyToMicros,
  normalizeProduct,
  normalizeSubscription,
  productStatus,
  subscriptionStatus,
} from '../src/adapters/google/normalize.ts';
import type {
  ProductPurchaseV2,
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
        offerDetails: {
          basePlanId: 'monthly',
          offerId: 'welcome',
          offerTags: ['free-trial'],
        },
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
//
// Read through `purchases.productsv2`, the shape Billing 8 produces. Almost
// nothing sits where the v1 response put it: the product id moved into a line
// item, the purchase state into a context object, quantity and consumption
// state under the line item's offer details, and the test flag from a
// falsy-zero enum to the presence of an object.

function product(over: Partial<ProductPurchaseV2> = {}): ProductPurchaseV2 {
  return {
    orderId: 'GPA.3355-9999-8888-77777',
    purchaseCompletionTime: '2026-08-16T09:00:00.000Z',
    purchaseStateContext: { purchaseState: 'PURCHASED' },
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    obfuscatedExternalAccountId: ACCOUNT,
    productLineItem: [{
      productId: 'gems_500',
      productOfferDetails: {
        quantity: 1,
        consumptionState: 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED',
      },
    }],
    ...over,
  };
}

const gems = { purchaseToken: TOKEN, consumable: true };

Deno.test('a settled one-time purchase normalizes as active', () => {
  const p = normalizeProduct(product(), gems);

  assertEquals(p.kind, 'consumable');
  assertEquals(p.status, 'active');
  assertEquals(p.storeProductId, 'gems_500');
  assertEquals(p.storeTransactionId, 'GPA.3355-9999-8888-77777');
  assertEquals(p.originalTransactionId, TOKEN);
  assertEquals(p.purchasedAt, '2026-08-16T09:00:00.000Z');
  assertEquals(p.expiresAt, null);
  assertEquals(p.willRenew, false);
  assertEquals(p.appAccountToken, ACCOUNT);
});

Deno.test('every one-time purchase state maps somewhere deliberate', () => {
  assertEquals(productStatus('PURCHASED'), 'active');
  // The slow test card, and the real thing behind it: a buyer who chose a
  // payment method that takes days. Delivering here hands over goods nobody
  // has paid for.
  assertEquals(productStatus('PENDING'), 'pending');
  assertEquals(productStatus('CANCELLED'), 'expired');
  assertEquals(productStatus('PURCHASE_STATE_UNSPECIFIED'), 'pending');
  assertEquals(productStatus(undefined), 'pending');
});

Deno.test('a pending one-time purchase grants nothing yet', () => {
  const p = normalizeProduct(
    product({ purchaseStateContext: { purchaseState: 'PENDING' } }),
    gems,
  );
  assertEquals(p.status, 'pending');
  assertFalse(purchaseEntitles(p, new Date('2026-08-16T12:00:00Z')));
});

Deno.test('a test purchase is marked sandbox by the presence of a context', () => {
  const real = normalizeProduct(product(), gems);
  assertEquals(real.environment, 'production');

  // v1 signalled this with `purchaseType: 0`, where the trap was that 0 is
  // falsy and a truthiness check read every real purchase as a test one. v2
  // signals it by the object being there at all.
  const test = normalizeProduct(
    product({ testPurchaseContext: { fopType: 'TEST' } }),
    gems,
  );
  assertEquals(test.environment, 'sandbox');
});

Deno.test('quantity comes off the offer, since a consumable sells in multiples', () => {
  const p = normalizeProduct(
    product({
      productLineItem: [{
        productId: 'gems_500',
        productOfferDetails: { quantity: 3 },
      }],
    }),
    gems,
  );
  assertEquals(p.quantity, 3);

  // And defaults to one rather than to nothing when the offer omits it.
  const bare = normalizeProduct(
    product({ productLineItem: [{ productId: 'gems_500' }] }),
    gems,
  );
  assertEquals(bare.quantity, 1);
});

Deno.test('a Billing 8 offer on a one-time product is reported, not acted on', () => {
  const p = normalizeProduct(
    product({
      productLineItem: [{
        productId: 'gems_500',
        productOfferDetails: {
          offerId: 'launch-discount',
          purchaseOptionId: 'standard',
          quantity: 1,
        },
      }],
    }),
    gems,
  );
  assertEquals(p.offerType, 'promo');
  // Whatever it was bought at, it is the same product delivering the same goods.
  assertEquals(p.storeProductId, 'gems_500');
  assertEquals(p.status, 'active');
  // The purchase option shares the base plan slot, because it plays the same
  // part in the mapping: one SKU, several ways to buy it.
  assertEquals(p.basePlanId, 'standard');
});

Deno.test('a purchase option lets two ways of buying one SKU be told apart', () => {
  const small = normalizeProduct(
    product({
      productLineItem: [{
        productId: 'gems',
        productOfferDetails: { purchaseOptionId: 'gems-500', quantity: 1 },
      }],
    }),
    gems,
  );
  const large = normalizeProduct(
    product({
      productLineItem: [{
        productId: 'gems',
        productOfferDetails: { purchaseOptionId: 'gems-5000', quantity: 1 },
      }],
    }),
    gems,
  );

  assertEquals(small.storeProductId, large.storeProductId);
  // Same SKU, different option. Without carrying this, a catalogue could not
  // grant a different number of gems for the two, because nothing downstream
  // would be able to tell them apart.
  assert(small.basePlanId !== large.basePlanId);
  assertEquals(small.basePlanId, 'gems-500');
  assertEquals(large.basePlanId, 'gems-5000');
});

Deno.test('a product sold only one way carries no variant', () => {
  // Which is what makes a null `base_plan_id` row in store_products match it.
  const p = normalizeProduct(product(), gems);
  assertEquals(p.basePlanId, null);
});

Deno.test('a non-consumable is told apart only by the catalogue', () => {
  // Play's response is identical either way. `consumable` comes from the host
  // app's own product table, and it decides consume versus acknowledge.
  const lifetime = normalizeProduct(product(), {
    purchaseToken: TOKEN,
    consumable: false,
  });
  assertEquals(lifetime.kind, 'non_consumable');
});
