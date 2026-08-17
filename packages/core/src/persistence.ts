/**
 * The storage contract.
 *
 * Core has no database dependency. `@tollgate/supabase` implements this over
 * the SQL pack's RPCs, and tests implement it in memory. The methods are
 * deliberately coarse: each one is a single round trip that the SQL side
 * performs in one transaction, because splitting "record the purchase" and
 * "run the grant hook" into two calls is how a consumable gets paid for and
 * never delivered.
 */

import type {
  CustomerInfo,
  Entitlement,
  NormalizedPurchase,
  ProductKind,
  ProductMapping,
  PurchaseRef,
  StoreId,
} from './types.ts';

/** Settings the SQL pack holds, read once per orchestrator call that needs it. */
export interface TollgateConfig {
  /**
   * A SQL function called when a consumable is delivered, in the same
   * transaction that marks it delivered. Null means nothing is called and the
   * app is expected to poll for undelivered purchases itself.
   */
  grantHook: string | null;
  /** Its opposite, called when a delivered consumable is pulled back. */
  revokeHook: string | null;
  /**
   * What the revoke hook is told to do: `revoke` takes the goods back even if
   * that leaves the balance negative, `keep` reports the refund and leaves the
   * balance alone.
   */
  clawback: 'revoke' | 'keep';
  /**
   * Extra days an expired subscription keeps its entitlement, absorbing the lag
   * between a renewal charge and the notification about it.
   */
  graceDays: number;
  /** Whether sandbox purchases may grant anything in this deployment. */
  sandbox: 'allow' | 'deny';
}

/** What [Persistence.recordPurchase] did. */
export interface RecordResult {
  /** False when this exact transaction had already been recorded. */
  created: boolean;
  purchaseId: string;
  /** Null when no `store_products` row maps the SKU. Nothing was granted. */
  productId: string | null;
  /**
   * The kind the catalogue says this product is, which can differ from what the
   * adapter guessed. Google does not distinguish consumables from
   * non-consumables, so only the catalogue knows, and the difference decides
   * whether the store is told to consume or merely to acknowledge.
   */
  kind: ProductKind | null;
  /** Whether a consumable's grant hook ran on this call, exactly once ever. */
  granted: boolean;
  /**
   * Whether the goods are delivered for this purchase, by anybody.
   *
   * The question a caller actually has. [granted] answers a narrower one, and
   * is false on the commonest happy path there is: a store notification
   * arriving a couple of hundred milliseconds ahead of the device that made the
   * purchase, delivering the goods, and leaving the device's own call to report
   * that it personally did nothing.
   */
  delivered: boolean;
  /** Whatever the grant hook returned, for the caller to pass back to the app. */
  grantResult: unknown;
  entitlements: Entitlement[];
}

export interface RevokeResult {
  /** False when there was no such purchase to revoke. */
  found: boolean;
  /** Whether the revoke hook ran. */
  clawedBack: boolean;
  clawbackResult: unknown;
  entitlements: Entitlement[];
}

/** A product as one store sells it. */
export interface StoreProduct {
  productId: string;
  kind: ProductKind;
  entitlementKey: string | null;
  storeProductId: string;
  basePlanId: string | null;
}

export interface EventRecord {
  store: StoreId;
  storeEventId: string;
  eventType: string;
  userId?: string | null;
  payload: unknown;
}

export interface Persistence {
  config(): Promise<TollgateConfig>;

  /**
   * Get or create the customer row, and with it the `appAccountToken` that
   * every store purchase has to carry.
   */
  ensureCustomer(userId: string): Promise<CustomerInfo>;

  /** Which user a store-side identifier belongs to, if any. */
  userForAlias(store: StoreId, alias: string): Promise<string | null>;

  /** Which user minted this token. The fallback when no alias is stored yet. */
  userForAppAccountToken(token: string): Promise<string | null>;

  /**
   * Remember that a store-side identifier belongs to a user.
   *
   * Called on every successful verification, because the next thing that
   * happens is a renewal notification a year later carrying that identifier
   * and nothing else.
   */
  linkAlias(userId: string, store: StoreId, alias: string): Promise<void>;

  /**
   * Write a purchase, recompute the customer's entitlements, and run the grant
   * hook if this is a consumable that has not been delivered. One transaction.
   */
  recordPurchase(
    userId: string,
    purchase: NormalizedPurchase,
  ): Promise<RecordResult>;

  /**
   * Mark a purchase as pulled back, flag the customer, recompute entitlements,
   * and run the revoke hook. One transaction.
   */
  revokePurchase(
    ref: PurchaseRef,
    reason: string,
    detail?: string | null,
  ): Promise<RevokeResult>;

  /**
   * Record a store notification. Returns false when this event id has been
   * seen before, which is the caller's cue to stop and answer 200.
   */
  recordEvent(event: EventRecord): Promise<boolean>;

  /** Close out an event, with the error if handling it failed. */
  finishEvent(
    store: StoreId,
    storeEventId: string,
    error?: string | null,
  ): Promise<void>;

  entitlements(userId: string): Promise<Entitlement[]>;

  /** Every product a store sells, with the SKU it sells it under. */
  storeProducts(store: StoreId): Promise<StoreProduct[]>;

  /** What a store SKU means to this app, or null if nothing maps it. */
  productFor(
    store: StoreId,
    storeProductId: string,
    basePlanId?: string | null,
  ): Promise<ProductMapping | null>;

  /**
   * Every purchase of a user that a store might still change its mind about.
   *
   * The restore path walks these and refreshes each one, which is how a
   * subscription that expired quietly while notifications were broken gets
   * noticed.
   */
  livePurchases(userId: string): Promise<PurchaseRef[]>;
}
