/**
 * Certificate chain verification, over Web Crypto.
 *
 * Apple signs everything it sends about a purchase as a JWS whose header
 * carries the certificate chain that signed it. Trusting that payload means
 * checking the chain: each certificate signed by the next, the last one being
 * Apple's own root, and none of them expired.
 *
 * Skipping any of that turns the signature into decoration. A JWS carries its
 * own certificates, so anybody can sign a payload with a key of their own and
 * attach a matching chain; what makes it Apple's is that the chain ends at a
 * root nobody else has the private key for.
 */

import { DER, ecdsaDerToRaw, readElement, readOid, readSequence, readTime } from './der.ts';
import { base64ToBytes } from './encoding.ts';

/** The bits of a certificate this needs. */
export interface Certificate {
  /** The signed portion, which is what the issuer's signature covers. */
  tbs: Uint8Array;
  /** SubjectPublicKeyInfo, ready for `crypto.subtle.importKey('spki', …)`. */
  spki: Uint8Array;
  signature: Uint8Array;
  signatureAlgorithm: string;
  notBefore: Date;
  notAfter: Date;
}

// Signature algorithm OIDs, and the Web Crypto parameters they mean. The hash
// comes from here; the curve does NOT, and cannot. A P-384 key is perfectly
// entitled to sign with SHA-256, so reading the curve off the signature
// algorithm produces "invalid P-256 SPKI data" on a chain that is completely
// valid.
const ALGORITHMS: Record<string, { name: string; hash: string }> = {
  '1.2.840.10045.4.3.2': { name: 'ECDSA', hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { name: 'ECDSA', hash: 'SHA-384' },
  '1.2.840.10045.4.3.4': { name: 'ECDSA', hash: 'SHA-512' },
  '1.2.840.113549.1.1.11': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
};

/** Named curve OIDs, and the size of one half of an ECDSA signature on them. */
const CURVES: Record<string, { name: string; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
  '1.3.132.0.35': { name: 'P-521', size: 66 },
};

/**
 * The curve a public key is on, read from the key itself.
 *
 * SubjectPublicKeyInfo is `SEQUENCE { AlgorithmIdentifier, BIT STRING }`, and
 * for an EC key the AlgorithmIdentifier's parameter is the named curve. That is
 * the only place the curve is stated, which is why it has to be read here
 * rather than guessed from anything alongside it.
 */
function curveOf(spki: Uint8Array): { name: string; size: number } {
  const [algorithm] = readSequence(readElement(spki).content);
  const parts = readSequence(algorithm.content);
  if (parts.length < 2) throw new Error('X.509: EC key names no curve.');
  const curve = CURVES[readOid(parts[1].content)];
  if (!curve) throw new Error('X.509: unsupported elliptic curve.');
  return curve;
}

/**
 * A certificate's public key, ready to verify an ECDSA signature over bytes
 * that are not another certificate.
 *
 * The JWS path needs this: once the chain is trusted, the payload's own
 * signature is checked with the leaf's key. The curve is read from the key
 * rather than taken from the caller, for the same reason as everywhere else
 * here. No hash is named, because ECDSA in Web Crypto takes it at verify time
 * rather than binding it to the key as RSA does.
 */
export async function importEcdsaKey(spki: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'spki',
    // deno-lint-ignore no-explicit-any
    spki as any,
    { name: 'ECDSA', namedCurve: curveOf(spki).name },
    false,
    ['verify'],
  );
}

/** Read the fields needed to verify a certificate and be verified by one. */
export function parseCertificate(der: Uint8Array): Certificate {
  const certificate = readElement(der);
  const [tbs, algorithm, signature] = readSequence(certificate.content);

  const parts = readSequence(tbs.content);
  // An X.509 v3 certificate opens with an explicitly tagged version; v1 has no
  // such field and starts straight at the serial number.
  const versioned = parts[0].tag === 0xa0;
  const base = versioned ? 1 : 0;
  const validity = parts[base + 3];
  const spki = parts[base + 5];

  const [notBefore, notAfter] = readSequence(validity.content);
  const algorithmOid = readOid(readSequence(algorithm.content)[0].content);

  return {
    tbs: tbs.raw,
    spki: spki.raw,
    // A BIT STRING's first content byte counts unused trailing bits, and is
    // always zero here. It is not part of the signature.
    signature: signature.content.subarray(1),
    signatureAlgorithm: algorithmOid,
    notBefore: readTime(notBefore),
    notAfter: readTime(notAfter),
  };
}

