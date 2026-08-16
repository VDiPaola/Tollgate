/**
 * [Persistence] over the SQL pack.
 *
 * Every method here is one RPC. That is the design, not laziness: the SQL
 * functions each do their whole job in one transaction, and reproducing them as
 * several calls from here would reintroduce exactly the partial-failure gaps
 * they exist to close.
 *
 * Requires the `tollgate` schema to be exposed to PostgREST. In a Supabase
 * project that is `[api] schemas = ["public", "tollgate"]` in config.toml, or
 * the matching setting in the dashboard. Without it every call here comes back
 * as a 404 that reads like a missing function.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  type CustomerInfo,
  type Entitlement,
  type EventRecord,
  type NormalizedPurchase,
  type Persistence,
  type ProductMapping,
  type PurchaseRef,
  type RecordResult,
  type RevokeResult,
  type StoreId,
  TollgateError,
  type TollgateConfig,
} from '@tollgate/core';

// deno-lint-ignore no-explicit-any
type Json = any;

export interface SupabasePersistenceOptions {
  /**
   * A client holding the SERVICE ROLE key. Every function in the pack except
   * the two `my_*` readers is revoked from everyone else, so an anon client
   * gets permission errors rather than wrong answers.
   */
  client: SupabaseClient;
  /** How long the config is cached in this isolate. It changes about never. */
  configTtlMs?: number;
}

export class SupabasePersistence implements Persistence {
  readonly #db: SupabaseClient;
  readonly #ttl: number;
  #config: { value: TollgateConfig; at: number } | null = null;

  constructor(opts: SupabasePersistenceOptions) {
    this.#db = opts.client;
    this.#ttl = opts.configTtlMs ?? 60_000;
  }

  async config(): Promise<TollgateConfig> {
    if (this.#config && Date.now() - this.#config.at < this.#ttl) {
      return this.#config.value;
    }
    const value = await this.#rpc<TollgateConfig>('get_config', {});
    this.#config = { value, at: Date.now() };
    return value;
  }

  async ensureCustomer(userId: string): Promise<CustomerInfo> {
    const row = await this.#rpc<Json>('ensure_customer', { p_user: userId });
    return {
      userId: row.userId,
      appAccountToken: row.appAccountToken,
      flaggedAt: row.flaggedAt ?? null,
      flagReason: row.flagReason ?? null,
      entitlements: byKey(row.entitlements ?? []),
    };
  }

  userForAlias(store: StoreId, alias: string): Promise<string | null> {
    return this.#rpc<string | null>('user_for_alias', {
      p_store: store,
      p_alias: alias,
    });
  }

  userForAppAccountToken(token: string): Promise<string | null> {
    return this.#rpc<string | null>('user_for_token', { p_token: token });
  }

  async linkAlias(
    userId: string,
    store: StoreId,
    alias: string,
  ): Promise<void> {
    await this.#rpc('link_alias', {
      p_user: userId,
      p_store: store,
      p_alias: alias,
    });
  }

  async recordPurchase(
    userId: string,
    purchase: NormalizedPurchase,
  ): Promise<RecordResult> {
    const row = await this.#rpc<Json>('record_purchase', {
      p_user: userId,
      // Sent whole, including `raw`. The SQL reads the fields it knows and the
      // rest is kept for replay, which is what makes an unmapped SKU or a
      // mis-normalised field recoverable rather than lost.
      p: purchase,
    });
    return {
      created: !!row.created,
      purchaseId: row.purchaseId,
      productId: row.productId ?? null,
      kind: row.kind ?? null,
      granted: !!row.granted,
      grantResult: row.grantResult ?? null,
      entitlements: (row.entitlements ?? []) as Entitlement[],
    };
  }

  async revokePurchase(
    ref: PurchaseRef,
    reason: string,
    detail?: string | null,
  ): Promise<RevokeResult> {
    const row = await this.#rpc<Json>('revoke_purchase', {
      p_store: ref.store,
      p_original: ref.originalTransactionId,
      p_txn: ref.storeTransactionId ?? null,
      p_reason: reason,
      p_detail: detail ?? null,
    });
    return {
      found: !!row.found,
      clawedBack: !!row.clawedBack,
      clawbackResult: row.clawbackResult ?? null,
      entitlements: (row.entitlements ?? []) as Entitlement[],
    };
  }

  recordEvent(event: EventRecord): Promise<boolean> {
    return this.#rpc<boolean>('record_event', {
      p_store: event.store,
      p_event_id: event.storeEventId,
      p_type: event.eventType,
      p_user: event.userId ?? null,
      p_payload: event.payload ?? null,
    });
  }

  async finishEvent(
    store: StoreId,
    storeEventId: string,
    error?: string | null,
  ): Promise<void> {
    await this.#rpc('finish_event', {
      p_store: store,
      p_event_id: storeEventId,
      p_error: error ?? null,
    });
  }

  async entitlements(userId: string): Promise<Entitlement[]> {
    const rows = await this.#rpc<Entitlement[]>('get_entitlements', {
      p_user: userId,
    });
    return rows ?? [];
  }

  async productFor(
    store: StoreId,
    storeProductId: string,
    basePlanId?: string | null,
  ): Promise<ProductMapping | null> {
    const row = await this.#rpc<Json>('product_for', {
      p_store: store,
      p_store_product_id: storeProductId,
      p_base_plan_id: basePlanId ?? null,
    });
    return row ?? null;
  }

  async livePurchases(userId: string): Promise<PurchaseRef[]> {
    const rows = await this.#rpc<PurchaseRef[]>('live_purchases', {
      p_user: userId,
    });
    return rows ?? [];
  }

  async #rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.#db
      .schema('tollgate')
      // deno-lint-ignore no-explicit-any
      .rpc(fn as any, args as any);
    if (error) {
      throw new TollgateError(
        'persistence_failed',
        `tollgate.${fn} failed: ${error.message}`,
        error,
      );
    }
    return data as T;
  }
}

function byKey(list: Entitlement[]): Record<string, Entitlement> {
  const out: Record<string, Entitlement> = {};
  for (const e of list) out[e.key] = e;
  return out;
}
