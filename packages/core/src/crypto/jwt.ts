/**
 * JWT signing and verification over Web Crypto.
 *
 * Written here rather than pulled in because the two libraries that would do
 * this are both unusable in the target runtimes: `googleapis` is Node-only, and
 * Apple's `@apple/app-store-server-library` has documented ES256 curve failures
 * under Deno. What is needed is small enough that owning it beats depending on
 * something that works in one of the two places this has to run.
 */

import {
  base64UrlDecode,
  base64UrlEncode,
  decodeJsonSegment,
  pemToDer,
  utf8,
} from './encoding.ts';
import { TollgateError } from '../errors.ts';

export interface JwtHeader {
  alg: string;
  typ?: string;
  kid?: string;
  [k: string]: unknown;
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  [k: string]: unknown;
}

/**
 * Sign a JWT with an RSA private key in PEM (PKCS#8) form, which is what a
 * Google service account key file contains.
 */
export async function signRs256(
  header: JwtHeader,
  claims: JwtClaims,
  privateKeyPem: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    // deno-lint-ignore no-explicit-any
    pemToDer(privateKeyPem) as any,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const body = `${base64UrlEncode(JSON.stringify({ ...header, alg: 'RS256' }))}.${
    base64UrlEncode(JSON.stringify(claims))
  }`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    // deno-lint-ignore no-explicit-any
    utf8(body) as any,
  );
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Sign a JWT with an EC P-256 private key in PEM (PKCS#8) form, which is what
 * an App Store Connect `.p8` key file contains.
 *
 * Web Crypto produces ECDSA signatures as raw `r || s`, which is exactly the
 * form JWS wants. X.509 is the odd one out in wrapping them in a DER sequence,
 * and that conversion is confined to the certificate path in `der.ts`.
 */
export async function signEs256(
  header: JwtHeader,
  claims: JwtClaims,
  privateKeyPem: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    // deno-lint-ignore no-explicit-any
    pemToDer(privateKeyPem) as any,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const body = `${base64UrlEncode(JSON.stringify({ ...header, alg: 'ES256' }))}.${
    base64UrlEncode(JSON.stringify(claims))
  }`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    // deno-lint-ignore no-explicit-any
    utf8(body) as any,
  );
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Header and claims without checking anything. For routing, never for trust. */
export function decodeJwt(
  token: string,
): { header: JwtHeader; claims: JwtClaims; signed: string; signature: string } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new TollgateError('bad_signature', 'Not a JWT.');
  }
  return {
    header: decodeJsonSegment<JwtHeader>(parts[0]),
    claims: decodeJsonSegment<JwtClaims>(parts[1]),
    signed: `${parts[0]}.${parts[1]}`,
    signature: parts[2],
  };
}

// --- Google's public keys ---------------------------------------------------

/** A JSON Web Key, as Google publishes them. */
interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

interface JwksCache {
  keys: Map<string, CryptoKey>;
  expires: number;
}

let jwksCache: JwksCache | null = null;

/**
 * Google's signing keys, cached until the response says they go stale.
 *
 * Cached because this runs on every notification and the keys rotate on the
 * order of days, but honoured rather than pinned: a key fetched once and kept
 * forever means every notification fails the day Google rotates.
 */
async function googleKeys(
  fetchImpl: typeof fetch,
  force = false,
): Promise<Map<string, CryptoKey>> {
  if (!force && jwksCache && Date.now() < jwksCache.expires) {
    return jwksCache.keys;
  }

  const res = await fetchImpl(GOOGLE_JWKS_URL);
  if (!res.ok) {
    throw new TollgateError(
      'store_unavailable',
      `Could not fetch Google's signing keys (${res.status}).`,
    );
  }
  const body = await res.json() as { keys: Jwk[] };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
  }

  jwksCache = { keys, expires: Date.now() + cacheSeconds(res) * 1000 };
  return keys;
}

/** How long the response says its keys are good for. One hour if it does not. */
function cacheSeconds(res: Response): number {
  const control = res.headers.get('cache-control') ?? '';
  const match = control.match(/max-age=(\d+)/);
  return match ? Math.max(60, Number(match[1])) : 3600;
}

/** Drops the cached keys. Only used by tests. */
export function resetGoogleKeyCache(): void {
  jwksCache = null;
}

export interface GoogleIdTokenChecks {
  /** The `aud` the token must carry, normally the receiving endpoint's URL. */
  audience: string;
  /**
   * The service account the token must be issued for. This is what stops a
   * token minted by any other Google customer, for any other service, from
   * being accepted here: `aud` alone is guessable, an email is assigned.
   */
  email?: string;
  /** Seconds of leeway on exp and iat, for clock skew between hosts. */
  leewaySeconds?: number;
  now?: () => number;
  fetch?: typeof fetch;
}

const GOOGLE_ISSUERS = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

/**
 * Verify a Google-signed ID token, of the kind Pub/Sub puts in the
 * Authorization header of an authenticated push request.
 *
 * The endpoint receiving these is public, so this function is the whole of the
 * access control on it. Every check below is load-bearing: without the
 * signature anyone can post, without `aud` a token minted for some other
 * service of the same project is accepted, and without `email` a token from an
 * entirely unrelated Google project is accepted.
 */
export async function verifyGoogleIdToken(
  token: string,
  checks: GoogleIdTokenChecks,
): Promise<JwtClaims> {
  const fetchImpl = checks.fetch ?? fetch;
  const now = Math.floor((checks.now?.() ?? Date.now()) / 1000);
  const leeway = checks.leewaySeconds ?? 60;

  const { header, claims, signed, signature } = decodeJwt(token);
  if (header.alg !== 'RS256') {
    throw new TollgateError(
      'bad_signature',
      `Unexpected token algorithm "${header.alg}".`,
    );
  }
  if (!header.kid) {
    throw new TollgateError('bad_signature', 'Token names no signing key.');
  }

  let keys = await googleKeys(fetchImpl);
  let key = keys.get(header.kid);
  if (!key) {
    // An unknown kid is what a rotation looks like from here, so refetch once
    // before deciding the token is forged.
    keys = await googleKeys(fetchImpl, true);
    key = keys.get(header.kid);
  }
  if (!key) {
    throw new TollgateError(
      'bad_signature',
      `No Google key matches "${header.kid}".`,
    );
  }

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    // deno-lint-ignore no-explicit-any
    base64UrlDecode(signature) as any,
    // deno-lint-ignore no-explicit-any
    utf8(signed) as any,
  );
  if (!ok) {
    throw new TollgateError('bad_signature', 'Token signature does not verify.');
  }

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) {
    throw new TollgateError(
      'bad_signature',
      `Token was not issued by Google (iss "${claims.iss}").`,
    );
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(checks.audience)) {
    throw new TollgateError(
      'bad_signature',
      'Token was minted for a different audience.',
    );
  }

  if (checks.email) {
    const email = claims.email as string | undefined;
    if (email !== checks.email) {
      throw new TollgateError(
        'bad_signature',
        'Token was issued for a different service account.',
      );
    }
    if (claims.email_verified === false) {
      throw new TollgateError('bad_signature', 'Token email is not verified.');
    }
  }

  if (typeof claims.exp !== 'number' || claims.exp + leeway < now) {
    throw new TollgateError('bad_signature', 'Token has expired.');
  }
  if (typeof claims.iat === 'number' && claims.iat - leeway > now) {
    throw new TollgateError('bad_signature', 'Token is not valid yet.');
  }

  return claims;
}
