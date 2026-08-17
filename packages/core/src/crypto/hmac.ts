/**
 * HMAC-SHA256 and a constant-time comparison, for webhook signatures.
 *
 * Written here rather than pulled from a store's own SDK because those are
 * Node-only, and this has to run in Deno too. It is a dozen lines of Web
 * Crypto either way.
 */

import { utf8 } from './encoding.ts';

export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    // deno-lint-ignore no-explicit-any
    utf8(secret) as any,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    // deno-lint-ignore no-explicit-any
    utf8(message) as any,
  );
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compare two strings without leaking where they diverge.
 *
 * A plain `===` on a signature returns faster the earlier the mismatch, which
 * over enough attempts tells an attacker the correct prefix one character at a
 * time. The cost of doing it properly is nothing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
