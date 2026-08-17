/**
 * The orchestrator: the order operations happen in, and what happens when one
 * of them fails halfway.
 *
 * Adapters know their store, persistence knows the database, and this file
 * knows the sequence. Almost every rule here exists because doing it in the
 * other order loses money in one direction or the other.
 */

import type { ParsedNotification, StoreAdapter, VerifyRequest } from './adapter.ts';
import { TollgateError } from './errors.ts';
import type {
  Persistence,
  RecordResult,
  StoreProduct,
} from './persistence.ts';
import type {
  CustomerInfo,
  Entitlement,
  Environment,
  NormalizedPurchase,
  ProductKind,
  PurchaseRef,
  StoreId,
} from './types.ts';

export interface Logger {
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

const silent: Logger = { warn: () => {}, error: () => {} };

/**
 * How long a device is given to settle its own purchase before the server
 * stops waiting and does it itself.
 *
 * Ten minutes is long enough to cover a client that is slow, retrying, or
 * briefly offline, and far short of the three days Play allows before it
 * auto-refunds anything unacknowledged.
 */
const SETTLE_GRACE_MS = 10 * 60 * 1000;

export interface TollgateOptions {
  adapters: StoreAdapter[];
  persistence: Persistence;
  logger?: Logger;

  /**
   * Which environment this deployment is, and therefore whose purchases it may
   * grant on.
   *
   * `production` is the default and refuses sandbox purchases. That default is
   * the whole point: a store's test purchase arrives through the same API as a
   * real one, marked by a flag, so a deployment that accepts them hands its
   * paid product to anybody who can reach a test account. Somewhere that has
   * not been configured must be the somewhere that refuses.
   *
   * This deliberately does not live in the database. It is the one setting that
   * differs between a laptop and production, which is exactly what a
   * deployment's own environment is for; a row in a table travels with the
   * migrations that create it and has to be remembered and changed by hand on
   * every stack, which is how a development value ends up in production.
   */
  environment?: Environment;
}

export interface PurchaseResult {
  purchase: NormalizedPurchase;
  entitlements: Entitlement[];
  /** True when the grant hook ran on this call rather than a previous one. */
  granted: boolean;
  /** True when the goods are delivered for this purchase, by any path. */
  delivered: boolean;
  grantResult: unknown;
  /**
   * Set when the purchase was recorded but the store could not be told it was
   * delivered. The money is safe and the customer has their goods; the risk is
   * an auto-refund at the store's end, so this is worth surfacing to a log
   * rather than to the customer.
   */
  finishWarning?: string;
}

export interface NotificationResult {
  /** False when this event had already been handled and was ignored. */
  handled: boolean;
  eventType: string;
  storeEventId: string;
  /** One entry per purchase the event named. */
  outcomes: NotificationOutcome[];
}

export interface NotificationOutcome {
  ref: PurchaseRef;
  action: 'recorded' | 'revoked' | 'gone' | 'unmapped_user' | 'sandbox_skipped';
  userId?: string;
}

export class Tollgate {
  readonly #adapters = new Map<StoreId, StoreAdapter>();
  readonly #db: Persistence;
  readonly #log: Logger;
  readonly #environment: Environment;

  constructor(opts: TollgateOptions) {
    for (const a of opts.adapters) this.#adapters.set(a.store, a);
    this.#db = opts.persistence;
    this.#log = opts.logger ?? silent;
    this.#environment = opts.environment ?? 'production';
  }

  /** Whether a purchase made in this environment may grant anything here. */
  #accepts(purchase: NormalizedPurchase): boolean {
    // Real purchases are honoured everywhere. Test purchases only where the
    // deployment has said it is a test deployment.
    return purchase.environment === 'production' ||
      this.#environment === 'sandbox';
  }

  adapter(store: StoreId): StoreAdapter {
    const a = this.#adapters.get(store);
    if (!a) throw TollgateError.unknownStore(store);
    return a;
  }

  /** The token a client must attach to a purchase for it to ever find its way home. */
  async customer(userId: string): Promise<CustomerInfo> {
    return await this.#db.ensureCustomer(userId);
  }

