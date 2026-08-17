/**
 * Stripe's account of a purchase, translated.
 *
 * Pure functions, so the mapping can be tested against recorded API payloads
 * with no network and no keys.
 */

import type { NormalizedPurchase, PurchaseStatus } from '../../types.ts';
import type {
  StripePaymentIntent,
  StripeSubscription,
  StripeSubscriptionItem,
  StripeSubscriptionStatus,
} from './types.ts';

/**
 * Stripe's subscription statuses, mapped onto Tollgate's.
 *
 * The two judgement calls:
 *
 * `past_due` is grace rather than on_hold. Stripe keeps retrying and the
 * subscription is still the customer's; cutting access at the first failed
 * renewal punishes an expired card harder than Google or Apple would.
 *
 * `unpaid` is on_hold. It is where Stripe puts a subscription once it has given
 * up retrying, so access stops but the record stays.
 */
export function subscriptionStatus(
  status: StripeSubscriptionStatus | string | undefined,
): PurchaseStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'grace';
    case 'unpaid':
      return 'on_hold';
    case 'paused':
      return 'paused';
    case 'canceled':
      // Stripe reports a cancelled subscription this way whether the paid
      // period has run out or not, so the expiry decides, not this.
      return 'canceled';
    case 'incomplete':
      return 'pending';
    case 'incomplete_expired':
      return 'expired';
    default:
      return 'pending';
  }
}

/**
 * When the paid period ends.
 *
 * Stripe moved this from the subscription onto its items, and both shapes are
 * in the wild depending on the pinned API version. Read either, item first.
 */
export function subscriptionPeriodEnd(
  sub: StripeSubscription,
): string | null {
  const item = sub.items?.data?.[0];
  const seconds = item?.current_period_end ?? sub.current_period_end ?? null;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function seconds(value: number | undefined | null): string | null {
  return value ? new Date(value * 1000).toISOString() : null;
}

function idOf(value: string | { id?: string } | undefined): string | null {
  if (typeof value === 'string') return value;
  return value?.id ?? null;
}

export interface StripeContext {
  /**
   * The metadata key carrying the Tollgate account token, on the object or its
   * customer. Stripe has no notion of an app's users, so this is how a
   * subscription is tied to one.
   */
  accountTokenKey: string;
  /**
   * The metadata key naming which product was bought, for payments that are not
   * tied to a Price: a one-off charge for a gem pack carries an amount and
   * nothing about what it was for.
   */
  productKey: string;
  /** Read from the customer when the object itself does not carry it. */
  customerMetadata?: Record<string, string>;
}

/**
 * A Stripe subscription as a [NormalizedPurchase].
 *
 * The subscription id is the original transaction, stable for the life of the
 * subscription. The latest invoice is the transaction, changing every period,
 * which is what gives each billing period its own row exactly as a Google
 * order id or an Apple transaction id does.
 */
export function normalizeSubscription(
  sub: StripeSubscription,
  ctx: StripeContext,
): NormalizedPurchase {
  const item: StripeSubscriptionItem | undefined = sub.items?.data?.[0];
  const status = subscriptionStatus(sub.status);
  const metadata = { ...ctx.customerMetadata, ...sub.metadata };

  return {
    store: 'stripe',
    storeTransactionId: idOf(sub.latest_invoice) ?? sub.id ?? '',
    originalTransactionId: sub.id ?? '',
    storeProductId: item?.price?.id ?? '',
    basePlanId: null,
    kind: 'subscription',
    status,
    // Stripe's test mode is a genuinely separate environment with its own keys
    // and its own data, unlike Google's. `livemode` is how an object says which
    // one it came from.
    environment: sub.livemode === false ? 'sandbox' : 'production',
    offerType: sub.trial_end ? 'trial' : 'none',
    purchasedAt: seconds(sub.start_date ?? sub.created) ??
      new Date().toISOString(),
    expiresAt: subscriptionPeriodEnd(sub),
    // A subscription set to cancel at period end is still paid for, and still
    // reports `active`. What it will not do is renew.
    willRenew: !sub.cancel_at_period_end &&
      (status === 'active' || status === 'grace'),
    revokedAt: null,
    quantity: 1,
    appAccountToken: metadata[ctx.accountTokenKey] ?? null,
    priceAmountMicros: item?.price?.unit_amount != null
      ? item.price.unit_amount * 10_000
      : null,
    priceCurrency: item?.price?.currency?.toLowerCase() ?? null,
    raw: sub,
  };
}

/**
 * A Stripe payment intent as a [NormalizedPurchase].
 *
 * Used for anything bought once. Stripe does not require a one-off payment to
 * reference a Price, and the common case here does not: an amount worked out
 * server-side, with metadata saying what it was for. So the product comes from
 * metadata rather than from the object.
 */
export function normalizePaymentIntent(
  intent: StripePaymentIntent,
  ctx: StripeContext,
): NormalizedPurchase {
  const metadata = { ...ctx.customerMetadata, ...intent.metadata };

  return {
    store: 'stripe',
    // A one-off payment is its own original: there is nothing for it to renew
    // from and nothing that renews from it.
    storeTransactionId: intent.id ?? '',
    originalTransactionId: intent.id ?? '',
    storeProductId: metadata[ctx.productKey] ?? '',
    basePlanId: null,
    // Corrected from the catalogue when recorded; Stripe has no idea whether
    // what it just charged for gets used up.
    kind: 'non_consumable',
    status: intent.status === 'succeeded'
      ? 'active'
      // Everything else is money that has not arrived: awaiting a payment
      // method, awaiting the customer, or being processed by a slow method.
      // Delivering on any of those hands over goods nobody has paid for.
      : intent.status === 'canceled'
      ? 'expired'
      : 'pending',
    environment: intent.livemode === false ? 'sandbox' : 'production',
    offerType: 'none',
    purchasedAt: seconds(intent.created) ?? new Date().toISOString(),
    expiresAt: null,
    willRenew: false,
    revokedAt: null,
    quantity: 1,
    appAccountToken: metadata[ctx.accountTokenKey] ?? null,
    priceAmountMicros: intent.amount != null ? intent.amount * 10_000 : null,
    priceCurrency: intent.currency?.toLowerCase() ?? null,
    raw: intent,
  };
}
