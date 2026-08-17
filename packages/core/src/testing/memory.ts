/**
 * An in-memory [Persistence], for testing core without a database.
 *
 * It deliberately reimplements the entitlement derivation rather than calling
 * out to anything, so the rules can be exercised in milliseconds. That makes it
 * a second copy of logic whose real home is SQL, which is a risk worth naming:
 * **the SQL pack is authoritative**. `packages/supabase/test` runs the same
 * scenarios against real Postgres, and the two are expected to agree. If they
 * ever disagree, the SQL is right and this file is the bug.
 */

import type {
  EventRecord,
  Persistence,
  RecordResult,
  RevokeResult,
  StoreProduct,
  TollgateConfig,
} from '../persistence.ts';
import type {
  CustomerInfo,
  Entitlement,
  NormalizedPurchase,
  ProductMapping,
  PurchaseRef,
  StoreId,
} from '../types.ts';

export interface MemoryProduct {
  id: string;
  kind: 'subscription' | 'consumable' | 'non_consumable';
  entitlementKey?: string | null;
  grantPayload?: unknown;
  skus: Array<{ store: StoreId; storeProductId: string; basePlanId?: string | null }>;
}

/** The in-process stand-in for a SQL grant hook. */
export type GrantHook = (args: {
  userId: string;
  productId: string;
  payload: unknown;
  purchaseId: string;
}) => unknown;

export type RevokeHook = (args: {
  userId: string;
  productId: string;
  payload: unknown;
  purchaseId: string;
  clawback: 'revoke' | 'keep';
}) => unknown;

interface StoredPurchase extends NormalizedPurchase {
  id: string;
  userId: string;
  productId: string | null;
  grantedAt: string | null;
}

export interface MemoryOptions {
  products?: MemoryProduct[];
  config?: Partial<TollgateConfig>;
  grantHook?: GrantHook;
  revokeHook?: RevokeHook;
  /** Overrides the clock the derivation compares expiry against. */
  now?: () => Date;
}

export class MemoryPersistence implements Persistence {
  readonly customers = new Map<string, CustomerInfo & { flags: string[] }>();
  readonly purchases: StoredPurchase[] = [];
  readonly events = new Map<string, EventRecord & { error?: string | null }>();
  readonly #ents = new Map<string, Map<string, Entitlement>>();
  readonly #aliases = new Map<string, string>();
  readonly #products: MemoryProduct[];
  readonly #config: TollgateConfig;
  readonly #grant?: GrantHook;
  readonly #revoke?: RevokeHook;
  readonly #now: () => Date;
  #seq = 0;

