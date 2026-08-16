/**
 * The shapes the Play Developer API and Play's notifications actually use.
 *
 * Only the fields Tollgate reads are declared. Everything arrives as `unknown`
 * from `fetch` and the whole payload is kept on the purchase row, so a field
 * that turns out to matter later is recoverable from stored data rather than
 * lost.
 *
 * Reference:
 *   https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
 *   https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products
 *   https://developer.android.com/google/play/billing/rtdn-reference
 */

/** SubscriptionPurchaseV2.subscriptionState */
export type SubscriptionState =
  | 'SUBSCRIPTION_STATE_UNSPECIFIED'
  | 'SUBSCRIPTION_STATE_PENDING'
  | 'SUBSCRIPTION_STATE_ACTIVE'
  | 'SUBSCRIPTION_STATE_PAUSED'
  | 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
  | 'SUBSCRIPTION_STATE_ON_HOLD'
  | 'SUBSCRIPTION_STATE_CANCELED'
  | 'SUBSCRIPTION_STATE_EXPIRED'
  | 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';

export interface OfferDetails {
  basePlanId?: string;
  offerId?: string;
  offerTags?: string[];
}

export interface AutoRenewingPlan {
  autoRenewEnabled?: boolean;
  recurringPrice?: Money;
}

export interface Money {
  currencyCode?: string;
  /** Whole units, as a string because it can exceed a JS-safe integer. */
  units?: string;
  /** Billionths of a unit. Google's own scale, not the micros used elsewhere. */
  nanos?: number;
}

export interface SubscriptionLineItem {
  productId?: string;
  expiryTime?: string;
  autoRenewingPlan?: AutoRenewingPlan;
  prepaidPlan?: { allowExtendAfterTime?: string };
  offerDetails?: OfferDetails;
}

export interface ExternalAccountIdentifiers {
  /** What `setObfuscatedAccountId` was called with at purchase time. */
  obfuscatedExternalAccountId?: string;
  obfuscatedExternalProfileId?: string;
  externalAccountId?: string;
}

export interface SubscriptionPurchaseV2 {
  lineItems?: SubscriptionLineItem[];
  startTime?: string;
  subscriptionState?: SubscriptionState;
  latestOrderId?: string;
  /** Set when this subscription replaced another; the old token. */
  linkedPurchaseToken?: string;
  regionCode?: string;
  /** Present, as an empty object, only when this is a test purchase. */
  testPurchase?: Record<string, never>;
  acknowledgementState?:
    | 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED'
    | 'ACKNOWLEDGEMENT_STATE_PENDING'
    | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  externalAccountIdentifiers?: ExternalAccountIdentifiers;
  canceledStateContext?: unknown;
  pausedStateContext?: unknown;
}

/** purchases.products.get */
export interface ProductPurchase {
  productId?: string;
  purchaseToken?: string;
  orderId?: string;
  purchaseTimeMillis?: string;
  /** 0 purchased, 1 canceled, 2 pending. */
  purchaseState?: 0 | 1 | 2;
  /** 0 yet to be consumed, 1 consumed. */
  consumptionState?: 0 | 1;
  /** 0 acknowledgement pending, 1 acknowledged. */
  acknowledgementState?: 0 | 1;
  /**
   * Absent on an ordinary purchase. 0 test, 1 promo, 2 rewarded. Absence is
   * therefore the signal for a real purchase, which is the opposite of how it
   * reads, so it is worth checking for `=== 0` rather than for truthiness.
   */
  purchaseType?: 0 | 1 | 2;
  quantity?: number;
  refundableQuantity?: number;
  obfuscatedExternalAccountId?: string;
  regionCode?: string;
}

// --- Real-time developer notifications --------------------------------------

/** DeveloperNotification.subscriptionNotification.notificationType */
export const SUBSCRIPTION_NOTIFICATION = {
  1: 'SUBSCRIPTION_RECOVERED',
  2: 'SUBSCRIPTION_RENEWED',
  3: 'SUBSCRIPTION_CANCELED',
  4: 'SUBSCRIPTION_PURCHASED',
  5: 'SUBSCRIPTION_ON_HOLD',
  6: 'SUBSCRIPTION_IN_GRACE_PERIOD',
  7: 'SUBSCRIPTION_RESTARTED',
  8: 'SUBSCRIPTION_PRICE_CHANGE_CONFIRMED',
  9: 'SUBSCRIPTION_DEFERRED',
  10: 'SUBSCRIPTION_PAUSED',
  11: 'SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED',
  12: 'SUBSCRIPTION_REVOKED',
  13: 'SUBSCRIPTION_EXPIRED',
  20: 'SUBSCRIPTION_PENDING_PURCHASE_CANCELED',
} as const;

export const ONE_TIME_PRODUCT_NOTIFICATION = {
  1: 'ONE_TIME_PRODUCT_PURCHASED',
  2: 'ONE_TIME_PRODUCT_CANCELED',
} as const;

export interface SubscriptionNotification {
  version?: string;
  notificationType?: number;
  purchaseToken?: string;
  subscriptionId?: string;
}

export interface OneTimeProductNotification {
  version?: string;
  notificationType?: number;
  purchaseToken?: string;
  sku?: string;
}

export interface VoidedPurchaseNotification {
  purchaseToken?: string;
  orderId?: string;
  /** 1 subscription, 2 one-time product. */
  productType?: 1 | 2;
  /** 1 full refund, 2 partial (a quantity of a multi-quantity purchase). */
  refundType?: 1 | 2;
}

export interface DeveloperNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: SubscriptionNotification;
  oneTimeProductNotification?: OneTimeProductNotification;
  voidedPurchaseNotification?: VoidedPurchaseNotification;
  /** Present only for the Console's "Send test notification" button. */
  testNotification?: { version?: string };
}

/** The envelope a Pub/Sub push subscription POSTs. */
export interface PubSubPush {
  message?: {
    data?: string;
    messageId?: string;
    message_id?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}
