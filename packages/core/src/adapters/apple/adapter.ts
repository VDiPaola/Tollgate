/**
 * Apple's App Store.
 *
 * StoreKit 2 on the device, the App Store Server API on the server, and App
 * Store Server Notifications V2 for everything that happens afterwards. See
 * `docs/apple-setup.md` for what has to exist in App Store Connect first.
 *
 * The thing to hold on to: everything Apple says about a purchase arrives as a
 * JWS carrying its own certificate chain, from the device as well as from the
 * server. A device-supplied JWS verifies perfectly well and still proves
 * nothing about who is asking, so it is used only to find out which transaction
 * is meant. The state always comes from Apple's own API.
 */

import type {
  ParsedNotification,
  StoreAdapter,
  VerifyRequest,
} from '../../adapter.ts';
import { TollgateError } from '../../errors.ts';
import type {
  Environment,
  NormalizedPurchase,
  PurchaseRef,
} from '../../types.ts';
import { verifyX5cJws } from '../../crypto/jws.ts';
import { signEs256 } from '../../crypto/jwt.ts';
import { base64ToBytes, fromUtf8 } from '../../crypto/encoding.ts';
import { APPLE_ROOT_CA_G3_SPKI } from './root.ts';
import { kindOf, normalizeTransaction } from './normalize.ts';
import {
  type AppleErrorResponse,
  type AppleNotification,
  type AppleRenewalInfo,
  type AppleStatusResponse,
  type AppleTransactionInfo,
  type AppleTransactionResponse,
  REVOKING_NOTIFICATIONS,
} from './types.ts';

const HOSTS: Record<Environment, string> = {
  production: 'https://api.storekit.itunes.apple.com/inApps/v1',
  sandbox: 'https://api.storekit-sandbox.itunes.apple.com/inApps/v1',
};

/** Apple allows sixty minutes. Less, so a token cannot expire in flight. */
const TOKEN_LIFETIME_SECONDS = 20 * 60;

