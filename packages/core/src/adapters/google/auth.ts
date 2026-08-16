/**
 * Getting an access token for the Play Developer API out of a service account
 * key, without `googleapis`.
 *
 * The whole flow is: build a JWT asserting who we are and what we want, sign it
 * with the key from the JSON file, and swap it at Google's token endpoint for a
 * bearer token that lasts an hour.
 */

import { signRs256 } from '../../crypto/jwt.ts';
import { TollgateError } from '../../errors.ts';
import { base64ToBytes, fromUtf8 } from '../../crypto/encoding.ts';

/** The parts of a Google service account key file that matter here. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  token_uri?: string;
}

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/**
 * Read a service account from the base64-encoded JSON key file.
 *
 * Base64 rather than raw JSON in configuration because the private key contains
 * newlines, and a newline in an environment variable is either a parse error or
 * a silently truncated key depending on what reads it. Raw JSON is accepted too,
 * since somebody will inevitably paste it.
 */
export function parseServiceAccount(encoded: string): ServiceAccount {
  // The decode is inside the guard, not before it. Anything that is not valid
  // base64 makes `atob` throw a DOMException, which would otherwise escape as
  // "InvalidCharacterError" and tell nobody which setting is wrong.
  let parsed: Partial<ServiceAccount>;
  try {
    const trimmed = encoded.trim();
    const text = trimmed.startsWith('{')
      ? trimmed
      : fromUtf8(base64ToBytes(trimmed));
    parsed = JSON.parse(text);
  } catch (e) {
    throw new TollgateError(
      'invalid_request',
      'The Google service account key could not be read. It should be the ' +
        'whole JSON key file, base64-encoded.',
      e,
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new TollgateError(
      'invalid_request',
      'The Google service account key is missing client_email or private_key.',
    );
  }
  return parsed as ServiceAccount;
}

interface CachedToken {
  token: string;
  expires: number;
}

/**
 * Mints and reuses access tokens for one service account.
 *
 * Reuse matters: a token lasts an hour and every notification would otherwise
 * pay for an RSA signature and a network round trip before doing any work. The
 * refresh happens a minute early so a token cannot expire in flight.
 */
export class GoogleAuth {
  readonly #account: ServiceAccount;
  readonly #fetch: typeof fetch;
  #cached: CachedToken | null = null;
  #inflight: Promise<string> | null = null;

  constructor(account: ServiceAccount, fetchImpl: typeof fetch = fetch) {
    this.#account = account;
    this.#fetch = fetchImpl;
  }

  get clientEmail(): string {
    return this.#account.client_email;
  }

  async accessToken(now: number = Date.now()): Promise<string> {
    if (this.#cached && now < this.#cached.expires) return this.#cached.token;
    // Collapse concurrent misses onto one exchange. A burst of notifications
    // arriving on a cold isolate would otherwise mint a token each.
    this.#inflight ??= this.#exchange(now).finally(() => {
      this.#inflight = null;
    });
    return await this.#inflight;
  }

  async #exchange(now: number): Promise<string> {
    const issued = Math.floor(now / 1000);
    const assertion = await signRs256(
      { alg: 'RS256', typ: 'JWT', kid: this.#account.private_key_id },
      {
        iss: this.#account.client_email,
        scope: SCOPE,
        aud: this.#account.token_uri ?? TOKEN_URI,
        iat: issued,
        exp: issued + 3600,
      },
      this.#account.private_key,
    );

    const res = await this.#fetch(this.#account.token_uri ?? TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new TollgateError(
        // A rejected assertion is a configuration problem, not a blip, and
        // saying so saves somebody retrying a key that will never work. The
        // usual cause is Play Console grants that have not propagated yet.
        res.status === 400 || res.status === 401
          ? 'invalid_request'
          : 'store_unavailable',
        `Google refused the service account assertion (${res.status}). ` +
          `Check that the key is current and that its Play Console ` +
          `permissions have propagated. ${detail.slice(0, 200)}`,
      );
    }

    const body = await res.json() as { access_token: string; expires_in: number };
    this.#cached = {
      token: body.access_token,
      expires: now + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000,
    };
    return body.access_token;
  }
}
