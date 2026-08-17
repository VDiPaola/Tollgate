// Certificate chain verification, against a chain generated here.
//
// Real certificates, made with a throwaway root so the test owns every key and
// can therefore produce the failures that matter: a chain ending at the wrong
// root, a broken link, an expired certificate. Those are the cases where a
// mistake turns a signature check into decoration, and none of them can be
// exercised with a captured chain nobody holds the keys for.

import { assert, assertEquals, assertRejects } from '@std/assert';

import { parseCertificate, verifyChain, verifySignedBy } from '../src/crypto/x509.ts';
import { base64ToBytes } from '../src/crypto/encoding.ts';
import { makeChain, opensslAvailable } from './support/chain.ts';

Deno.test({
  name: 'a real chain verifies, and every way of breaking it does not',
  ignore: !opensslAvailable,
  fn: async () => {
    const { x5c, rootSpki } = await makeChain();

    const leaf = await verifyChain(x5c, { rootSpkiBase64: rootSpki });
    assert(leaf.spki.length > 0, 'the leaf key comes back for verifying the JWS');

    // A chain that is internally consistent and signed by somebody else. This
    // is the check that makes the rest of it mean anything: without it, anyone
    // can sign a payload with their own key and attach a matching chain.
    const other = await makeChain();
    await assertRejects(
      () => verifyChain(x5c, { rootSpkiBase64: other.rootSpki }),
      Error,
      'does not end at the expected root',
    );

    // A leaf swapped for one from another chain: the root still matches, but
    // the link below it does not.
    await assertRejects(
      () => verifyChain([other.x5c[0], x5c[1], x5c[2]], {
        rootSpkiBase64: rootSpki,
      }),
      Error,
      'is not signed by',
    );

    // Correct in every way except the clock.
    await assertRejects(
      () => verifyChain(x5c, {
        rootSpkiBase64: rootSpki,
        now: new Date('2000-01-01T00:00:00Z'),
      }),
      Error,
      'validity',
    );

    // A chain with nothing to verify against is not a chain.
    await assertRejects(
      () => verifyChain([x5c[0]], { rootSpkiBase64: rootSpki }),
      Error,
      'too short',
    );
  },
});

Deno.test({
  name: 'a tampered certificate body fails its issuer signature',
  ignore: !opensslAvailable,
  fn: async () => {
    const { x5c } = await makeChain();
    const leaf = parseCertificate(base64ToBytes(x5c[0]));
    const issuer = parseCertificate(base64ToBytes(x5c[1]));

    assert(await verifySignedBy(leaf, issuer.spki));

    // Flip a byte inside the signed portion. The signature still parses; it
    // just no longer covers what is there.
    const tampered = { ...leaf, tbs: Uint8Array.from(leaf.tbs) };
    tampered.tbs[tampered.tbs.length - 5] ^= 0xff;
    assertEquals(await verifySignedBy(tampered, issuer.spki), false);
  },
});
