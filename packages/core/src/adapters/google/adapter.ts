/**
 * Google Play.
 *
 * Play Billing 8 on the client, the Play Developer API v3 on the server, and
 * real-time developer notifications over Cloud Pub/Sub. See
 * `docs/google-setup.md` for what has to exist in the two consoles before any
 * of this works.
 *
 * The thing to hold on to: Play has no test environment. Test purchases arrive
 * through the same API with the same credentials, marked by a field, so the
 * only defence against a licence tester's purchase granting production access
 * is that flag being carried faithfully into [NormalizedPurchase.environment].
 */

import type {
  ParsedNotification,
  StoreAdapter,
  VerifyRequest,
} from '../../adapter.ts';
import { TollgateError } from '../../errors.ts';
import type { NormalizedPurchase, PurchaseRef } from '../../types.ts';
import { verifyGoogleIdToken } from '../../crypto/jwt.ts';
import { base64ToBytes, fromUtf8 } from '../../crypto/encoding.ts';
import { GoogleAuth, parseServiceAccount, type ServiceAccount } from './auth.ts';
import { normalizeProduct, normalizeSubscription } from './normalize.ts';
import {
  type DeveloperNotification,
  ONE_TIME_PRODUCT_NOTIFICATION,
  type ProductPurchase,
  type ProductPurchaseV2,
  type PubSubPush,
  SUBSCRIPTION_NOTIFICATION,
  type SubscriptionPurchaseV2,
} from './types.ts';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

export interface GoogleAdapterOptions {
  /** The applicationId, which must match the Play Console entry exactly. */
  packageName: string;
  /** The service account key: base64-encoded JSON, raw JSON, or parsed. */
  serviceAccount: string | ServiceAccount;
  /**
   * The audience configured on the Pub/Sub push subscription, normally the
   * endpoint's own URL. Required to accept notifications: without it there is
   * nothing stopping a token minted for another service being replayed here.
   */
  pubsubAudience?: string;
  /** The service account Pub/Sub signs its pushes as. */
  pubsubServiceAccountEmail?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GoogleAdapter implements StoreAdapter {
  readonly store = 'google' as const;

  readonly #packageName: string;
  readonly #auth: GoogleAuth;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #audience?: string;
  readonly #pushEmail?: string;

  constructor(opts: GoogleAdapterOptions) {
    if (!opts.packageName) {
      throw TollgateError.invalidRequest('GoogleAdapter needs a packageName.');
    }
    this.#packageName = opts.packageName;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? (() => Date.now());
    this.#audience = opts.pubsubAudience;
    this.#pushEmail = opts.pubsubServiceAccountEmail;
    this.#auth = new GoogleAuth(
      typeof opts.serviceAccount === 'string'
        ? parseServiceAccount(opts.serviceAccount)
        : opts.serviceAccount,
      this.#fetch,
    );
  }

  // --- purchases -----------------------------------------------------------

