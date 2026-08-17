/**
 * Apple's account of a purchase, translated into Tollgate's.
 *
 * Pure functions, separated from the adapter so the mapping can be tested
 * against recorded payloads with no network and no credentials. This is where
 * every Apple-specific decision is written down.
 */

import type {
  Environment,
  NormalizedPurchase,
  OfferType,
  ProductKind,
  PurchaseStatus,
} from '../../types.ts';
import type {
  AppleEnvironmentName,
  AppleRenewalInfo,
  AppleTransactionInfo,
} from './types.ts';

/** Apple's environment names, which are capitalised words rather than flags. */
export function environmentOf(
  name: AppleEnvironmentName | undefined,
  fallback: Environment,
): Environment {
  if (name === 'Sandbox') return 'sandbox';
  if (name === 'Production') return 'production';
  // Absent. The fallback is which host answered, because sandbox and production
  // are separate API hosts holding separate transactions: a payload that came
  // back from the sandbox host is a sandbox payload whatever it says about
  // itself. Defaulting to `production` instead would hand the paid product to
  // anybody with a simulator the day Apple omits the field.
  return fallback;
}

/**
 * What Apple sold, which Apple states outright.
 *
 * Worth noticing how much easier this is than Google, where nothing in the
 * response says whether a one-time product is consumable and the answer has to
 * come from the app's own catalogue.
 *
 * A non-renewing subscription maps to `non_consumable` because it is bought
 * once and does not renew. It does carry an expiry, which is kept, so it stops
 * entitling on its own.
 */
export function kindOf(
  type: AppleTransactionInfo['type'],
): ProductKind | undefined {
  switch (type) {
    case 'Auto-Renewable Subscription':
      return 'subscription';
    case 'Consumable':
      return 'consumable';
    case 'Non-Consumable':
    case 'Non-Renewing Subscription':
      return 'non_consumable';
    default:
      return undefined;
  }
}

/**
 * Apple's subscription status, mapped onto Tollgate's.
 *
 * Two of these are judgement calls:
 *
 * - **3, billing retry** becomes `on_hold` rather than `grace`. Apple is
 *   retrying the payment, but it is explicitly not covering the customer while
 *   it does; that is what status 4 exists to say. Reading 3 as grace serves a
 *   subscription nobody has paid for, for up to sixty days.
 * - **1, active** becomes `canceled` when auto-renew is off. Both mean the same
 *   thing in Tollgate's vocabulary: paid for, running, and ending at the expiry
 *   rather than renewing. Nothing is taken away, because `canceled` entitles
 *   until `expiresAt`.
 */
export function subscriptionStatus(
  status: number | undefined,
  renewal: AppleRenewalInfo | undefined,
): PurchaseStatus {
  switch (status) {
    case 1:
      return renewal?.autoRenewStatus === 0 ? 'canceled' : 'active';
    case 2:
      return 'expired';
    case 3:
      return 'on_hold';
    case 4:
      return 'grace';
    case 5:
      return 'revoked';
    default:
      // A status Apple added after this was written. Granting nothing is the
      // safe reading, and the raw payload is stored either way.
      return 'pending';
  }
}

/**
 * Whether this was bought at a discount, for reporting.
 *
 * Apple's `offerType` says which mechanism was used, and only
 * `offerDiscountType` distinguishes a free trial from a cheap first month.
 * The entitlement granted is the same in every case.
 */
export function offerTypeOf(transaction: AppleTransactionInfo): OfferType {
  switch (transaction.offerType) {
    case 1:
      return transaction.offerDiscountType === 'FREE_TRIAL' ? 'trial' : 'intro';
    case 2:
    case 3:
    case 4:
      return 'promo';
    default:
      return 'none';
  }
}

/** Milliseconds since the epoch as ISO 8601, which is what the database takes. */
function iso(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export interface AppleContext {
  /** Which host answered, used when a payload does not name its environment. */
  environment: Environment;
  /** The subscription status code, when this came from the status endpoint. */
  status?: number;
  renewal?: AppleRenewalInfo;
}

/**
 * A signed transaction, with its renewal info if it has any, as a
 * [NormalizedPurchase].
 *
 * The identifier decisions:
 *
 * - `transactionId` is the transaction id, and it changes on every renewal, so
 *   each billing period gets its own row.
 * - `originalTransactionId` is stable across renewals and is what every
 *   notification about the subscription names, so alias lookups key on it.
 *   Apple sets it equal to the transaction id for a one-time purchase, which is
 *   exactly the convention the rest of Tollgate uses.
 */
export function normalizeTransaction(
  transaction: AppleTransactionInfo,
  ctx: AppleContext,
): NormalizedPurchase {
  const kind = kindOf(transaction.type) ?? 'non_consumable';
  const subscription = kind === 'subscription';

  const revokedAt = iso(transaction.revocationDate);
  const status: PurchaseStatus = revokedAt
    // A revocation date on the transaction outranks anything the status says.
    // The status describes the subscription; this describes the money.
    ? 'revoked'
    : subscription
    ? subscriptionStatus(ctx.status, ctx.renewal)
    // A one-time purchase has no status endpoint and no state to be in. It
    // happened, and the only thing that can undo it is a revocation.
    : 'active';

  return {
    store: 'apple',
    storeTransactionId: transaction.transactionId ??
      transaction.originalTransactionId ?? '',
    originalTransactionId: transaction.originalTransactionId ??
      transaction.transactionId ?? '',
    storeProductId: transaction.productId ?? '',
    // Apple sells one product id at one price. Subscription groups are the
    // nearest thing to a base plan, but they group alternatives rather than
    // varying one, so there is nothing to put here.
    basePlanId: null,
    kind,
    status,
    environment: environmentOf(transaction.environment, ctx.environment),
    offerType: offerTypeOf(transaction),
    purchasedAt: iso(transaction.purchaseDate) ?? new Date().toISOString(),
    expiresAt: expiryOf(status, transaction, ctx.renewal),
    // Apple states this on the renewal info and nowhere else. A subscription
    // with no renewal info to hand is assumed to renew, because that is what an
    // active subscription does and the alternative is telling a paying customer
    // their subscription is ending when it is not.
    willRenew: subscription
      ? (ctx.renewal ? ctx.renewal.autoRenewStatus === 1 : status === 'active')
      : false,
    revokedAt,
    quantity: transaction.quantity ?? 1,
    appAccountToken: transaction.appAccountToken ?? null,
    // Apple reports price in milliunits and Tollgate stores micros.
    priceAmountMicros: typeof transaction.price === 'number'
      ? transaction.price * 1000
      : null,
    priceCurrency: transaction.currency?.toLowerCase() ?? null,
    raw: transaction,
  };
}

/**
 * When this purchase stops entitling.
 *
 * During a billing grace period that is not the paid period's expiry, which has
 * already passed, but the end of the grace Apple is granting. Apple's grace can
 * run to sixteen days, far longer than the slack the database applies to a
 * silent store, so using `expiresDate` here would cut off a customer Apple is
 * still covering and still trying to charge.
 */
function expiryOf(
  status: PurchaseStatus,
  transaction: AppleTransactionInfo,
  renewal: AppleRenewalInfo | undefined,
): string | null {
  if (status === 'grace' && renewal?.gracePeriodExpiresDate) {
    return iso(renewal.gracePeriodExpiresDate);
  }
  return iso(transaction.expiresDate);
}
