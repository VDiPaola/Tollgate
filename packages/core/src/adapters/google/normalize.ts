/**
 * Play's account of a purchase, translated into Tollgate's.
 *
 * Pure functions, separated from the adapter so the mapping can be tested
 * against recorded API payloads with no network and no credentials. This is
 * where every Google-specific decision is written down.
 */

import type {
  NormalizedPurchase,
  PurchaseStatus,
} from '../../types.ts';
import type {
  Money,
  ProductPurchase,
  SubscriptionLineItem,
  SubscriptionPurchaseV2,
} from './types.ts';

/**
 * Play's subscription states, mapped onto Tollgate's.
 *
 * The only judgement call is `PENDING_PURCHASE_CANCELED`: a deferred payment
 * that never completed. It maps to `expired` rather than `canceled` because
 * `canceled` in Tollgate means "paid for, running out", and this was never paid
 * for at all.
 */
export function subscriptionStatus(state: string | undefined): PurchaseStatus {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return 'active';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'grace';
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return 'on_hold';
    case 'SUBSCRIPTION_STATE_PAUSED':
      return 'paused';
    case 'SUBSCRIPTION_STATE_CANCELED':
      // Cancelled but not yet expired. Play sends EXPIRED separately when the
      // paid period actually runs out, so treating this as the end of access
      // would take away time somebody has paid for.
      return 'canceled';
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return 'expired';
    case 'SUBSCRIPTION_STATE_PENDING':
      return 'pending';
    case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
      return 'expired';
    default:
      // UNSPECIFIED, or a state added after this was written. Granting nothing
      // is the safe reading, and the raw payload is stored either way.
      return 'pending';
  }
}

/** Play's one-time purchase states, mapped onto Tollgate's. */
export function productStatus(purchase: ProductPurchase): PurchaseStatus {
  switch (purchase.purchaseState) {
    case 0:
      return 'active';
    case 2:
      // A deferred payment: the buyer chose a slow method and the money has
      // not arrived. Delivering here is delivering goods nobody paid for.
      return 'pending';
    case 1:
      return 'expired';
    default:
      return 'pending';
  }
}

/**
 * Google's `Money` as integer micros.
 *
 * Play reports units plus nanos (billionths); Tollgate stores micros
 * (millionths), which is the unit Apple and Stripe both express prices in.
 */
export function moneyToMicros(money: Money | undefined): number | null {
  if (!money) return null;
  const units = money.units ? Number(money.units) : 0;
  const nanos = money.nanos ?? 0;
  if (!Number.isFinite(units)) return null;
  return Math.round(units * 1_000_000 + nanos / 1_000);
}

/** The line item that carries the state. Multi-item subscriptions take the first. */
function primaryLineItem(
  purchase: SubscriptionPurchaseV2,
): SubscriptionLineItem | undefined {
  return purchase.lineItems?.[0];
}

export interface SubscriptionContext {
  /** The token, which is also the id that survives renewals. */
  purchaseToken: string;
  /** From the notification, when the API response does not name the product. */
  fallbackProductId?: string;
}

/**
 * A `SubscriptionPurchaseV2` as a [NormalizedPurchase].
 *
 * Two identifier decisions are made here and both matter downstream:
 *
 * - The **purchase token** is the original transaction id. It survives
 *   renewals, and it is what every notification about this subscription names,
 *   so it is what alias lookups have to key on.
 * - The **latest order id** is the transaction id, which changes each renewal
 *   and so gives each billing period its own row. Play formats it as
 *   `GPA.1234-5678-9012-34567..0` where the suffix counts renewals. When it is
 *   missing the token stands in, which collapses the subscription to one row
 *   that is updated in place rather than losing the purchase entirely.
 */
export function normalizeSubscription(
  purchase: SubscriptionPurchaseV2,
  ctx: SubscriptionContext,
): NormalizedPurchase {
  const item = primaryLineItem(purchase);
  const status = subscriptionStatus(purchase.subscriptionState);
  const offer = item?.offerDetails;

  return {
    store: 'google',
    storeTransactionId: purchase.latestOrderId ?? ctx.purchaseToken,
    originalTransactionId: ctx.purchaseToken,
    storeProductId: item?.productId ?? ctx.fallbackProductId ?? '',
    basePlanId: offer?.basePlanId ?? null,
    kind: 'subscription',
    status,
    // Play has no separate test environment. `testPurchase` is present, as an
    // empty object, only on a license tester's purchase, and it is the only
    // thing distinguishing one from a real sale.
    environment: purchase.testPurchase ? 'sandbox' : 'production',
    offerType: offerType(offer?.offerId, offer?.offerTags),
    purchasedAt: purchase.startTime ?? new Date().toISOString(),
    expiresAt: item?.expiryTime ?? null,
    willRenew: item?.autoRenewingPlan?.autoRenewEnabled === true,
    revokedAt: null,
    quantity: 1,
    appAccountToken:
      purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    priceAmountMicros: moneyToMicros(item?.autoRenewingPlan?.recurringPrice),
    priceCurrency:
      item?.autoRenewingPlan?.recurringPrice?.currencyCode?.toLowerCase() ??
        null,
    raw: purchase,
  };
}

/**
 * Whether a subscription is on a discounted first period.
 *
 * Play does not label offers as trials, so the only signal is that an offer id
 * is attached at all. Reporting only; the entitlement granted is the same.
 */
function offerType(
  offerId: string | undefined,
  tags: string[] | undefined,
): NormalizedPurchase['offerType'] {
  if (!offerId) return 'none';
  const tagged = (tags ?? []).map((t) => t.toLowerCase());
  if (tagged.some((t) => t.includes('trial'))) return 'trial';
  return 'intro';
}

export interface ProductContext {
  purchaseToken: string;
  productId: string;
  /** True when the mapped product is a consumable, which Play does not say. */
  consumable: boolean;
}

/**
 * A `ProductPurchase` as a [NormalizedPurchase].
 *
 * Play does not distinguish consumables from non-consumables; that is a
 * property of how the app treats the product, so it comes from the caller's
 * own catalogue rather than from the API.
 */
export function normalizeProduct(
  purchase: ProductPurchase,
  ctx: ProductContext,
): NormalizedPurchase {
  const purchasedAt = purchase.purchaseTimeMillis
    ? new Date(Number(purchase.purchaseTimeMillis)).toISOString()
    : new Date().toISOString();

  return {
    store: 'google',
    // The order id is per-purchase and is what a refund names. The token stands
    // in when Play omits it, which it does for some promotional grants.
    storeTransactionId: purchase.orderId ?? ctx.purchaseToken,
    originalTransactionId: ctx.purchaseToken,
    storeProductId: purchase.productId ?? ctx.productId,
    basePlanId: null,
    kind: ctx.consumable ? 'consumable' : 'non_consumable',
    status: productStatus(purchase),
    // Absent means an ordinary purchase; 0 specifically means test. Checking
    // for truthiness here would read a real purchase as a test one, because 0
    // is falsy.
    environment: purchase.purchaseType === 0 ? 'sandbox' : 'production',
    offerType: purchase.purchaseType === 1 ? 'promo' : 'none',
    purchasedAt,
    // A one-time purchase does not expire. A consumable is finished by being
    // delivered, which is tracked on the Tollgate row, not by a date.
    expiresAt: null,
    willRenew: false,
    revokedAt: null,
    quantity: purchase.quantity ?? 1,
    appAccountToken: purchase.obfuscatedExternalAccountId ?? null,
    priceAmountMicros: null,
    priceCurrency: null,
    raw: purchase,
  };
}
