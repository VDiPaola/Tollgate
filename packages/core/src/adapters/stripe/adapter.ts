/**
 * Stripe.
 *
 * The web half. Where the mobile adapters wrap a store that owns the whole
 * transaction, this one sits alongside a checkout the host app already runs:
 * Stripe has no opinion about currencies, tax or what a subscription costs in
 * Norway, and every app that sells through it has already answered those
 * questions its own way. Tollgate deliberately does not take that over. It
 * verifies what was bought, records it, and keeps it in step.
 *
 * Consequently there is no "create a checkout" here. The app creates the
 * subscription or payment intent as it always did, and hands the id over.
 *
 * Talks to Stripe over plain REST rather than the `stripe` npm package, which
 * is Node-only, and verifies webhook signatures with Web Crypto rather than
 * `stripe.webhooks.constructEvent`, for the same reason.
 */

import type {
  ParsedNotification,
  StoreAdapter,
  VerifyRequest,
} from '../../adapter.ts';
import { TollgateError } from '../../errors.ts';
import type { NormalizedPurchase, PurchaseRef } from '../../types.ts';
import { hmacSha256Hex, timingSafeEqual } from '../../crypto/hmac.ts';
import { normalizePaymentIntent, normalizeSubscription } from './normalize.ts';
import type { StripeContext } from './normalize.ts';
import type {
  StripeCharge,
  StripeCustomer,
  StripeEvent,
  StripePaymentIntent,
  StripeSubscription,
} from './types.ts';

const API = 'https://api.stripe.com/v1';