export interface AppleAdapterOptions {
  /** The app's bundle id, which every payload is checked against. */
  bundleId: string;
  /** The issuer id from App Store Connect's Keys page. */
  issuerId: string;
  /** The key id of the In-App Purchase key. */
  keyId: string;
  /**
   * The `.p8` private key: PEM text, or that text base64-encoded.
   *
   * Base64 is accepted because a PEM contains newlines, and a newline in an
   * environment variable is either a parse error or a silently truncated key
   * depending on what reads it.
   */
  privateKey: string;
  /**
   * Which App Store Server API to ask first.
   *
   * Only an optimisation. Sandbox and production are separate hosts holding
   * separate transactions, so a lookup that misses is retried against the other
   * one regardless; getting this right just saves a round trip. Whether a
   * sandbox purchase then grants anything is decided by the deployment's own
   * environment, not by this.
   */
  environment?: Environment;
  /**
   * Overrides the pinned Apple root that signatures are checked against.
   *
   * For tests, which need to sign payloads with a chain they hold the keys to.
   * Setting this anywhere else disables the only check that makes an Apple
   * signature mean anything: without the pin, a forged payload with a
   * self-generated chain verifies.
   */
  trustedRootSpki?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class AppleAdapter implements StoreAdapter {
  readonly store = 'apple' as const;

  readonly #bundleId: string;
  readonly #issuerId: string;
  readonly #keyId: string;
  readonly #privateKey: string;
  readonly #environment: Environment;
  readonly #root: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  #token: { value: string; expires: number } | null = null;
  #inflight: Promise<string> | null = null;

  constructor(opts: AppleAdapterOptions) {
    for (const field of ['bundleId', 'issuerId', 'keyId', 'privateKey'] as const) {
      if (!opts[field]) {
        throw TollgateError.invalidRequest(`AppleAdapter needs a ${field}.`);
      }
    }
    this.#bundleId = opts.bundleId;
    this.#issuerId = opts.issuerId;
    this.#keyId = opts.keyId;
    this.#privateKey = readKey(opts.privateKey);
    this.#environment = opts.environment ?? 'production';
    this.#root = opts.trustedRootSpki ?? APPLE_ROOT_CA_G3_SPKI;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? (() => Date.now());
  }

  // --- purchases -----------------------------------------------------------

  async verify(req: VerifyRequest): Promise<NormalizedPurchase> {
    // StoreKit 2 hands the app a signed transaction, and older code paths hand
    // it a bare transaction id. Both are accepted, and neither is trusted for
    // anything but naming the transaction: the JWS is genuinely Apple's, but a
    // client presenting one has only proved it can read a purchase, not that it
    // made one.
    const claimed = isJws(req.token)
      ? await this.#decode<AppleTransactionInfo>(req.token)
      : null;
    const transactionId = claimed?.transactionId ?? req.token;

    const purchase = await this.#read(
      {
        store: 'apple',
        originalTransactionId: transactionId,
        storeProductId: req.storeProductId,
        // The catalogue's answer if the orchestrator had one, and otherwise the
        // product type off the client's own signed payload, which Apple states
        // outright. Nothing is guessed.
        kind: req.kind ?? kindOf(claimed?.type),
      },
      // A payload that says it is a sandbox transaction means the sandbox host
      // holds it, so ask that one first rather than paying for a miss.
      claimed?.environment === 'Sandbox' ? 'sandbox' : undefined,
    );

    if (!purchase) {
      throw new TollgateError(
        'invalid_purchase',
        'The App Store has no record of that purchase.',
      );
    }

    // A transaction id travels through a client, so one presented by somebody
    // who did not make the purchase must be refused rather than granted to
    // whoever asks first.
    //
    // Only a mismatch is refused, not an absence. A transaction that carries no
    // token at all is one this app did not start: a Family Sharing copy, or a
    // purchase from a build that predates Tollgate. Those are recorded and
    // attributed by the ordinary alias route rather than rejected.
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
   * Where to cancel.
   *
   * One page for every subscription the customer has, because Apple has no
   * per-subscription deep link. An in-app subscription cannot be cancelled from
   * inside the app by Apple's rules, so this is the honest answer rather than a
   * button that cannot work.
   */
  manageUrl(): string | null {
    return 'https://apps.apple.com/account/subscriptions';
  }

  // There is deliberately no `finish`. Apple's equivalent of an
  // acknowledgement is `Transaction.finish()`, which exists only on the device:
  // the App Store Server API has no endpoint for it. The Flutter client calls
  // it, and only after the server has recorded the purchase, which is the same
  // ordering rule the Google path follows. An unfinished transaction is
  // re-delivered on every launch rather than auto-refunded after three days as
  // Play does, so the failure mode here is repetition rather than lost money.

  /**
   * Fetch a purchase from whichever environment holds it.
   *
   * Apple's API answers both questions from one id, which Google's does not:
   * `/transactions/{id}` takes any transaction id and states the product type,
   * so an unknown kind costs one extra request rather than a guess.
   */
  async #read(
    ref: PurchaseRef,
    hint?: Environment,
  ): Promise<NormalizedPurchase | null> {
    const preferred = hint ?? this.#environment;

    if (ref.kind === 'subscription') {
      return await this.#subscription(ref.originalTransactionId, preferred);
    }

    const found = await this.#get<AppleTransactionResponse>(
      `/transactions/${encodeURIComponent(ref.originalTransactionId)}`,
      preferred,
    );
    if (!found) return null;

    const transaction = await this.#transaction(found.body.signedTransactionInfo);
    if (!transaction) return null;