  async entitlements(userId: string): Promise<Entitlement[]> {
    return await this.#db.entitlements(userId);
  }

  /**
   * Every product a store sells, with the SKU it sells it under.
   *
   * The direction a client needs. An app knows it wants to sell a product and
   * has to ask a store for an id it has never heard of; compiling those ids
   * into the app instead means shipping a release to change one.
   */
  async storeProducts(store: StoreId): Promise<StoreProduct[]> {
    return await this.#db.storeProducts(store);
  }

  /**
   * A client says it bought something. Check with the store, record it, deliver
   * it, and only then tell the store it was delivered.
   */
  async purchase(
    store: StoreId,
    req: Omit<VerifyRequest, 'appAccountToken'>,
    opts: { settle?: boolean } = {},
  ): Promise<PurchaseResult> {
    const adapter = this.adapter(store);
    const customer = await this.#db.ensureCustomer(req.userId);

    const purchase = await adapter.verify({
      ...req,
      kind: req.kind ?? await this.#kindOf(store, req.storeProductId),
      appAccountToken: customer.appAccountToken,
    });

    this.#assertUsableEnvironment(purchase);

    // Linked before recording, not after. If the process dies between the two,
    // a stored alias with no purchase is repaired by the next notification;
    // a purchase with no alias is a renewal in a year's time that cannot find
    // its owner.
    await this.#db.linkAlias(
      req.userId,
      store,
      purchase.originalTransactionId,
    );

