/**
 * What a store has to be able to do to be usable by Tollgate.
 *
 * Adapters translate, and nothing else. They do not read or write the
 * database, decide whether a customer is entitled, or know that entitlements
 * exist. Everything they return is a [NormalizedPurchase] the orchestrator
 * hands straight to persistence, which is what keeps the store-specific mess
 * in one file per store.
 */

import type {
  NormalizedPurchase,
  ProductKind,
  PurchaseRef,
  StoreId,
} from './types.ts';

/** A purchase the client claims to have made, to be checked with the store. */
export interface VerifyRequest {
  /**
   * Whatever the store's client SDK handed the app as proof.
   *
   * Google's `purchaseToken`, Apple's signed transaction JWS, Stripe's payment
   * intent or subscription id. Opaque here; each adapter knows what its own
   * looks like and is expected to reject anything else.
   */
  token: string;

  /** The user this is being verified on behalf of. */
  userId: string;

  /**
   * The UUID the app attached at purchase time.
   *
   * Passed so the adapter can check that the purchase it fetched really is the
   * one this user made, rather than one whose token they got hold of. An
   * adapter that can check this and does not is an account-takeover route:
   * purchase tokens travel through clients, and a stolen one would otherwise
   * grant a subscription to whoever presents it first.
   */
  appAccountToken: string;

  /** What the client thought it bought. Advisory; the store is authoritative. */
  storeProductId?: string;
  basePlanId?: string | null;
  kind?: ProductKind;
}

/** A store notification, after its signature has been verified. */
export interface ParsedNotification {
  /**
   * The store's own id for this event, used to drop redeliveries.
   *
   * Every store redelivers on a non-2xx, and some redeliver anyway. Without a
   * stable id per event, a redelivered refund gets processed twice and a
   * redelivered consumable purchase pays out twice.
   */
  storeEventId: string;

  /** The store's event name, stored as-is for the audit trail. */
  eventType: string;

  /**
   * The purchases this event is about, usually exactly one.
   *
   * Empty is legitimate and common: stores send events about test
   * configuration, price changes and account deletion that name no purchase.
   * The orchestrator records those and does nothing else.
   *
   * These are re-read from the store before anything is written, because a
   * notification is only ever a signal that something changed. The payload can
   * be stale by the time it arrives, which is why every store publishes a
   * "go and ask" API alongside its notifications.
   */
  refs: PurchaseRef[];

  /**
   * Purchases this event says were taken back: refunded, charged back, or
   * revoked by the store.
   *
   * Separate from [refs] because a revocation is the one thing that cannot be
   * discovered by re-reading. A voided Google one-time purchase reads back as
   * `purchaseState: 1`, indistinguishable from an ordinary cancellation, and a
   * revoked subscription can still read as active until the store catches up.
   * The notification is the only place the refund is stated, so it is trusted
   * for that and only that.
   */
  revoked?: PurchaseRef[];

  /**
   * The user, when the notification itself names one.
   *
   * Rare. Usually the orchestrator has to find the user from the refs, because
   * neither Apple nor Google carries an app-side identity in most events.
   */
  userId?: string | null;

  /** The verified payload, kept whole for replay. */
  payload: unknown;
}

export interface StoreAdapter {
  readonly store: StoreId;

  /**
   * Ask the store whether this purchase is real, and what state it is in.
   *
   * Must go to the store. A client-side receipt that verifies against a public
   * key is still a receipt the client handed over, and the whole point of this
   * method is that the answer comes from somewhere the client cannot reach.
   */
  verify(req: VerifyRequest): Promise<NormalizedPurchase>;

  /**
   * Re-read a purchase Tollgate already knows about.
   *
   * This is the repair path. Store notifications get missed, delayed and
   * dropped, so every purchase must be answerable on demand rather than only
   * when the store volunteers something. Null means the store no longer has
   * any record of it.
   */
  refresh(ref: PurchaseRef): Promise<NormalizedPurchase | null>;

  /**
   * Verify an incoming notification's signature and translate it.
   *
   * Throws [TollgateError] with code `bad_signature` on anything that does not
   * verify. The endpoint this arrives at is public, so the signature check is
   * the only thing separating a store's delivery from any other HTTP request
   * that reaches it.
   */
  parseNotification(req: Request): Promise<ParsedNotification>;

  /**
   * Tell the store the purchase has been delivered, where the store requires
   * it: Google acknowledge and consume, Apple's transaction finish.
   *
   * The orchestrator always calls this AFTER the purchase is recorded and any
   * grant hook has run, never before. Google forgets consumed purchases and
   * Play Billing 8 removed the ability to query them back, so a crash between
   * consuming and crediting loses the purchase with no way to recover it. In
   * the other direction Google auto-refunds anything unacknowledged after
   * three days, so this is not optional either.
   */
  finish?(purchase: NormalizedPurchase): Promise<void>;

  /**
   * Where to send a customer to cancel or change payment method.
   *
   * An in-app purchase cannot be cancelled from inside the app, so on mobile
   * the honest answer is a deep link into the store's own subscription
   * management. Null when the store has no such page.
   */
  manageUrl?(purchase: NormalizedPurchase): string | null;
}