  async verify(req: VerifyRequest): Promise<NormalizedPurchase> {
    const purchase = await this.#read({
      store: 'google',
      originalTransactionId: req.token,
      storeProductId: req.storeProductId,
      kind: req.kind,
    });
    if (!purchase) {
      throw new TollgateError(
        'invalid_purchase',
        'Google Play has no record of that purchase.',
      );
    }

    // A purchase token travels through a client, so one presented by somebody
    // who did not make the purchase must be refused rather than granted to
    // whoever asks first. The token is set by the app at purchase time through
    // setObfuscatedAccountId, and comes back on the API response.
    if (
      purchase.appAccountToken &&
      purchase.appAccountToken !== req.appAccountToken
    ) {
      throw new TollgateError(
        'not_yours',
        'That purchase belongs to a different account.',
      );
    }

    return purchase;
  }

  refresh(ref: PurchaseRef): Promise<NormalizedPurchase | null> {
    return this.#read(ref);
  }

  /**
   * Fetch a purchase, choosing the endpoint from what kind of thing it is.
   *
   * Play splits subscriptions and one-time products across two resources with
   * different URL shapes and different response bodies, and there is no way to
   * ask "whatever this token is". An unknown kind is read as a subscription,
   * because that is the only one whose endpoint does not also need a product id.
   */
  async #read(ref: PurchaseRef): Promise<NormalizedPurchase | null> {
    const oneOff = ref.kind === 'consumable' || ref.kind === 'non_consumable';

    if (oneOff) {
      // productsv2, not products. Billing 8 lets a one-time product carry
      // several purchase options and offers, and the v1 response has nowhere
      // to put them. v2 also takes the token alone, so the product id is only
      // needed as a fallback for naming the row.
      const body = await this.#get<ProductPurchaseV2>(
        `/purchases/productsv2/tokens/${
          encodeURIComponent(ref.originalTransactionId)
        }`,
      );
      if (!body) return null;
      return normalizeProduct(body, {
        purchaseToken: ref.originalTransactionId,
        productId: ref.storeProductId,
        consumable: ref.kind === 'consumable',
      });
    }

    const body = await this.#get<SubscriptionPurchaseV2>(
      `/purchases/subscriptionsv2/tokens/${
        encodeURIComponent(ref.originalTransactionId)
      }`,
    );
    if (body) {
      return normalizeSubscription(body, {
        purchaseToken: ref.originalTransactionId,
        fallbackProductId: ref.storeProductId,
      });
    }

    // Nothing there, and nobody told us what this token is. It may well be a
    // one-time purchase, which lives on the other endpoint, so try that before
    // concluding the purchase does not exist.
    //
    // Worth the extra request because of how the failure reads otherwise: a
    // real, paid-for gem pack looked up on the subscriptions endpoint answers
    // 404, and the customer is told Google Play has no record of a purchase
    // they have just made and been charged for.
    if (ref.kind === undefined) {
      const product = await this.#get<ProductPurchaseV2>(
        `/purchases/productsv2/tokens/${
          encodeURIComponent(ref.originalTransactionId)
        }`,
      );
      if (product) {
        return normalizeProduct(product, {
          purchaseToken: ref.originalTransactionId,
          productId: ref.storeProductId,
          // Unknown, and the catalogue corrects it when the purchase is
          // recorded. Guessing consumable here would consume something that
          // should only have been acknowledged.
          consumable: false,
        });
      }
    }

    return null;
  }

  /**
   * Tell Play the goods were handed over.
   *
   * Two different obligations wearing one name. A subscription or a
   * non-consumable is **acknowledged**, and Play auto-refunds anything left
   * unacknowledged for three days. A consumable is **consumed**, which
   * acknowledges it and also makes it buyable again; without that the customer
   * can never buy a second gem pack.
   *
   * The orchestrator only calls this after the purchase is recorded and any
   * grant has run, which is the order that matters: Play forgets consumed
   * purchases and Billing 8 removed the ability to query them back, so
   * consuming first and crashing loses the purchase with no way to recover it.
   */
  async finish(purchase: NormalizedPurchase): Promise<void> {
    if (this.#alreadyFinished(purchase)) return;

    const token = encodeURIComponent(purchase.originalTransactionId);
    const sku = encodeURIComponent(purchase.storeProductId);

    if (purchase.kind === 'subscription') {
      await this.#post(
        `/purchases/subscriptions/${sku}/tokens/${token}:acknowledge`,
      );
      return;
    }
    if (purchase.kind === 'consumable') {
      await this.#post(`/purchases/products/${sku}/tokens/${token}:consume`);
      return;
    }
    await this.#post(`/purchases/products/${sku}/tokens/${token}:acknowledge`);
  }

  /**
   * Whether Play already considers this settled.
   *
   * Read from the stored response rather than by asking again. Play answers 400
   * to acknowledging twice, and while a failed finish is only logged, a
   * predictable error every time a notification arrives is noise that hides
   * real ones.
   */
  #alreadyFinished(purchase: NormalizedPurchase): boolean {
    // Three response shapes end up in `raw`: a subscription, a productsv2
    // one-time purchase, and a v1 one-time purchase on rows written before the
    // move to v2. The enums and the integers mean the same things.
    const raw = purchase.raw as
      | (SubscriptionPurchaseV2 & ProductPurchaseV2 & ProductPurchase)
      | undefined;
    if (!raw) return false;

    if (purchase.kind === 'consumable') {
      const v2 = raw.productLineItem?.[0]?.productOfferDetails?.consumptionState;
      if (v2) return v2 === 'CONSUMPTION_STATE_CONSUMED';
      return raw.consumptionState === 1;
    }
    return raw.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' ||
      raw.acknowledgementState === 1;
  }

  /**
   * Where to cancel. An in-app subscription cannot be cancelled from inside the
   * app, so this deep link into Play's own management screen is the honest
   * answer rather than a button that cannot work.
   */
  manageUrl(purchase: NormalizedPurchase): string | null {
    const sku = encodeURIComponent(purchase.storeProductId);
    const pkg = encodeURIComponent(this.#packageName);
    return `https://play.google.com/store/account/subscriptions?sku=${sku}&package=${pkg}`;
  }

  // --- notifications -------------------------------------------------------

  /**
   * Verify and translate a Pub/Sub push.
   *
   * The endpoint this arrives at is public, so the signed token in the
   * Authorization header is the entire access control. Everything below the
   * verification assumes the payload is genuinely Google's.
   */
  async parseNotification(req: Request): Promise<ParsedNotification> {
    await this.#verifyPush(req);

    let envelope: PubSubPush;
    try {
      envelope = await req.json() as PubSubPush;
    } catch (e) {
      throw new TollgateError('bad_signature', 'Unreadable Pub/Sub body.', e);
    }

    const data = envelope.message?.data;
    if (!data) {
      throw new TollgateError('bad_signature', 'Pub/Sub message carried no data.');
    }

    let note: DeveloperNotification;
    try {
      note = JSON.parse(fromUtf8(base64ToBytes(data))) as DeveloperNotification;
    } catch (e) {
      throw new TollgateError(
        'bad_signature',
        'Pub/Sub message data is not a developer notification.',
        e,
      );
    }

    // One Cloud project can serve several apps, and a subscription pointed at
    // the wrong topic is a configuration mistake that would otherwise show up
    // as purchases silently attributed to the wrong product catalogue.
    if (note.packageName && note.packageName !== this.#packageName) {
      throw new TollgateError(
        'invalid_request',
        `Notification is for "${note.packageName}", not "${this.#packageName}".`,
      );
    }

    const storeEventId = envelope.message?.messageId ??
      envelope.message?.message_id ??
      // Pub/Sub always sets a message id, but a replay harness might not, and
      // an event with no id would otherwise be processed on every delivery.
      `${note.packageName}:${note.eventTimeMillis}`;

    return {
      storeEventId,
      eventType: eventTypeOf(note),
      ...refsOf(note),
      payload: note,
    };
  }

  async #verifyPush(req: Request): Promise<void> {
    if (!this.#audience) {
      throw TollgateError.invalidRequest(
        'GoogleAdapter cannot accept notifications without pubsubAudience. ' +
          'Set it to the push subscription\'s audience, which should be this ' +
          'endpoint\'s own URL.',
      );
    }
    const header = req.headers.get('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token || token === header.trim()) {
      throw new TollgateError(
        'bad_signature',
        'Pub/Sub push carried no bearer token. The subscription must be ' +
          'created with authentication enabled.',
      );
    }
    await verifyGoogleIdToken(token, {
      audience: this.#audience,
      email: this.#pushEmail,
      now: this.#now,
      fetch: this.#fetch,
    });
  }

  // --- HTTP ----------------------------------------------------------------

  async #get<T>(path: string): Promise<T | null> {
    const res = await this.#request('GET', path);
    // Play forgets consumed one-time purchases and expired subscriptions
    // eventually. Nothing to record and nothing to revoke; whatever is stored
    // stays and ages out on its own terms.
    if (res.status === 404) return null;
    await this.#assertOk(res, path);
    return await res.json() as T;
  }

  async #post(path: string): Promise<void> {
    const res = await this.#request('POST', path);
    await this.#assertOk(res, path);
  }

  async #request(method: string, path: string): Promise<Response> {
    const token = await this.#auth.accessToken(this.#now());
    return await this.#fetch(
      `${API}/applications/${encodeURIComponent(this.#packageName)}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      },
    );
  }

  async #assertOk(res: Response, path: string): Promise<void> {
    if (res.ok) return;
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    // 401 and 403 here are almost always Play Console permissions that have not
    // propagated rather than a broken key, and they can take a day or two. The
    // message says so, because the alternative is re-checking everything else.
    if (res.status === 401 || res.status === 403) {
      throw new TollgateError(
        'invalid_request',
        `Google Play refused the request (${res.status}). Check that the ` +
          `service account has "View financial data" and "Manage orders and ` +
          `subscriptions" on this app, and that the grants have propagated ` +
          `(commonly a day or two). ${detail}`,
      );
    }
    throw new TollgateError(
      res.status >= 500 || res.status === 429
        ? 'store_unavailable'
        : 'invalid_request',
      `Google Play returned ${res.status} for ${path}. ${detail}`,
    );
  }
}