    const result = await this.#db.recordPurchase(req.userId, purchase);
    if (!result.productId) {
      // Recorded, deliberately, and granting nothing. Somebody sold a SKU the
      // database has never been told about; throwing here would leave a real
      // payment with no row at all, which is the one outcome that cannot be
      // fixed later. Mapping the SKU and replaying fixes this one.
      this.#log.error(
        `Purchase ${purchase.store}/${purchase.storeTransactionId} is for ` +
          `unmapped SKU "${purchase.storeProductId}". It has been recorded ` +
          `and granted nothing.`,
      );
    }

    // `settle: false` means a device is going to acknowledge or consume this
    // itself, once it sees this response. Both sides doing it is not harmless:
    // Play answers an error to a second consume, and on a consumable the
    // client SDK needs the consume to be its own or it cannot clear the
    // purchase from its pending list, and re-delivers it on every app start.
    //
    // The client only completes after this call returns, so the ordering rule
    // still holds either way: recorded and granted first, settled second.
    const finishWarning = opts.settle === false
      ? undefined
      : await this.#finish(adapter, purchase, result.kind);

    return {
      purchase,
      entitlements: result.entitlements,
      granted: result.granted,
      delivered: result.delivered,
      grantResult: result.grantResult,
      ...(finishWarning ? { finishWarning } : {}),
    };
  }

  /**
   * A store is telling us something changed.
   *
   * Answering 200 to a store means "do not send this again", so the rule
   * throughout is: anything we can safely ignore is ignored loudly in the log
   * and reported as handled, and only a genuine inability to do the work
   * throws, so the store retries.
   */
  async handleNotification(
    store: StoreId,
    req: Request,
  ): Promise<NotificationResult> {
    const adapter = this.adapter(store);
    // Throws `bad_signature` on anything that did not come from the store.
    const note: ParsedNotification = await adapter.parseNotification(req);

    const fresh = await this.#db.recordEvent({
      store,
      storeEventId: note.storeEventId,
      eventType: note.eventType,
      userId: note.userId ?? null,
      payload: note.payload,
    });
    if (!fresh) {
      return {
        handled: false,
        eventType: note.eventType,
        storeEventId: note.storeEventId,
        outcomes: [],
      };
    }

    const outcomes: NotificationOutcome[] = [];
    let failure: string | null = null;
    try {
      // Revocations first. They are stated by the notification rather than
      // discoverable by re-reading, and if both lists name the same purchase
      // the refund is the newer fact.
      for (const ref of note.revoked ?? []) {
        await this.#db.revokePurchase(
          ref,
          'store_revoked',
          `${store} reported ${note.eventType}`,
        );
        outcomes.push({ ref, action: 'revoked' });
      }
      for (const ref of note.refs) {
        outcomes.push(await this.#applyRef(adapter, ref, note.userId ?? null));
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      await this.#db.finishEvent(store, note.storeEventId, failure);
      throw e;
    }
    await this.#db.finishEvent(store, note.storeEventId, null);

    return {
      handled: true,
      eventType: note.eventType,
      storeEventId: note.storeEventId,
      outcomes,
    };
  }

  /**
   * Re-read everything of this customer's that a store could still change.
   *
   * Two jobs at once: the "restore purchases" button Apple requires, and the
   * repair pass for state that drifted while notifications were failing.
   */
  async refresh(userId: string): Promise<Entitlement[]> {
    const refs = await this.#db.livePurchases(userId);
    for (const ref of refs) {
      const adapter = this.#adapters.get(ref.store);
      if (!adapter) continue;
      try {
        await this.#applyRef(adapter, ref, userId);
      } catch (e) {
        // One unreachable store must not stop the others. The customer's other
        // entitlements are still worth refreshing, and this one is retried on
        // the next pass.
        this.#log.warn(
          `Could not refresh ${ref.store}/${ref.originalTransactionId}`,
          e,
        );
      }
    }
    return await this.#db.entitlements(userId);
  }

  /** Where to send someone who wants to cancel. */
  async manageUrl(userId: string, key: string): Promise<string | null> {
    const ent = (await this.#db.entitlements(userId))
      .find((e) => e.key === key);
    if (!ent?.store) return null;
    const adapter = this.#adapters.get(ent.store);
    if (!adapter?.manageUrl) return null;
    const refs = await this.#db.livePurchases(userId);
    const ref = refs.find((r) => r.store === ent.store);
    if (!ref) return null;
    const purchase = await adapter.refresh(ref);
    return purchase ? adapter.manageUrl(purchase) : null;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Bring one purchase up to date from its store.
   *
   * Shared by the notification path and the refresh path on purpose. A
   * notification is only ever treated as a signal that something changed, never
   * as the new state: the payload can be stale by the time it arrives, and
   * every store publishes a "go and ask" API precisely because of that.
   */
  async #applyRef(
    adapter: StoreAdapter,
    ref: PurchaseRef,
    hintedUserId: string | null,
  ): Promise<NotificationOutcome> {
    const purchase = await adapter.refresh(ref);
    if (!purchase) {
      // The store has forgotten it. Nothing to record and nothing to revoke;
      // whatever is stored stays, and expires on its own terms.
      return { ref, action: 'gone' };
    }

    const userId = hintedUserId ??
      await this.#resolveUser(adapter.store, purchase);
    if (!userId) {
      // A real purchase we cannot attribute. Not an error the store can help
      // with, so it is recorded as handled rather than retried forever. The
      // usual cause is an app that did not attach an appAccountToken.
      this.#log.error(
        `No user for ${adapter.store} purchase ` +
          `${purchase.originalTransactionId}. It carries ` +
          `${purchase.appAccountToken ? 'a token nobody minted' : 'no token'}.`,
      );
      return { ref, action: 'unmapped_user' };
    }

    if (!this.#accepts(purchase)) {
      return { ref, action: 'sandbox_skipped', userId };
    }

    if (purchase.status === 'revoked' || purchase.revokedAt) {
      await this.#db.revokePurchase(
        { ...ref, store: adapter.store },
        'store_revoked',
        `${adapter.store} reported the purchase as revoked`,
      );
      return { ref, action: 'revoked', userId };
    }

    await this.#db.linkAlias(userId, adapter.store, purchase.originalTransactionId);
    const result: RecordResult = await this.#db.recordPurchase(userId, purchase);
    if (!result.productId) {
      this.#log.error(
        `Notification for unmapped SKU "${purchase.storeProductId}" ` +
          `(${adapter.store}). Recorded, granted nothing.`,
      );
    }

    // Settle it here only once nobody else has, for long enough that nobody
    // else is going to.
    //
    // Both sides settling is not harmless: the store answers the second
    // consume with "you do not own this", and that reaches the buyer as a
    // failed payment for goods they have already been given.
    //
    // The tempting rule is "settle when this notification is the first anyone
    // has heard of the purchase", and it is wrong. Play publishes within a
    // couple of hundred milliseconds, comfortably faster than a device's round
    // trip to its own server, so the notification is routinely first for a
    // purchase a device is actively handling. Whoever arrives first says
    // nothing about who is going to settle it.
    //
    // Age does. A purchase seconds old is being handled right now by whatever
    // made it; one that has sat unsettled for the whole window is not. Play
    // auto-refunds anything unacknowledged after three days, so waiting ten
    // minutes to find out costs nothing against that deadline.
    const age = Date.now() - Date.parse(purchase.purchasedAt);
    if (age >= SETTLE_GRACE_MS) {
      await this.#finish(adapter, purchase, result.kind);
    }

    return { ref, action: 'recorded', userId };
  }

  /**
   * What kind of thing a SKU is, according to the catalogue.
   *
   * Asked whenever a client did not say, which is most of the time: a device
   * knows what it put in the basket, but a restored purchase or one that
   * settled days later arrives with a product id and nothing else.
   *
   * It matters more than it sounds. Google serves subscriptions and one-time
   * products from two different endpoints, so a wrong or missing kind means
   * asking the wrong one, and the answer to that is a 404 that reads as "Google
   * Play has no record of that purchase" for a purchase that certainly exists.
   *
   * Null when nothing maps the SKU, which leaves the adapter to its own
   * default rather than inventing an answer.
   */
  async #kindOf(
    store: StoreId,
    storeProductId: string | undefined,
  ): Promise<ProductKind | undefined> {
    if (!storeProductId) return undefined;
    try {
      const mapping = await this.#db.productFor(store, storeProductId);
      return mapping?.kind;
    } catch (e) {
      this.#log.warn(`Could not look up "${storeProductId}"`, e);
      return undefined;
    }
  }

  /**
   * Work out whose purchase this is.
   *
   * The alias comes first because it is cheap and covers every renewal of
   * anything ever bought through the app. The token is the fallback that
   * covers the first notification about a brand new purchase, which can easily
   * beat the client's own verify call.
   */
  async #resolveUser(
    store: StoreId,
    purchase: NormalizedPurchase,
  ): Promise<string | null> {
    const byAlias = await this.#db.userForAlias(
      store,
      purchase.originalTransactionId,
    );
    if (byAlias) return byAlias;
    if (!purchase.appAccountToken) return null;
    return await this.#db.userForAppAccountToken(purchase.appAccountToken);
  }

  #assertUsableEnvironment(purchase: NormalizedPurchase): void {
    if (this.#accepts(purchase)) return;
    throw new TollgateError(
      'sandbox_rejected',
      'That is a test purchase and this deployment only accepts real ones.',
    );
  }

  /**
   * Tell the store the goods were handed over.
   *
   * Never throws. By the time this runs the purchase is recorded and any
   * consumable is credited, so failing the call would make a successful
   * purchase look failed to the customer and invite a retry that finds the
   * transaction already recorded. The real risk of a missed acknowledge is a
   * store-side auto-refund days later, which belongs in a log and an alert,
   * not in the customer's face.
   */
  async #finish(
    adapter: StoreAdapter,
    purchase: NormalizedPurchase,
    kind: NormalizedPurchase['kind'] | null,
  ): Promise<string | undefined> {
    if (!adapter.finish) return undefined;
    try {
      // The catalogue's kind wins over the adapter's. Google cannot tell a
      // consumable from a non-consumable, and getting it wrong here means
      // acknowledging a gem pack instead of consuming it, which leaves the
      // customer unable to ever buy a second one.
      await adapter.finish(kind ? { ...purchase, kind } : purchase);
      return undefined;
    } catch (e) {
      const message = `Could not acknowledge ${adapter.store} purchase ` +
        `${purchase.storeTransactionId}: ${e instanceof Error ? e.message : e}`;
      this.#log.error(message, e);
      return message;
    }
  }
}
