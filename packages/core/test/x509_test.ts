// Certificate chain verification, against a chain generated here.
//
// Real certificates, made with a throwaway root so the test owns every key and
// can therefore produce the failures that matter: a chain ending at the wrong
// root, a broken link, an expired certificate. Those are the cases where a
// mistake turns a signature check into decoration, and none of them can be
// exercised with a captured chain nobody holds the keys for.

import { assert, assertEquals, assertRejects } from '@std/assert';

import { parseCertificate, verifyChain, verifySignedBy } from '../src/crypto/x509.ts';
import { base64ToBytes, bytesToBase64 } from '../src/crypto/encoding.ts';

/** Build a chain with openssl, which every machine running these tests has. */
async function makeChain(): Promise<{ chain: string[]; rootSpki: string }> {
  const dir = await Deno.makeTempDir();
  const run = async (args: string[]) => {
    const { code, stderr } = await new Deno.Command('openssl', {
      args,
      cwd: dir,
      stdout: 'null',
      stderr: 'piped',
    }).output();
    if (code !== 0) {
      throw new Error(new TextDecoder().decode(stderr));
    }
  };

  // Root, self-signed, P-384 like Apple's.
  await run(['ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'root.key']);
  await run([
    'req', '-new', '-x509', '-key', 'root.key', '-out', 'root.pem',
    '-days', '3650', '-subj', '/CN=Test Root',
  ]);

  // Intermediate, signed by the root.
  await run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'mid.key']);
  await run(['req', '-new', '-key', 'mid.key', '-out', 'mid.csr', '-subj', '/CN=Test Intermediate']);
  await run([
    'x509', '-req', '-in', 'mid.csr', '-CA', 'root.pem', '-CAkey', 'root.key',
    '-CAcreateserial', '-out', 'mid.pem', '-days', '3650',
  ]);

  // Leaf, signed by the intermediate.
  await run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key']);
  await run(['req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=Test Leaf']);
  await run([
    'x509', '-req', '-in', 'leaf.csr', '-CA', 'mid.pem', '-CAkey', 'mid.key',
    '-CAcreateserial', '-out', 'leaf.pem', '-days', '3650',
  ]);

  const der = async (name: string) => {
    const pem = await Deno.readTextFile(`${dir}/${name}`);
    return pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  };

  const chain = [await der('leaf.pem'), await der('mid.pem'), await der('root.pem')];
  const root = parseCertificate(base64ToBytes(chain[2]));
  return { chain, rootSpki: bytesToBase64(root.spki) };
}

/**
 * Whether openssl can be run to build a chain.
 *
 * A missing openssl is a reason to skip. A missing permission is not: these are
 * the tests standing between a forged Apple payload and a granted subscription,
 * and quietly skipping them because the runner was invoked without
 * `--allow-run` is how they come to be green and absent at the same time.
 */
const available = await (async () => {
  try {
    const { code } = await new Deno.Command('openssl', {
      args: ['version'],
      stdout: 'null',
      stderr: 'null',
    }).output();
    return code === 0;
  } catch (e) {
    if (e instanceof Deno.errors.NotCapable || e instanceof Deno.errors.PermissionDenied) {
      throw new Error(
        'Certificate chain tests need --allow-run=openssl, --allow-read and ' +
          '--allow-write. Refusing to skip them silently.',
      );
    }
    return false;
  }
})();

Deno.test({
  name: 'a real chain verifies, and every way of breaking it does not',
  ignore: !available,
  fn: async () => {
    const { chain, rootSpki } = await makeChain();

    const leaf = await verifyChain(chain, { rootSpkiBase64: rootSpki });
    assert(leaf.spki.length > 0, 'the leaf key comes back for verifying the JWS');

    // A chain that is internally consistent and signed by somebody else. This
    // is the check that makes the rest of it mean anything: without it, anyone
    // can sign a payload with their own key and attach a matching chain.
    const other = await makeChain();
    await assertRejects(
      () => verifyChain(chain, { rootSpkiBase64: other.rootSpki }),
      Error,
      'does not end at the expected root',
    );

    // A leaf swapped for one from another chain: the root still matches, but
    // the link below it does not.
    await assertRejects(
      () => verifyChain([other.chain[0], chain[1], chain[2]], {
        rootSpkiBase64: rootSpki,
      }),
      Error,
      'is not signed by',
    );

    // Correct in every way except the clock.
    await assertRejects(
      () => verifyChain(chain, {
        rootSpkiBase64: rootSpki,
        now: new Date('2000-01-01T00:00:00Z'),
      }),
      Error,
      'validity',
    );

    // A chain with nothing to verify against is not a chain.
    await assertRejects(
      () => verifyChain([chain[0]], { rootSpkiBase64: rootSpki }),
      Error,
      'too short',
    );
  },
});

Deno.test({
  name: 'a tampered certificate body fails its issuer signature',
  ignore: !available,
  fn: async () => {
    const { chain } = await makeChain();
    const leaf = parseCertificate(base64ToBytes(chain[0]));
    const issuer = parseCertificate(base64ToBytes(chain[1]));

    assert(await verifySignedBy(leaf, issuer.spki));

    // Flip a byte inside the signed portion. The signature still parses; it
    // just no longer covers what is there.
    const tampered = { ...leaf, tbs: Uint8Array.from(leaf.tbs) };
    tampered.tbs[tampered.tbs.length - 5] ^= 0xff;
    assertEquals(await verifySignedBy(tampered, issuer.spki), false);
  },
});