// --- notification shapes ----------------------------------------------------

/** The event's name, for the audit trail. */
function eventTypeOf(note: DeveloperNotification): string {
  if (note.testNotification) return 'TEST';
  if (note.voidedPurchaseNotification) return 'VOIDED_PURCHASE';
  const sub = note.subscriptionNotification?.notificationType;
  if (sub != null) {
    return SUBSCRIPTION_NOTIFICATION[
      sub as keyof typeof SUBSCRIPTION_NOTIFICATION
    ] ?? `SUBSCRIPTION_${sub}`;
  }
  const one = note.oneTimeProductNotification?.notificationType;
  if (one != null) {
    return ONE_TIME_PRODUCT_NOTIFICATION[
      one as keyof typeof ONE_TIME_PRODUCT_NOTIFICATION
    ] ?? `ONE_TIME_PRODUCT_${one}`;
  }
  return 'UNKNOWN';
}

/** SUBSCRIPTION_REVOKED. Access stops at once, whatever the expiry says. */
const REVOKED = 12;

/**
 * Which purchases an event is about, split by whether the event itself is the
 * news that the purchase was taken back.
 *
 * The split matters because a revocation cannot be discovered by re-reading.
 * A voided one-time purchase reads back as `purchaseState: 1`, which is
 * indistinguishable from an ordinary cancellation, and a revoked subscription
 * may still read as active until Play catches up. The notification is the only
 * place the refund is stated, so it is trusted for that and only that.
 */