export interface StripeAdapterOptions {
  /** A restricted or secret key. Never a publishable one. */
  secretKey: string;
  /** The endpoint's signing secret, `whsec_…`. Required to accept webhooks. */
  webhookSecret?: string;
  /**
   * Pinned deliberately. An unpinned client speaks whatever version the
   * dashboard is set to, so somebody upgrading it reshapes responses under code
   * that was written against the old ones.
   */
  apiVersion?: string;
  /**
   * The metadata key carrying the Tollgate account token. Set it on the Stripe
   * customer, or on the subscription or payment intent, at creation.
   *
   * Stripe knows nothing about an app's users, so without this a webhook about
   * a renewal names a subscription and a customer and nobody.
   */
  accountTokenKey?: string;
  /**
   * The metadata key naming what was bought, for payments with no Price
   * attached. A one-off charge carries an amount and nothing about its purpose.
   */
  productKey?: string;
  /** How far a webhook's timestamp may be from now, in seconds. */
  toleranceSeconds?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class StripeAdapter implements StoreAdapter {
  readonly store = 'stripe' as const;

  readonly #key: string;
  readonly #webhookSecret?: string;
  readonly #apiVersion: string;
  readonly #ctx: Omit<StripeContext, 'customerMetadata'>;
  readonly #tolerance: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(opts: StripeAdapterOptions) {
    if (!opts.secretKey) {
      throw TollgateError.invalidRequest('StripeAdapter needs a secretKey.');
    }
    if (opts.secretKey.startsWith('pk_')) {
      // A publishable key is meant to be in a web page. Anything reaching this
      // constructor with one has almost certainly put the secret somewhere it
      // should not be, and the API errors it produces would not say so.
      throw TollgateError.invalidRequest(
        'That is a publishable key. StripeAdapter needs a secret key.',
      );
    }
    this.#key = opts.secretKey;
    this.#webhookSecret = opts.webhookSecret;
    this.#apiVersion = opts.apiVersion ?? '2026-07-29.dahlia';
    this.#ctx = {
      accountTokenKey: opts.accountTokenKey ?? 'tollgate_account_token',
      productKey: opts.productKey ?? 'tollgate_product',
    };
    this.#tolerance = opts.toleranceSeconds ?? 300;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? (() => Date.now());
  }

  // --- purchases -----------------------------------------------------------

  async verify(req: VerifyRequest): Promise<NormalizedPurchase> {
    const purchase = await this.#read({
      store: 'stripe',
      originalTransactionId: req.token,
      kind: req.kind,
    });
    if (!purchase) {
      throw new TollgateError(
        'invalid_purchase',
        'Stripe has no record of that payment.',
      );
    }

    // An id travels through a client, so one presented by somebody who did not
    // make the payment must be refused rather than granted to whoever asks
    // first. Unlike the mobile stores, this token is only present because the
    // host app put it in metadata; when it did not, the ownership check falls
    // to the customer alias the orchestrator stores instead.
    if (
      purchase.appAccountToken &&
      purchase.appAccountToken !== req.appAccountToken
    ) {
      throw new TollgateError(
        'not_yours',
        'That payment belongs to a different account.',
      );
    }

    return purchase;
  }

  refresh(ref: PurchaseRef): Promise<NormalizedPurchase | null> {
    return this.#read(ref);
  }

  /**
   * Read a subscription or a payment, chosen by the shape of the id.
   *
   * Stripe ids carry their own type, which makes this the one store where the
   * caller never has to say what kind of thing it is asking about.
   */
  async #read(ref: PurchaseRef): Promise<NormalizedPurchase | null> {
    const id = ref.originalTransactionId;

    if (id.startsWith('sub_')) {
      const sub = await this.#get<StripeSubscription>(`/subscriptions/${id}`);
      if (!sub) return null;
      return normalizeSubscription(sub, {
        ...this.#ctx,
        customerMetadata: await this.#customerMetadata(sub.customer),
      });
    }

    if (id.startsWith('pi_')) {
      const intent = await this.#get<StripePaymentIntent>(
        `/payment_intents/${id}`,
      );
      if (!intent) return null;
      return normalizePaymentIntent(intent, {
        ...this.#ctx,
        customerMetadata: await this.#customerMetadata(intent.customer),
      });
    }

    throw TollgateError.invalidRequest(
      `"${id}" is not a Stripe subscription or payment intent id.`,
    );
  }

  /**
   * The customer's metadata, where the account token usually lives.
   *
   * Put on the customer rather than the subscription by most integrations,
   * because it describes who they are rather than what they bought. Failing to
   * read it is not fatal: the orchestrator also stores the customer id as an
   * alias, which resolves everything after the first purchase.
   */
  async #customerMetadata(
    customer: string | { id?: string } | undefined,
  ): Promise<Record<string, string> | undefined> {
    const id = typeof customer === 'string' ? customer : customer?.id;
    if (!id) return undefined;
    try {
      const record = await this.#get<StripeCustomer>(`/customers/${id}`);
      if (!record || record.deleted) return undefined;
      return record.metadata;
    } catch {
      return undefined;
    }
  }

  /**
   * Nothing to do. Stripe has no acknowledgement step: a payment either
   * succeeded or it did not, and nothing is auto-refunded for want of a
   * confirmation.
   */
  finish(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Null, deliberately.
   *
   * Cancelling a Stripe subscription is an API call the host app makes, not a
   * page to send somebody to. The customer portal exists but has to be
   * configured and its session created per visit, which is the app's business
   * rather than this adapter's.
   */
  manageUrl(): string | null {
    return null;
  }

  // --- notifications -------------------------------------------------------

  async parseNotification(req: Request): Promise<ParsedNotification> {
    if (!this.#webhookSecret) {
      throw TollgateError.invalidRequest(
        'StripeAdapter cannot accept webhooks without a webhookSecret.',
      );
    }

    // The raw body, byte for byte. Parsing and re-serialising changes key order
    // and whitespace, and the signature is over exactly what was sent.
    const body = await req.text();
    const header = req.headers.get('stripe-signature') ?? '';
    await this.#verifySignature(body, header);

    let event: StripeEvent;
    try {
      event = JSON.parse(body) as StripeEvent;
    } catch (e) {
      throw new TollgateError('bad_signature', 'Unreadable Stripe event.', e);
    }

    const object = event.data?.object ?? {};
    const type = event.type ?? 'unknown';
    const { refs, revoked } = refsOf(type, object);

    return {
      storeEventId: event.id ?? `${type}:${this.#now()}`,
      eventType: type,
      refs,
      revoked,
      payload: event,
    };
  }

  async #verifySignature(body: string, header: string): Promise<void> {
    // `t=1614…,v1=abc…,v1=def…` — more than one v1 during a secret rollover.
    const parts = header.split(',').map((p) => p.trim());
    const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
    const signatures = parts
      .filter((p) => p.startsWith('v1='))
      .map((p) => p.slice(3));

    if (!timestamp || signatures.length === 0) {
      throw new TollgateError(
        'bad_signature',
        'Stripe signature header is missing or malformed.',
      );
    }

    const age = Math.abs(this.#now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > this.#tolerance) {
      // Without this, a signature captured once is valid for ever, and a
      // replayed webhook is indistinguishable from a real one.
      throw new TollgateError(
        'bad_signature',
        'Stripe signature is too old; it may be a replay.',
      );
    }

    const expected = await hmacSha256Hex(
      this.#webhookSecret!,
      `${timestamp}.${body}`,
    );
    if (!signatures.some((s) => timingSafeEqual(s, expected))) {
      throw new TollgateError(
        'bad_signature',
        'Stripe signature does not verify.',
      );
    }
  }

  // --- HTTP ----------------------------------------------------------------

  async #get<T>(path: string): Promise<T | null> {
    const res = await this.#fetch(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${this.#key}`,
        'stripe-version': this.#apiVersion,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new TollgateError(
        res.status >= 500 || res.status === 429
          ? 'store_unavailable'
          : 'invalid_request',
        `Stripe returned ${res.status} for ${path}. ${detail}`,
      );
    }
    return await res.json() as T;
  }
}

// --- event shapes -----------------------------------------------------------

/**
 * Which purchases an event is about, split by whether it is the news that one
 * was taken back.
 *
 * A refund cannot be discovered by re-reading a payment intent: it still
 * reports `succeeded`, with the refund recorded against the charge instead. So
 * refund events are trusted for that and only that, exactly as on Google.
 */
function refsOf(
  type: string,
  object: Record<string, unknown>,
): { refs: PurchaseRef[]; revoked: PurchaseRef[] } {
  const refs: PurchaseRef[] = [];
  const revoked: PurchaseRef[] = [];

  const id = object.id as string | undefined;

  if (type.startsWith('customer.subscription.') && id) {
    refs.push({
      store: 'stripe',
      originalTransactionId: id,
      kind: 'subscription',
    });
    return { refs, revoked };
  }

  if (type.startsWith('payment_intent.') && id) {
    refs.push({ store: 'stripe', originalTransactionId: id });
    return { refs, revoked };
  }

  // A refund or a dispute. Both name a charge, and the charge names the
  // payment it reverses.
  if (type === 'charge.refunded' || type.startsWith('charge.dispute.')) {
    const charge = object as StripeCharge;
    const intent = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
    if (intent) {
      revoked.push({ store: 'stripe', originalTransactionId: intent });
    }
    return { refs, revoked };
  }

  // Invoices, prices, customers and the rest. Recorded for the audit trail and
  // otherwise ignored: subscription state changes arrive as their own events.
  return { refs, revoked };
}