/** Whether [issuer] signed [subject]. */
export async function verifySignedBy(
  subject: Certificate,
  issuerSpki: Uint8Array,
): Promise<boolean> {
  const algorithm = ALGORITHMS[subject.signatureAlgorithm];
  if (!algorithm) return false;

  const isEcdsa = algorithm.name === 'ECDSA';
  // The curve belongs to the issuer's key, so it is read off that key.
  const curve = isEcdsa ? curveOf(issuerSpki) : null;

  const key = await crypto.subtle.importKey(
    'spki',
    // deno-lint-ignore no-explicit-any
    issuerSpki as any,
    isEcdsa
      ? { name: 'ECDSA', namedCurve: curve!.name }
      : { name: 'RSASSA-PKCS1-v1_5', hash: algorithm.hash },
    false,
    ['verify'],
  );

  const signature = isEcdsa
    ? ecdsaDerToRaw(subject.signature, curve!.size)
    : subject.signature;

  return await crypto.subtle.verify(
    isEcdsa ? { name: 'ECDSA', hash: algorithm.hash } : { name: 'RSASSA-PKCS1-v1_5' },
    key,
    // deno-lint-ignore no-explicit-any
    signature as any,
    // deno-lint-ignore no-explicit-any
    subject.tbs as any,
  );
}

export interface ChainOptions {
  /**
   * The root that has to be at the end of the chain, as base64 DER of its
   * SubjectPublicKeyInfo.
   *
   * Pinned to a key rather than a whole certificate: a root can be reissued
   * with new validity dates and the same key, and pinning the certificate would
   * break the day that happened for no security benefit.
   */
  rootSpkiBase64: string;
  now?: Date;
}

/**
 * Verify an `x5c` chain, leaf first, and return the leaf's public key.
 *
 * The order Apple sends is leaf, intermediate, root. Every link is checked
 * rather than assumed, the root's key is compared against the pinned one, and
 * every certificate's validity window is checked against the clock.
 */
export async function verifyChain(
  x5c: string[],
  opts: ChainOptions,
): Promise<Certificate> {
  if (x5c.length < 2) {
    throw new Error('Certificate chain is too short to verify.');
  }
  const now = opts.now ?? new Date();
  const chain = x5c.map((b64) => parseCertificate(base64ToBytes(b64)));

  for (const certificate of chain) {
    if (now < certificate.notBefore || now > certificate.notAfter) {
      throw new Error('A certificate in the chain is outside its validity.');
    }
  }

  const root = chain[chain.length - 1];
  const pinned = base64ToBytes(opts.rootSpkiBase64);
  if (!sameBytes(root.spki, pinned)) {
    // The chain is internally consistent and signed by somebody else. This is
    // the check that makes the rest of it mean anything.
    throw new Error('The chain does not end at the expected root.');
  }

  for (let i = 0; i < chain.length - 1; i++) {
    if (!await verifySignedBy(chain[i], chain[i + 1].spki)) {
      throw new Error(`Certificate ${i} is not signed by certificate ${i + 1}.`);
    }
  }
  // The root signs itself, and checking that proves only that whoever made it
  // held its key. It is trusted because it was pinned above, not because of
  // this, so it is deliberately not treated as a link in the chain.

  return chain[0];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Whether a DER blob looks like a certificate at all, for error messages. */
export function looksLikeCertificate(der: Uint8Array): boolean {
  try {
    return readElement(der).tag === DER.SEQUENCE;
  } catch {
    return false;
  }
}