function refsOf(
  note: DeveloperNotification,
): { refs: PurchaseRef[]; revoked: PurchaseRef[] } {
  const refs: PurchaseRef[] = [];
  const revoked: PurchaseRef[] = [];

  const sub = note.subscriptionNotification;
  if (sub?.purchaseToken) {
    const ref: PurchaseRef = {
      store: 'google',
      originalTransactionId: sub.purchaseToken,
      storeProductId: sub.subscriptionId,
      kind: 'subscription',
    };
    (sub.notificationType === REVOKED ? revoked : refs).push(ref);
  }

  const one = note.oneTimeProductNotification;
  if (one?.purchaseToken) {
    refs.push({
      store: 'google',
      originalTransactionId: one.purchaseToken,
      storeProductId: one.sku,
      // `non_consumable` here only selects Play's one-time-product endpoint,
      // which is shared by both one-time kinds. Play does not say whether a
      // product is consumable, so the real answer comes from the catalogue and
      // overrides this when the purchase is recorded.
      kind: 'non_consumable',
    });
  }

  const voided = note.voidedPurchaseNotification;
  if (voided?.purchaseToken) {
    revoked.push({
      store: 'google',
      originalTransactionId: voided.purchaseToken,
      // A voided-purchase notification names no product, so a refund is
      // identified by its token alone. Revocation is a database lookup rather
      // than a store call, so the missing product id costs nothing here.
      kind: voided.productType === 1 ? 'subscription' : 'non_consumable',
    });
  }

  return { refs, revoked };
}
