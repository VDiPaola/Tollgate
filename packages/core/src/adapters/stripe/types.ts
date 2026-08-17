/**
 * The Stripe objects Tollgate reads.
 *
 * Only the fields it uses are declared, and the whole payload is kept on the
 * purchase row, so a field that turns out to matter later is recoverable from
 * stored data rather than lost.
 */

/** https://docs.stripe.com/api/subscriptions/object */
export type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

export interface StripePrice {
  id?: string;
  currency?: string;
  unit_amount?: number | null;
  recurring?: { interval?: string; interval_count?: number } | null;
}

export interface StripeSubscriptionItem {
  id?: string;
  price?: StripePrice;
  /** Newer API versions carry the period on the item rather than the sub. */
  current_period_end?: number;
  current_period_start?: number;
}

export interface StripeSubscription {
  id?: string;
  object?: 'subscription';
  status?: StripeSubscriptionStatus;
  customer?: string | { id?: string };
  items?: { data?: StripeSubscriptionItem[] };
  cancel_at_period_end?: boolean;
  canceled_at?: number | null;
  start_date?: number;
  created?: number;
  trial_end?: number | null;
  latest_invoice?: string | { id?: string };
  livemode?: boolean;
  metadata?: Record<string, string>;
  /** Older API versions. Read as a fallback; see `subscriptionPeriodEnd`. */
  current_period_end?: number;
  current_period_start?: number;
}

/** https://docs.stripe.com/api/payment_intents/object */
export interface StripePaymentIntent {
  id?: string;
  object?: 'payment_intent';
  status?:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'canceled'
    | 'succeeded';
  amount?: number;
  amount_received?: number;
  currency?: string;
  customer?: string | { id?: string };
  created?: number;
  livemode?: boolean;
  metadata?: Record<string, string>;
  latest_charge?: string | { id?: string; refunded?: boolean };
}

export interface StripeCustomer {
  id?: string;
  deleted?: boolean;
  metadata?: Record<string, string>;
}

export interface StripeCharge {
  id?: string;
  object?: 'charge';
  payment_intent?: string | { id?: string };
  refunded?: boolean;
  amount_refunded?: number;
  metadata?: Record<string, string>;
}

export interface StripeEvent {
  id?: string;
  type?: string;
  livemode?: boolean;
  data?: { object?: Record<string, unknown> };
}
