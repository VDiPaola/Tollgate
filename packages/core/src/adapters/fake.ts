/**
 * A store that does not exist.
 *
 * Two jobs. In tests it is the only way to drive a renewal, a grace period and
 * a refund without waiting a month or spending money. In a development
 * deployment it stands in for the real stores so the whole purchase flow,
 * including the grant hook and the entitlement recompute, can be exercised on a
 * machine with no Apple account, no Play console and no Stripe key.
 *
 * It is a real adapter, not a mock: it goes through the same contract as the
 * others, so a bug in the contract shows up here first.
 */

import type {
  ParsedNotification,
  StoreAdapter,
  VerifyRequest,
} from '../adapter.ts';
import { TollgateError } from '../errors.ts';
import type {
  Environment,
  NormalizedPurchase,
  OfferType,
  ProductKind,
  PurchaseRef,
  PurchaseStatus,
} from '../types.ts';

interface FakeTransaction {
  originalTransactionId: string;
  storeTransactionId: string;
  storeProductId: string;
  kind: ProductKind;
  status: PurchaseStatus;
  environment: Environment;
  offerType: OfferType;
  purchasedAt: Date;
  expiresAt: Date | null;
  willRenew: boolean;
  revokedAt: Date | null;
  quantity: number;
  appAccountToken: string | null;
  priceAmountMicros: number | null;
  priceCurrency: string | null;
  periodDays: number;
  finished: boolean;
  renewals: number;
}

export interface SellOptions {
  storeProductId: string;
  kind?: ProductKind;
  appAccountToken?: string | null;
  periodDays?: number;
  quantity?: number;
  environment?: Environment;
  offerType?: OfferType;
  priceAmountMicros?: number | null;
  priceCurrency?: string | null;
}

/** A notification the fake store would send, ready to feed to a handler. */
export interface FakeNotification {
  eventId: string;
  type: string;
  originalTransactionId: string;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString().padStart(6, '0')}`;
}

export class FakeStore {
  readonly #txns = new Map<string, FakeTransaction>();
  #now: Date;
  #events = 0;

  /** Fails the next `n` calls to any store method, to exercise retry paths. */
  failNextCalls = 0;

  constructor(now: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.#now = now;
  }

  get now(): Date {
    return this.#now;
  }

  /** Move the store's clock. Expiry is evaluated against this, not the wall. */
  advanceDays(days: number): void {
    this.#now = new Date(this.#now.getTime() + days * 86_400_000);
  }

  advanceMs(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }

  /** Make a purchase. Returns the token a client would hand to `verify`. */
  sell(opts: SellOptions): string {
    const kind = opts.kind ?? 'subscription';
    const periodDays = opts.periodDays ?? 30;
    const id = nextId('fake');
    const txn: FakeTransaction = {
      originalTransactionId: id,
      storeTransactionId: `${id}.1`,
      storeProductId: opts.storeProductId,
      kind,
      status: 'active',
      environment: opts.environment ?? 'production',
      offerType: opts.offerType ?? 'none',
      purchasedAt: this.#now,
      expiresAt: kind === 'subscription'
        ? new Date(this.#now.getTime() + periodDays * 86_400_000)
        : null,
      willRenew: kind === 'subscription',
      revokedAt: null,
      quantity: opts.quantity ?? 1,
      appAccountToken: opts.appAccountToken ?? null,
      priceAmountMicros: opts.priceAmountMicros ?? null,
      priceCurrency: opts.priceCurrency ?? null,
      periodDays,
      finished: false,
      renewals: 0,
    };
    this.#txns.set(id, txn);
    return id;
  }

  /**
   * Bill the next period successfully.
   *
   * The transaction id changes and the original does not, which is exactly the
   * shape Apple and Google produce and the reason both ids exist.
   */
  renew(originalTransactionId: string): FakeNotification {
    const t = this.#require(originalTransactionId);
    t.renewals += 1;
    t.storeTransactionId = `${t.originalTransactionId}.${t.renewals + 1}`;
    t.status = 'active';
    t.revokedAt = null;
    const from = t.expiresAt && t.expiresAt > this.#now ? t.expiresAt : this.#now;
    t.expiresAt = new Date(from.getTime() + t.periodDays * 86_400_000);
    t.finished = false;
    return this.#event('RENEWED', t);
  }

  /** Turn off auto-renew. Access continues until the period ends. */
  cancel(originalTransactionId: string): FakeNotification {
    const t = this.#require(originalTransactionId);
    t.willRenew = false;
    t.status = 'canceled';
    return this.#event('CANCELED', t);
  }

  /** Renewal payment failed, access continues while the store retries. */
  enterGrace(originalTransactionId: string): FakeNotification {
    const t = this.#require(originalTransactionId);
    t.status = 'grace';
    return this.#event('GRACE_PERIOD_STARTED', t);
  }

  /** Renewal payment failed, access stops while the store retries. */
  enterHold(originalTransactionId: string): FakeNotification {
    const t = this.#require(originalTransactionId);
    t.status = 'on_hold';
    return this.#event('ON_HOLD', t);
  }

  pause(originalTransactionId: string): FakeNotification {
    const t = this.#require(originalTransactionId);
    t.status = 'paused';
    t.willRenew = false;
    return this.#event('PAUSED', t);
  }

  expire(originalTransactionId: string): FakeNotification {
    const t = this.#require(originalTransactionId);
    t.status = 'expired';
    t.willRenew = false;
    if (!t.expiresAt || t.expiresAt > this.#now) t.expiresAt = this.#now;
    return this.#event('EXPIRED', t);
  }

  /** Refund or chargeback. Access should stop immediately, expiry regardless. */
  refund(originalTransactionId: string): FakeNotification {
    const t = this.#require(originalTransactionId);
    t.status = 'revoked';
    t.revokedAt = this.#now;
    t.willRenew = false;
    return this.#event('REFUND', t);
  }

  /** The store forgets it entirely, as Google does with consumed purchases. */
  forget(originalTransactionId: string): void {
    this.#txns.delete(originalTransactionId);
  }

  /** Whether the app told the store the goods were handed over. */
  finished(originalTransactionId: string): boolean {
    return this.#require(originalTransactionId).finished;
  }

  /** A notification as an HTTP request, the shape a real handler receives. */
  request(note: FakeNotification): Request {
    return new Request('https://example.invalid/tollgate/fake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(note),
    });
  }

  adapter(): StoreAdapter {
    return new FakeAdapter(this);
  }

  // --- used by the adapter -------------------------------------------------

  /** @internal */
  lookup(originalTransactionId: string): FakeTransaction | null {
    this.#tick();
    const t = this.#txns.get(originalTransactionId);
    if (!t) return null;
    // A subscription whose period ran out while nothing was watching reads as
    // expired, without anybody having to send a notification about it. Real
    // stores behave this way and code that only learns about expiry from a
    // webhook keeps serving people who stopped paying.
    if (
      t.kind === 'subscription' && t.status === 'active' &&
      t.expiresAt && t.expiresAt <= this.#now
    ) {
      t.status = 'expired';
      t.willRenew = false;
    }
    return t;
  }

  /** @internal */
  markFinished(originalTransactionId: string): void {
    this.#tick();
    const t = this.#txns.get(originalTransactionId);
    if (t) t.finished = true;
  }

  /** @internal */
  snapshot(t: FakeTransaction): NormalizedPurchase {
    return {
      store: 'fake',
      storeTransactionId: t.storeTransactionId,
      originalTransactionId: t.originalTransactionId,
      storeProductId: t.storeProductId,
      basePlanId: null,
      kind: t.kind,
      status: t.status,
      environment: t.environment,
      offerType: t.offerType,
      purchasedAt: t.purchasedAt.toISOString(),
      expiresAt: t.expiresAt?.toISOString() ?? null,
      willRenew: t.willRenew,
      revokedAt: t.revokedAt?.toISOString() ?? null,
      quantity: t.quantity,
      appAccountToken: t.appAccountToken,
      priceAmountMicros: t.priceAmountMicros,
      priceCurrency: t.priceCurrency,
      raw: { fake: true, renewals: t.renewals },
    };
  }

  #event(type: string, t: FakeTransaction): FakeNotification {
    this.#events += 1;
    return {
      eventId: `fakeevt_${this.#events.toString().padStart(6, '0')}`,
      type,
      originalTransactionId: t.originalTransactionId,
    };
  }

  #require(id: string): FakeTransaction {
    const t = this.#txns.get(id);
    if (!t) throw new Error(`No fake transaction "${id}".`);
    return t;
  }

  /** @internal Consumes a scripted failure, if one is pending. */
  #tick(): void {
    if (this.failNextCalls > 0) {
      this.failNextCalls -= 1;
      throw new TollgateError(
        'store_unavailable',
        'The fake store was told to fail this call.',
      );
    }
  }
}

