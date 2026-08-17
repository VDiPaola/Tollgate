/**
 * JWS payloads that carry their own signing certificate chain.
 *
 * This is the shape Apple uses for everything it says about a purchase: a
 * three-part token whose header holds an `x5c` chain, leaf first, ending at
 * Apple's own root.
 *
 * Two checks, and both are load-bearing. The chain has to end at a pinned root,
 * or the signature proves only that somebody signed something with a key they
 * generated themselves. The payload's signature then has to verify against the
 * leaf of that chain, or a trusted chain has been stapled to an untrusted body.
 * Doing one without the other is the same as doing neither.
 */

import { TollgateError } from '../errors.ts';
import { base64UrlDecode, utf8 } from './encoding.ts';
import { decodeJwt, type JwtHeader } from './jwt.ts';
import { importEcdsaKey, verifyChain } from './x509.ts';

/** JWS algorithm names, and the digest each one signs over. */
const HASHES: Record<string, string> = {
  ES256: 'SHA-256',
  ES384: 'SHA-384',
  ES512: 'SHA-512',
};

export interface X5cJwsOptions {
  /** Base64 DER of the trusted root's SubjectPublicKeyInfo. */
  rootSpkiBase64: string;
  now?: () => number;
}

/**
 * Verify a JWS against the chain in its own header, and return its payload.
 *
 * Throws [TollgateError] with code `bad_signature` on anything that does not
 * verify, because every caller of this is an endpoint or a client-supplied
 * token, and a partial answer is worse than none.
 */
export async function verifyX5cJws<T>(
  token: string,
  opts: X5cJwsOptions,
): Promise<T> {
  const { header, claims, signed, signature } = decodeJwt(token);

  const hash = HASHES[header.alg];
  if (!hash) {
    // `alg: "none"` and an unexpected symmetric algorithm both land here. The
    // header is attacker-controlled, so the algorithm is chosen from this list
    // rather than trusted from the token.
    throw new TollgateError(
      'bad_signature',
      `Unexpected signing algorithm "${header.alg}".`,
    );
  }

  const chain = chainOf(header);
  let leafSpki: Uint8Array;
  try {
    const leaf = await verifyChain(chain, {
      rootSpkiBase64: opts.rootSpkiBase64,
      now: new Date(opts.now?.() ?? Date.now()),
    });
    leafSpki = leaf.spki;
  } catch (e) {
    throw new TollgateError(
      'bad_signature',
      `The signing certificate chain is not trusted: ${
        e instanceof Error ? e.message : e
      }`,
      e,
    );
  }

  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash },
    await importEcdsaKey(leafSpki),
    // A JWS signature is already raw `r || s`, which is what Web Crypto wants.
    // deno-lint-ignore no-explicit-any
    base64UrlDecode(signature) as any,
    // deno-lint-ignore no-explicit-any
    utf8(signed) as any,
  );
  if (!ok) {
    throw new TollgateError(
      'bad_signature',
      'The payload was signed by a trusted chain, but its signature does not ' +
        'cover this body.',
    );
  }

  return claims as T;
}

function chainOf(header: JwtHeader): string[] {
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0) {
    throw new TollgateError(
      'bad_signature',
      'The payload carries no certificate chain to verify it against.',
    );
  }
  if (!x5c.every((c) => typeof c === 'string')) {
    throw new TollgateError('bad_signature', 'Malformed certificate chain.');
  }
  return x5c as string[];
}
