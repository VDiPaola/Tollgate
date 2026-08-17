/**
 * The shapes the App Store Server API answers with, and the payloads Apple
 * signs.
 *
 * Every field here is optional. Apple omits rather than nulls, the set differs
 * by product type, and several arrived in later versions of the API than the
 * one a given app was written against, so a type that insisted on any of them
 * would be a lie that only shows up in production.
 *
 * Dates are milliseconds since the epoch, as numbers.
 */

export type AppleEnvironmentName = 'Sandbox' | 'Production';

/** What Apple says a product is. There is no ambiguity here, unlike Google. */
export type AppleProductType =
  | 'Auto-Renewable Subscription'
  | 'Non-Consumable'
  | 'Consumable'
  | 'Non-Renewing Subscription';

/**
 * A decoded `JWSTransaction`, which is Apple's account of one payment.
 *
 * One of these exists per renewal of a subscription, per one-time purchase, and
 * per restored purchase, and it is signed whether it came from the API, a
 * notification, or the device.
 */
export interface AppleTransactionInfo {
  /** This payment. Changes on every renewal. */
  transactionId?: string;
  /** The first payment in the chain. Stable across renewals. */
  originalTransactionId?: string;
  /** Unique per subscription period. Apple's own idempotency handle. */
  webOrderLineItemId?: string;
  bundleId?: string;
  productId?: string;
  subscriptionGroupIdentifier?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  quantity?: number;
  type?: AppleProductType;
  /**
   * The UUID the app attached when it started the purchase, and the only thing
   * tying an Apple transaction to a user of this app.
   *
   * Apple requires it to be a UUID and silently drops anything else, which is
   * why Tollgate's account token is one.
   */
  appAccountToken?: string;
  /**
   * Whether the buyer paid for this or received it through Family Sharing.
   *
   * A family-shared transaction belongs to somebody who never passed through
   * this app's purchase flow, so it carries no `appAccountToken`.
   */
  inAppOwnershipType?: 'PURCHASED' | 'FAMILY_SHARED';
  signedDate?: number;
  /** Set when the purchase was refunded or otherwise pulled back. */
  revocationDate?: number;
  /** 0 for any other reason, 1 when the customer reported a problem. */
  revocationReason?: number;
  /** 1 introductory, 2 promotional, 3 offer code, 4 win-back. */
  offerType?: number;
  offerIdentifier?: string;
  /** Set on an introductory offer, and the only way to tell a free trial. */
  offerDiscountType?: 'FREE_TRIAL' | 'PAY_AS_YOU_GO' | 'PAY_UP_FRONT';
  environment?: AppleEnvironmentName;
  storefront?: string;
  storefrontId?: string;
  transactionReason?: 'PURCHASE' | 'RENEWAL';
  /** Milliunits of the currency: 9990 is 9.99. */
  price?: number;
  currency?: string;
}

/**
 * A decoded `JWSRenewalInfo`: what Apple intends to do next, as opposed to what
 * it has already done.
 *
 * The transaction alone cannot answer "will this renew", and answering that
 * wrongly is how an app tells somebody their subscription is ending when it is
 * not.
 */
export interface AppleRenewalInfo {
  originalTransactionId?: string;
  autoRenewProductId?: string;
  productId?: string;
  /** 0 off, 1 on. */
  autoRenewStatus?: number;
  /** 1 customer cancelled, 2 billing error, 3 price increase refused, 4 gone. */
  expirationIntent?: number;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  offerType?: number;
  offerIdentifier?: string;
  signedDate?: number;
  environment?: AppleEnvironmentName;
  recentSubscriptionStartDate?: number;
  renewalDate?: number;
  renewalPrice?: number;
  currency?: string;
  priceIncreaseStatus?: number;
}

/**
 * Apple's subscription status codes.
 *
 * The pair that matters is 3 and 4: both mean a renewal payment is failing and
 * Apple is retrying, and they differ on whether the customer keeps access
 * while it does. Collapsing them either cuts off somebody Apple is still
 * covering, or serves somebody Apple has stopped covering.
 */
export const APPLE_SUBSCRIPTION_STATUS = {
  1: 'ACTIVE',
  2: 'EXPIRED',
  3: 'BILLING_RETRY',
  4: 'BILLING_GRACE_PERIOD',
  5: 'REVOKED',
} as const;

/** One subscription's latest state, inside a status response. */
export interface AppleLastTransaction {
  originalTransactionId?: string;
  /** A key of [APPLE_SUBSCRIPTION_STATUS]. */
  status?: number;
  signedTransactionInfo?: string;
  signedRenewalInfo?: string;
}

export interface AppleSubscriptionGroup {
  subscriptionGroupIdentifier?: string;
  lastTransactions?: AppleLastTransaction[];
}

/** `GET /inApps/v1/subscriptions/{transactionId}` */
export interface AppleStatusResponse {
  environment?: AppleEnvironmentName;
  bundleId?: string;
  appAppleId?: number;
  data?: AppleSubscriptionGroup[];
}

/** `GET /inApps/v1/transactions/{transactionId}` */
export interface AppleTransactionResponse {
  signedTransactionInfo?: string;
}

/** The error body Apple returns with a 4xx. */
export interface AppleErrorResponse {
  errorCode?: number;
  errorMessage?: string;
}

/**
 * Looking up a transaction in the wrong environment.
 *
 * Sandbox and production are separate hosts holding separate transactions, and
 * a purchase made in one is simply absent from the other. This is the code that
 * says "ask the other one" rather than "no such purchase".
 */
export const TRANSACTION_ID_NOT_FOUND = 4040010;

/**
 * The decoded body of an App Store Server Notification V2.
 *
 * `data` is absent on the notifications that are about nothing in particular:
 * TEST, and the summary-carrying ones for renewal date extensions applied in
 * bulk.
 */
export interface AppleNotification {
  notificationType?: string;
  subtype?: string;
  /** Apple's own id for this delivery, which is what dedupes redeliveries. */
  notificationUUID?: string;
  version?: string;
  signedDate?: number;
  data?: AppleNotificationData;
  summary?: AppleNotificationSummary;
  externalPurchaseToken?: unknown;
}

export interface AppleNotificationData {
  appAppleId?: number;
  bundleId?: string;
  bundleVersion?: string;
  environment?: AppleEnvironmentName;
  signedTransactionInfo?: string;
  signedRenewalInfo?: string;
  /** The subscription status, same codes as [APPLE_SUBSCRIPTION_STATUS]. */
  status?: number;
}

export interface AppleNotificationSummary {
  requestIdentifier?: string;
  environment?: AppleEnvironmentName;
  appAppleId?: number;
  bundleId?: string;
  productId?: string;
  storefrontCountryCodes?: string[];
  failedCount?: number;
  succeededCount?: number;
}

/**
 * The notifications that mean money went back.
 *
 * REFUND is a refund of a purchase. REVOKE is Family Sharing being turned off
 * or the buyer leaving the family, which ends access for everybody who was
 * sharing it. Both are stated only by the notification.
 */
export const REVOKING_NOTIFICATIONS = new Set(['REFUND', 'REVOKE']);
