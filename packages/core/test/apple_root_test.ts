// The pinned Apple root, checked by the same code that will trust it.
//
// The pin is a key, extracted once with openssl. If the extraction was wrong,
// or the constant was mistyped, every Apple payload would be rejected in
// production and nothing before this point would have said so.

import { assert, assertEquals } from '@std/assert';

import {
  APPLE_ROOT_CA_G3_CERT,
  APPLE_ROOT_CA_G3_SPKI,
} from '../src/adapters/apple/root.ts';
import { parseCertificate, verifySignedBy } from '../src/crypto/x509.ts';
import { base64ToBytes, bytesToBase64 } from '../src/crypto/encoding.ts';

Deno.test('the pinned key is the one in Apple root CA G3', () => {
  const root = parseCertificate(base64ToBytes(APPLE_ROOT_CA_G3_CERT));
  assertEquals(
    bytesToBase64(root.spki),
    APPLE_ROOT_CA_G3_SPKI,
    'the pinned SubjectPublicKeyInfo must be this certificate\'s',
  );
});

Deno.test('Apple root CA G3 parses and is self-consistent', async () => {
  const root = parseCertificate(base64ToBytes(APPLE_ROOT_CA_G3_CERT));

  // Issued 2014, expires 2039. If the clock is outside that, either this test
  // is being run in a strange place or the certificate has been replaced.
  assertEquals(root.notBefore.getUTCFullYear(), 2014);
  assertEquals(root.notAfter.getUTCFullYear(), 2039);
  assert(root.notAfter > new Date(), 'the pinned root has not expired');

  // ecdsa-with-SHA384, on a P-384 key. Signed by itself, which proves the
  // parser reads a real Apple certificate correctly rather than only the ones
  // openssl generates in the chain test.
  assertEquals(root.signatureAlgorithm, '1.2.840.10045.4.3.3');
  assert(
    await verifySignedBy(root, root.spki),
    'the root should verify against its own key',
  );
});