    // A subscription read through the transaction endpoint has no status: that
    // is the difference between "this payment happened" and "this subscription
    // is current", and only the second decides whether to serve somebody.
    if (kindOf(transaction.type) === 'subscription') {
      const subscription = await this.#subscription(
        transaction.originalTransactionId ?? ref.originalTransactionId,
        found.environment,
      );
      if (subscription) return subscription;
    }

    return normalizeTransaction(transaction, { environment: found.environment });
  }

  /** The current state of a subscription, from the status endpoint. */
  async #subscription(
    transactionId: string,
    preferred: Environment,
  ): Promise<NormalizedPurchase | null> {
    const found = await this.#get<AppleStatusResponse>(
      `/subscriptions/${encodeURIComponent(transactionId)}`,
      preferred,
    );
    if (!found) return null;

    const entries = (found.body.data ?? []).flatMap((group) =>
      group.lastTransactions ?? []
    );
    // Preferred by exact match because a customer can hold several
    // subscriptions in one group, and the response carries all of them. The
    // fallback covers being asked with a renewal's transaction id rather than
    // the original one, where the ids legitimately differ.
    const entry = entries.find((e) => e.originalTransactionId === transactionId) ??
      entries[0];
    if (!entry) return null;

    const transaction = await this.#transaction(entry.signedTransactionInfo);
    if (!transaction) return null;

    return normalizeTransaction(transaction, {
      environment: found.environment,
      status: entry.status,
      renewal: entry.signedRenewalInfo
        ? await this.#decode<AppleRenewalInfo>(entry.signedRenewalInfo)
        : undefined,
    });
  }

  // --- notifications -------------------------------------------------------

  /**
   * Verify and translate an App Store Server Notification.
   *
   * The endpoint this arrives at is public, so the signature on the payload is
   * the entire access control. Everything below the verification assumes the
   * body is genuinely Apple's.
   */
  async parseNotification(req: Request): Promise<ParsedNotification> {
    let envelope: { signedPayload?: string };
    try {
      envelope = await req.json() as { signedPayload?: string };
    } catch (e) {
      throw new TollgateError('bad_signature', 'Unreadable notification body.', e);
    }
    if (!envelope.signedPayload) {
      throw new TollgateError(
        'bad_signature',
        'The notification carried no signedPayload.',
      );
    }

    const note = await this.#decode<AppleNotification>(envelope.signedPayload);
    const bundleId = note.data?.bundleId ?? note.summary?.bundleId;
    if (bundleId && bundleId !== this.#bundleId) {
      // One App Store Connect account serves many apps, and a notification URL
      // configured on the wrong one would otherwise show up as purchases
      // attributed to the wrong product catalogue.
      throw new TollgateError(
        'invalid_request',
        `Notification is for "${bundleId}", not "${this.#bundleId}".`,
      );
    }

    const eventType = note.subtype
      ? `${note.notificationType}.${note.subtype}`
      : note.notificationType ?? 'UNKNOWN';

    const transaction = await this.#transaction(note.data?.signedTransactionInfo);
    const refs: PurchaseRef[] = [];
    const revoked: PurchaseRef[] = [];
    if (transaction) {
      const ref: PurchaseRef = {
        store: 'apple',
        originalTransactionId: transaction.originalTransactionId ??
          transaction.transactionId ?? '',
        storeTransactionId: transaction.transactionId,
        storeProductId: transaction.productId,
        kind: kindOf(transaction.type),
      };
      // A refund is stated by the notification. Apple does also report it on
      // the transaction afterwards, unlike Play, so this is belt and braces
      // rather than the only chance to notice; the belt costs one comparison.
      const isRevocation =
        REVOKING_NOTIFICATIONS.has(note.notificationType ?? '') ||
        transaction.revocationDate != null;
      (isRevocation ? revoked : refs).push(ref);
    }

    return {
      storeEventId: note.notificationUUID ??
        // Apple always sets one. A replay harness might not, and an event with
        // no id would be processed again on every delivery.
        `${eventType}:${note.signedDate ?? this.#now()}`,
      eventType,
      refs,
      revoked,
      payload: note,
    };
  }

  // --- signed payloads -----------------------------------------------------

  /** Verify a signed transaction, and check it is about this app. */
  async #transaction(
    jws: string | undefined,
  ): Promise<AppleTransactionInfo | null> {
    if (!jws) return null;
    const transaction = await this.#decode<AppleTransactionInfo>(jws);
    if (transaction.bundleId && transaction.bundleId !== this.#bundleId) {
      throw new TollgateError(
        'not_yours',
        `That purchase was made in "${transaction.bundleId}", not this app.`,
      );
    }
    return transaction;
  }

  #decode<T>(jws: string): Promise<T> {
    return verifyX5cJws<T>(jws, {
      rootSpkiBase64: this.#root,
      now: this.#now,
    });
  }

  // --- HTTP ----------------------------------------------------------------

  /**
   * Ask one environment, then the other.
   *
   * Sandbox and production are separate hosts holding separate transactions, so
   * a purchase absent from one may be perfectly real in the other. Apple's own
   * guidance is to check both, and the cost of not doing so is telling somebody
   * the App Store has no record of a purchase they were just charged for.
   *
   * A sandbox purchase found by a production deployment is still refused, but
   * further up, where the refusal can say what it actually is.
   */
  async #get<T>(
    path: string,
    preferred: Environment,
  ): Promise<{ body: T; environment: Environment } | null> {
    const other: Environment = preferred === 'production'
      ? 'sandbox'
      : 'production';
    for (const environment of [preferred, other]) {
      const res = await this.#request(path, environment);
      if (res.status === 404) continue;
      await this.#assertOk(res, path);
      return { body: await res.json() as T, environment };
    }
    return null;
  }

  async #request(path: string, environment: Environment): Promise<Response> {
    return await this.#fetch(`${HOSTS[environment]}${path}`, {
      headers: {
        authorization: `Bearer ${await this.#authToken()}`,
        'content-type': 'application/json',
      },
    });
  }

  async #assertOk(res: Response, path: string): Promise<void> {
    if (res.ok) return;
    const body = await res.text().catch(() => '');
    const error = parseError(body);
    const detail = error?.errorMessage
      ? `${error.errorMessage} (${error.errorCode})`
      : body.slice(0, 300);

    if (res.status === 401) {
      // Apple answers 401 to every kind of bad token without saying which, and
      // the causes are all configuration: the wrong key for the issuer, a
      // revoked key, a key that is not an In-App Purchase key, or a bundle id
      // that does not match the app the key belongs to.
      throw new TollgateError(
        'invalid_request',
        'The App Store refused the API key. Check that the key id, issuer id ' +
          'and bundle id all belong together, and that the key is an In-App ' +
          `Purchase key that has not been revoked. ${detail}`,
      );
    }
    throw new TollgateError(
      res.status >= 500 || res.status === 429
        ? 'store_unavailable'
        : 'invalid_request',
      `The App Store returned ${res.status} for ${path}. ${detail}`,
    );
  }

  /**
   * A bearer token for the App Store Server API.
   *
   * Cached, because a token is good for up to an hour and every notification
   * would otherwise pay for a signature before doing any work. Concurrent
   * misses collapse onto one signing, which matters on a cold isolate handling
   * a burst of notifications.
   */
  async #authToken(): Promise<string> {
    const now = this.#now();
    if (this.#token && now < this.#token.expires) return this.#token.value;
    this.#inflight ??= this.#mint(now).finally(() => {
      this.#inflight = null;
    });
    return await this.#inflight;
  }

  async #mint(now: number): Promise<string> {
    const issued = Math.floor(now / 1000);
    const token = await signEs256(
      { alg: 'ES256', kid: this.#keyId, typ: 'JWT' },
      {
        iss: this.#issuerId,
        iat: issued,
        exp: issued + TOKEN_LIFETIME_SECONDS,
        aud: 'appstoreconnect-v1',
        // Apple rejects a token whose bundle id is not the one the key was
        // issued for, which is the check that stops one developer's key
        // reading another's transactions.
        bid: this.#bundleId,
      },
      this.#privateKey,
    ).catch((e) => {
      throw new TollgateError(
        'invalid_request',
        'The App Store private key could not be used to sign. It should be ' +
          'the contents of the .p8 file, optionally base64-encoded.',
        e,
      );
    });

    this.#token = {
      value: token,
      // A minute early, so a token cannot expire between being chosen and
      // being used.
      expires: now + (TOKEN_LIFETIME_SECONDS - 60) * 1000,
    };
    return token;
  }
}

/** Whether a token looks like a JWS rather than a bare transaction id. */
function isJws(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * The `.p8` key as PEM.
 *
 * Accepts the file's own text and a base64 encoding of it, since both turn up
 * in configuration and only one of them survives every environment variable
 * mechanism intact.
 */
function readKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.includes('BEGIN')) return trimmed;
  try {
    const decoded = fromUtf8(base64ToBytes(trimmed));
    if (decoded.includes('BEGIN')) return decoded;
  } catch {
    // Not base64 either. Fall through and let the signing attempt produce the
    // error, which names the setting.
  }
  return trimmed;
}

/** Apple's error body, when there is one. */
function parseError(body: string): AppleErrorResponse | null {
  try {
    const parsed = JSON.parse(body) as AppleErrorResponse;
    return typeof parsed?.errorCode === 'number' ? parsed : null;
  } catch {
    return null;
  }
}
