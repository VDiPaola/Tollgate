/**
 * The vocabulary every store is translated into.
 *
 * Nothing downstream of an adapter should ever see an Apple status code, a
 * Google `subscriptionState`, or a Stripe subscription status. If a concept
 * only exists on one store, it either maps onto something here or it is
 * deliberately dropped, and the reason is written down at the mapping site.
 */

/** A payment processor Tollgate can take money through. */
export type StoreId = 'apple' | 'google' | 'stripe' | 'fake';

export const STORE_IDS: readonly StoreId[] = [
  'apple',
  'google',
  'stripe',
  'fake',
];

/**
 * What kind of thing was bought.
 *
 * `consumable` is the only kind that delivers something through a hook and can
 * be bought again; the other two grant an entitlement and cannot.
 */
export type ProductKind = 'subscription' | 'consumable' | 'non_consumable';

/**
 * Where a purchase stands right now.
 *
 * The split that matters is between `grace` and `on_hold`: both mean a renewal
 * payment failed, but a store in grace still wants the customer to have what
 * they paid for while it retries, and a store on hold does not. Collapsing the
 * two loses the only piece of information that decides whether to keep serving
 * somebody.
 *
 * - `pending`   payment started but not settled (Google deferred/pending
 *               purchases, an incomplete Stripe subscription). Grants nothing.
 * - `active`    paid and current.
 * - `grace`     renewal failed, store is retrying, access continues.
 * - `on_hold`   renewal failed, store is retrying, access stops.
 * - `paused`    the customer paused it themselves (Google only). Access stops.
 * - `canceled`  will not renew, but the paid period has not run out yet, so
 *               access continues until `expiresAt`.
 * - `expired`   ran out.
 * - `revoked`   refunded, charged back, or pulled by the store. Access stops
 *               immediately, whatever `expiresAt` says.
 */
export type PurchaseStatus =
  | 'pending'
  | 'active'
  | 'grace'
  | 'on_hold'
  | 'paused'
  | 'canceled'
  | 'expired'
  | 'revoked';

export const PURCHASE_STATUSES: readonly PurchaseStatus[] = [
  'pending',
  'active',
  'grace',
  'on_hold',
  'paused',
  'canceled',
  'expired',
  'revoked',
];

/**
 * Whether this came from the store's real money system or its test one.
 *
 * Carried all the way into the database because a sandbox purchase that grants
 * production entitlement is a free subscription for anyone who can run a
 * simulator, and the two are told apart by nothing but this field.
 */
export type Environment = 'production' | 'sandbox';

/** Discounted first period, if any. Reporting only; it grants the same thing. */
export type OfferType = 'none' | 'trial' | 'intro' | 'promo';

/**
 * A purchase as Tollgate understands it, whichever store it came from.
 *
 * This is the adapter contract's output and the database's input, so it is the
 * one shape that has to be right.
 */
export interface NormalizedPurchase {
  store: StoreId;

  /**
   * This exact transaction, unique within the store.
   *
   * Together with `store` this is the idempotency key: the database has a
   * unique constraint on the pair, and every write path is an upsert onto it.
   * A notification arriving twice, a client retrying, and a webhook racing a
   * direct verification all converge on one row because of this field.
   *
   * Apple gives a `transactionId` per renewal. Google gives an `orderId`.
   * Stripe gives an invoice or payment intent id.
   */
  storeTransactionId: string;

  /**
   * The subscription this transaction belongs to, stable across renewals.
   *
   * Apple's `originalTransactionId`, Google's purchase token, Stripe's
   * subscription id. For a one-off purchase it is the same as
   * `storeTransactionId`. This is what a notification about "the subscription"
   * names, so it is also what alias lookups key on.
   */
  originalTransactionId: string;

  /** The store's own SKU, as configured in App Store Connect / Play / Stripe. */
  storeProductId: string;

  /**
   * Google subscriptions sell a product through one of several base plans, and
   * the plan is what carries the price and period. Null on stores that have no
   * such concept.
   */
  basePlanId?: string | null;