class FakeAdapter implements StoreAdapter {
  readonly store = 'fake' as const;
  readonly #s: FakeStore;

  constructor(s: FakeStore) {
    this.#s = s;
  }

  verify(req: VerifyRequest): Promise<NormalizedPurchase> {
    const t = this.#s.lookup(req.token);
    if (!t) {
      return Promise.reject(
        new TollgateError(
          'invalid_purchase',
          `The fake store has no purchase "${req.token}".`,
        ),
      );
    }
    // The same check a real adapter has to make: a purchase token travels
    // through a client, so one presented by a user who did not make the
    // purchase must be refused rather than granted to whoever asks first.
    if (t.appAccountToken && t.appAccountToken !== req.appAccountToken) {
      return Promise.reject(
        new TollgateError('not_yours', 'That purchase belongs to somebody else.'),
      );
    }
    return Promise.resolve(this.#s.snapshot(t));
  }

  refresh(ref: PurchaseRef): Promise<NormalizedPurchase | null> {
    const t = this.#s.lookup(ref.originalTransactionId);
    return Promise.resolve(t ? this.#s.snapshot(t) : null);
  }

  async parseNotification(req: Request): Promise<ParsedNotification> {
    let body: FakeNotification;
    try {
      body = await req.json() as FakeNotification;
    } catch (e) {
      throw new TollgateError('bad_signature', 'Unreadable fake notification.', e);
    }
    if (!body?.eventId || !body?.type || !body?.originalTransactionId) {
      throw new TollgateError(
        'bad_signature',
        'That is not a fake store notification.',
      );
    }
    return {
      storeEventId: body.eventId,
      eventType: body.type,
      refs: [{ store: 'fake', originalTransactionId: body.originalTransactionId }],
      payload: body,
    };
  }

  finish(purchase: NormalizedPurchase): Promise<void> {
    this.#s.markFinished(purchase.originalTransactionId);
    return Promise.resolve();
  }

  manageUrl(): string | null {
    return 'https://example.invalid/fake-store/subscriptions';
  }
}
