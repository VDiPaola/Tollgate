/**
 * Byte and text conversions used by the signing paths.
 *
 * Web Crypto only, no Node built-ins, so the same code runs in Deno and in a
 * Node runtime. `atob`/`btoa` are web standards available in both.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Standard base64 to bytes. Tolerates base64url input and missing padding. */
export function base64ToBytes(b64: string): Uint8Array {
  const normalised = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised.padEnd(
    normalised.length + ((4 - (normalised.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked because String.fromCharCode(...bytes) blows the argument limit on
  // anything the size of a certificate.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlDecode(b64url: string): Uint8Array {
  return base64ToBytes(b64url);
}

/** Decode a base64url segment and parse it as JSON. */
export function decodeJsonSegment<T>(segment: string): T {
  return JSON.parse(fromUtf8(base64UrlDecode(segment))) as T;
}

/**
 * A PEM block's payload as DER bytes.
 *
 * Accepts the `\n`-containing form a JSON key file holds and the `\\n`-escaped
 * form that survives a round trip through an environment variable, because both
 * turn up in practice and the failure mode of the second is an unhelpful
 * "invalid key" from Web Crypto.
 */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('Empty PEM body.');
  return base64ToBytes(body);
}