  kind: ProductKind;
  status: PurchaseStatus;
  environment: Environment;
  offerType: OfferType;

  /** ISO 8601. When the customer first paid for this transaction. */
  purchasedAt: string;

  /** ISO 8601, or null for something that never expires. */
  expiresAt: string | null;

  /** Whether the store currently intends to bill again. */
  willRenew: boolean;

  /** ISO 8601. Set when the store says the purchase was pulled back. */
  revokedAt?: string | null;

  /** Consumables can be bought in multiples in one transaction. */
  quantity: number;

  /**
   * The UUID the app attached at purchase time, and the only thing tying an
   * Apple or Google transaction to a user.
   *
   * Neither store knows who your users are. Apple carries it as
   * `appAccountToken`, Google as `obfuscatedAccountId`, and if the app did not
   * set one then a renewal notification arriving two years later names a
   * transaction and nothing else. Tollgate mints one per customer and requires
   * adapters to send it.
   */
  appAccountToken: string | null;

  /** What the store charged, in millionths of a unit. Reporting only. */
  priceAmountMicros?: number | null;

  /** ISO 4217, lowercased. Null when the store did not say. */
  priceCurrency?: string | null;

  /** The verified store payload this was read from, kept for replay and audit. */
  raw?: unknown;
}

/** Enough to name a purchase to a store when asking it for fresh state. */
export interface PurchaseRef {
  store: StoreId;
  storeTransactionId?: string;
  originalTransactionId: string;
  storeProductId?: string;
  basePlanId?: string | null;
  /**
   * What kind of thing this is, when it is known.
   *
   * Not decoration: Google splits subscriptions and one-time products across
   * two API resources with different URL shapes, so a token alone is not
   * enough to ask about. Undefined means the caller does not know, and the
   * adapter picks whichever lookup can work without it.
   */
  kind?: ProductKind;
}

/** One entitlement's current state for one customer. */
export interface Entitlement {
  key: string;
  active: boolean;
  store: StoreId | null;
  productId: string | null;
  periodStart: string | null;
  expiresAt: string | null;
  willRenew: boolean;
  inGracePeriod: boolean;
  /** When the customer was first seen to have turned off renewal. */
  unsubscribeDetectedAt: string | null;
  /** When a renewal payment was first seen to be failing. */
  billingIssueDetectedAt: string | null;
}

/** Everything the client needs to know about who this customer is to us. */
export interface CustomerInfo {
  userId: string;
  /** Attach this to purchases so store notifications can find their way home. */
  appAccountToken: string;
  entitlements: Record<string, Entitlement>;
  /** Set when a refund or chargeback has been recorded against them. */
  flaggedAt: string | null;
  flagReason: string | null;
}

/** A store SKU and what it means to this app. */
export interface ProductMapping {
  productId: string;
  kind: ProductKind;
  entitlementKey: string | null;
  grantPayload: unknown | null;
  store: StoreId;
  storeProductId: string;
  basePlanId: string | null;
}

/**
 * Whether an entitlement should currently be granted on the strength of this
 * purchase alone, ignoring the grace window the database applies on top.
 *
 * Kept here as well as in SQL because adapters and tests reason about a single
 * purchase, while the database reasons about all of a customer's purchases at
 * once. The SQL is authoritative; this must agree with it.
 */
export function purchaseEntitles(
  p: Pick<NormalizedPurchase, 'status' | 'expiresAt' | 'revokedAt'>,
  now: Date = new Date(),
): boolean {
  if (p.revokedAt) return false;
  if (p.status === 'active' || p.status === 'grace') return true;
  // A cancelled subscription is still paid for until its period runs out.
  // Treating cancellation as immediate loss is the single most common way to
  // take somebody's money and then take the thing they bought.
  if (p.status === 'canceled') {
    return p.expiresAt == null || new Date(p.expiresAt) > now;
  }
  return false;
}