  constructor(opts: MemoryOptions = {}) {
    this.#products = opts.products ?? [];
    this.#grant = opts.grantHook;
    this.#revoke = opts.revokeHook;
    this.#now = opts.now ?? (() => new Date());
    this.#config = {
      grantHook: opts.grantHook ? 'memory' : null,
      revokeHook: opts.revokeHook ? 'memory' : null,
      clawback: 'revoke',
      graceDays: 3,
      sandbox: 'deny',
      ...opts.config,
    };
  }

  config(): Promise<TollgateConfig> {
    return Promise.resolve({ ...this.#config });
  }

  ensureCustomer(userId: string): Promise<CustomerInfo> {
    let c = this.customers.get(userId);
    if (!c) {
      c = {
        userId,
        appAccountToken: crypto.randomUUID(),
        entitlements: {},
        flaggedAt: null,
        flagReason: null,
        flags: [],
      };
      this.customers.set(userId, c);
    }
    return Promise.resolve({ ...c, entitlements: this.#entMap(userId) });
  }

  userForAlias(store: StoreId, alias: string): Promise<string | null> {
    return Promise.resolve(this.#aliases.get(`${store}:${alias}`) ?? null);
  }

  userForAppAccountToken(token: string): Promise<string | null> {
    for (const c of this.customers.values()) {
      if (c.appAccountToken === token) return Promise.resolve(c.userId);
    }
    return Promise.resolve(null);
  }

  linkAlias(userId: string, store: StoreId, alias: string): Promise<void> {
    this.#aliases.set(`${store}:${alias}`, userId);
    return Promise.resolve();
  }

  async recordPurchase(
    userId: string,
    p: NormalizedPurchase,
  ): Promise<RecordResult> {
    await this.ensureCustomer(userId);
    const mapping = await this.productFor(
      p.store,
      p.storeProductId,
      p.basePlanId,
    );

    const key = `${p.store}:${p.storeTransactionId}`;
    let row = this.purchases.find(
      (x) => `${x.store}:${x.storeTransactionId}` === key,
    );
    const created = !row;
    if (row) {
      Object.assign(row, p, { productId: mapping?.productId ?? null });
    } else {
      this.#seq += 1;
      row = {
        ...p,
        id: `pur_${this.#seq}`,
        userId,
        productId: mapping?.productId ?? null,
        grantedAt: null,
      };
      this.purchases.push(row);
    }

    let granted = false;
    let grantResult: unknown = null;
    // Exactly-once: the delivered stamp is what gates the hook, not whether
    // the row was new. A store redelivering a consumable purchase produces the
    // same transaction id, lands here again, and pays out nothing.
    if (
      mapping?.kind === 'consumable' && !row.grantedAt &&
      row.status === 'active' && !row.revokedAt
    ) {
      if (this.#grant) {
        grantResult = this.#grant({
          userId,
          productId: mapping.productId,
          payload: mapping.grantPayload,
          purchaseId: row.id,
        });
      }
      row.grantedAt = this.#now().toISOString();
      granted = true;
    }

    this.#recompute(userId);
    return {
      created,
      purchaseId: row.id,
      productId: row.productId,
      kind: mapping?.kind ?? null,
      granted,
      delivered: row.grantedAt != null,
      grantResult,
      entitlements: await this.entitlements(userId),
    };
  }

  async revokePurchase(
    ref: PurchaseRef,
    reason: string,
    detail?: string | null,
  ): Promise<RevokeResult> {
    const row = this.purchases.find(
      (x) =>
        x.store === ref.store &&
        (x.originalTransactionId === ref.originalTransactionId ||
          x.storeTransactionId === ref.storeTransactionId),
    );
    if (!row) {
      return {
        found: false,
        clawedBack: false,
        clawbackResult: null,
        entitlements: [],
      };
    }

    const now = this.#now().toISOString();
    row.status = 'revoked';
    row.revokedAt = now;
    row.willRenew = false;

    const c = this.customers.get(row.userId)!;
    c.flaggedAt = now;
    c.flagReason = reason;
    c.flags.push(`${reason}: ${detail ?? ''}`);

    let clawedBack = false;
    let clawbackResult: unknown = null;
    const mapping = row.productId
      ? this.#products.find((p) => p.id === row!.productId)
      : null;
    if (mapping?.kind === 'consumable' && row.grantedAt && this.#revoke) {
      clawbackResult = this.#revoke({
        userId: row.userId,
        productId: mapping.id,
        payload: mapping.grantPayload,
        purchaseId: row.id,
        clawback: this.#config.clawback,
      });
      clawedBack = true;
    }

    this.#recompute(row.userId);
    return {
      found: true,
      clawedBack,
      clawbackResult,
      entitlements: await this.entitlements(row.userId),
    };
  }

  recordEvent(event: EventRecord): Promise<boolean> {
    const key = `${event.store}:${event.storeEventId}`;
    if (this.events.has(key)) return Promise.resolve(false);
    this.events.set(key, { ...event });
    return Promise.resolve(true);
  }

  finishEvent(
    store: StoreId,
    storeEventId: string,
    error?: string | null,
  ): Promise<void> {
    const e = this.events.get(`${store}:${storeEventId}`);
    if (e) e.error = error ?? null;
    return Promise.resolve();
  }

  /**
   * The customer's entitlements, with `active` evaluated against the clock
   * right now rather than against whenever they were last written.
   *
   * The stored `active` is a cache: it is what the store said at write time,
   * and it is what a realtime subscriber gets pushed. It cannot stay true by
   * itself, because the commonest way to stop being entitled is for time to
   * pass and nothing at all to happen. Every read applies the expiry, and the
   * SQL pack does the same in `get_entitlements` and `has_entitlement`.
   */
  entitlements(userId: string): Promise<Entitlement[]> {
    const rows = [...(this.#ents.get(userId)?.values() ?? [])];
    return Promise.resolve(rows.map((e) => ({
      ...e,
      active: e.active && this.#withinWindow(e.expiresAt),
    })));
  }

  /** Whether an expiry is still inside the configured slack. */
  #withinWindow(expiresAt: string | null): boolean {
    if (expiresAt == null) return true;
    const graceMs = this.#config.graceDays * 86_400_000;
    return Date.parse(expiresAt) > this.#now().getTime() - graceMs;
  }

  storeProducts(store: StoreId): Promise<StoreProduct[]> {
    const out: StoreProduct[] = [];
    for (const p of this.#products) {
      for (const sku of p.skus) {
        if (sku.store !== store) continue;
        out.push({
          productId: p.id,
          kind: p.kind,
          entitlementKey: p.entitlementKey ?? null,
          storeProductId: sku.storeProductId,
          basePlanId: sku.basePlanId ?? null,
        });
      }
    }
    return Promise.resolve(out);
  }

  productFor(
    store: StoreId,
    storeProductId: string,
    basePlanId?: string | null,
  ): Promise<ProductMapping | null> {
    for (const p of this.#products) {
      for (const sku of p.skus) {
        if (
          sku.store === store && sku.storeProductId === storeProductId &&
          (sku.basePlanId ?? null) === (basePlanId ?? null)
        ) {
          return Promise.resolve({
            productId: p.id,
            kind: p.kind,
            entitlementKey: p.entitlementKey ?? null,
            grantPayload: p.grantPayload ?? null,
            store,
            storeProductId,
            basePlanId: sku.basePlanId ?? null,
          });
        }
      }
    }
    return Promise.resolve(null);
  }

  livePurchases(userId: string): Promise<PurchaseRef[]> {
    const seen = new Set<string>();
    const refs: PurchaseRef[] = [];
    for (const p of this.purchases) {
      if (p.userId !== userId) continue;
      // Consumables are done once delivered; there is nothing left for a store
      // to change about them except a refund, which arrives as a notification.
      if (p.kind === 'consumable') continue;
      const key = `${p.store}:${p.originalTransactionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        store: p.store,
        originalTransactionId: p.originalTransactionId,
        storeTransactionId: p.storeTransactionId,
        storeProductId: p.storeProductId,
        kind: p.kind,
      });
    }
    return Promise.resolve(refs);
  }

  // --- derivation ----------------------------------------------------------

  #entMap(userId: string): Record<string, Entitlement> {
    const out: Record<string, Entitlement> = {};
    for (const [k, v] of this.#ents.get(userId) ?? []) out[k] = v;
    return out;
  }

  /**
   * Rebuild every entitlement this customer has ever touched from their
   * purchases. Mirrors `tollgate.recompute_entitlements`.
   */
  #recompute(userId: string): void {
    const now = this.#now();
    const graceMs = this.#config.graceDays * 86_400_000;
    const byKey = new Map<string, StoredPurchase[]>();

    for (const p of this.purchases) {
      if (p.userId !== userId || !p.productId) continue;
      const product = this.#products.find((x) => x.id === p.productId);
      const key = product?.entitlementKey;
      if (!key) continue;
      const list = byKey.get(key) ?? [];
      list.push(p);
      byKey.set(key, list);
    }

    const map = this.#ents.get(userId) ?? new Map<string, Entitlement>();
    for (const [key, list] of byKey) {
      const scored = list.map((p) => ({ p, entitles: this.#entitles(p, now, graceMs) }));
      // The winner is whatever keeps them entitled longest. An entitling
      // purchase always beats a non-entitling one, so an old expired row can
      // never shadow a fresh subscription bought on another store.
      scored.sort((a, b) => {
        if (a.entitles !== b.entitles) return a.entitles ? -1 : 1;
        const ax = a.p.expiresAt ? Date.parse(a.p.expiresAt) : Infinity;
        const bx = b.p.expiresAt ? Date.parse(b.p.expiresAt) : Infinity;
        if (ax !== bx) return bx - ax;
        return Date.parse(b.p.purchasedAt) - Date.parse(a.p.purchasedAt);
      });
      const best = scored[0];
      const prior = map.get(key);
      const unsub = best.p.status === 'canceled' || !best.p.willRenew;
      const billing = best.p.status === 'grace' || best.p.status === 'on_hold';
      map.set(key, {
        key,
        // Store eligibility only, with no clock in it. The expiry is applied
        // on read; see [entitlements].
        active: this.#eligible(best.p),
        store: best.p.store,
        productId: best.p.productId,
        periodStart: best.p.purchasedAt,
        expiresAt: best.p.expiresAt,
        willRenew: best.p.willRenew,
        inGracePeriod: best.p.status === 'grace',
        unsubscribeDetectedAt: unsub
          ? prior?.unsubscribeDetectedAt ?? now.toISOString()
          : null,
        billingIssueDetectedAt: billing
          ? prior?.billingIssueDetectedAt ?? now.toISOString()
          : null,
      });
    }
    this.#ents.set(userId, map);
  }

  /**
   * Whether the store's own account of this purchase says it should entitle,
   * ignoring the clock entirely.
   *
   * `canceled` is in the list because a cancelled subscription is still paid
   * for; what ends it is the expiry, which is applied separately.
   */
  #eligible(p: StoredPurchase): boolean {
    if (p.revokedAt) return false;
    return p.status === 'active' || p.status === 'grace' ||
      p.status === 'canceled';
  }

  /** Store eligibility and the clock together. Used to rank rival purchases. */
  #entitles(p: StoredPurchase, now: Date, graceMs: number): boolean {
    if (!this.#eligible(p)) return false;
    // The configured window is slack on top of whatever the store said, to
    // absorb the gap between a renewal being charged and anyone being told.
    const expiry = p.expiresAt ? Date.parse(p.expiresAt) : null;
    return expiry == null || expiry > now.getTime() - graceMs;
  }
}
