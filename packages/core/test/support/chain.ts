// A real certificate chain, and payloads signed by it.
//
// Made with a throwaway root so the tests own every key. That is the whole
// point: a captured Apple chain can prove that a valid payload passes, and
// nothing else. The failures that matter are a chain ending at the wrong root,
// a broken link, an expired certificate and a body that its own signature does
// not cover, and none of those can be produced without holding the keys.

import { signEs256 } from '../../src/crypto/jwt.ts';
import { parseCertificate } from '../../src/crypto/x509.ts';
import { base64ToBytes, bytesToBase64 } from '../../src/crypto/encoding.ts';

export interface TestChain {
  /** Leaf, intermediate, root, base64 DER: the form an `x5c` header takes. */
  x5c: string[];
  /** The root's SubjectPublicKeyInfo, base64 DER, for pinning. */
  rootSpki: string;
  /** The leaf's private key as PKCS#8 PEM, for signing payloads. */
  leafKeyPem: string;
}

/**
 * Build a three-certificate chain with openssl, which every runner has.
 *
 * Everything is issued long-dated. Expiry is tested by moving the clock rather
 * than by issuing an expired certificate, because the openssl flags for
 * backdating one differ between versions and the check being tested reads a
 * clock either way.
 */
export async function makeChain(): Promise<TestChain> {
  const dir = await Deno.makeTempDir();
  const run = async (args: string[]) => {
    const { code, stderr } = await new Deno.Command('openssl', {
      args,
      cwd: dir,
      stdout: 'null',
      stderr: 'piped',
    }).output();
    if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  };

  // genpkey rather than ecparam, so the private keys come out as PKCS#8. That
  // is the only form Web Crypto's importKey accepts, and it is also the form an
  // App Store Connect .p8 file is in.
  const key = (name: string, curve: string) =>
    run([
      'genpkey',
      '-algorithm',
      'EC',
      '-pkeyopt',
      `ec_paramgen_curve:${curve}`,
      '-out',
      name,
    ]);

  // Root, self-signed, P-384 like Apple's.
  await key('root.key', 'P-384');
  await run([
    'req', '-new', '-x509', '-key', 'root.key', '-out', 'root.pem',
    '-days', '3650', '-subj', '/CN=Test Root',
  ]);

  // Intermediate, signed by the root.
  await key('mid.key', 'P-256');
  await run(['req', '-new', '-key', 'mid.key', '-out', 'mid.csr', '-subj', '/CN=Test Intermediate']);
  await run([
    'x509', '-req', '-in', 'mid.csr', '-CA', 'root.pem', '-CAkey', 'root.key',
    '-CAcreateserial', '-out', 'mid.pem', '-days', '3650',
  ]);

  // Leaf, signed by the intermediate. Apple signs with P-256 here.
  await key('leaf.key', 'P-256');
  await run(['req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=Test Leaf']);
  await run([
    'x509', '-req', '-in', 'leaf.csr', '-CA', 'mid.pem', '-CAkey', 'mid.key',
    '-CAcreateserial', '-out', 'leaf.pem', '-days', '3650',
  ]);

  const der = async (name: string) => {
    const pem = await Deno.readTextFile(`${dir}/${name}`);
    return pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  };

  const x5c = [await der('leaf.pem'), await der('mid.pem'), await der('root.pem')];
  const root = parseCertificate(base64ToBytes(x5c[2]));
  return {
    x5c,
    rootSpki: bytesToBase64(root.spki),
    leafKeyPem: await Deno.readTextFile(`${dir}/leaf.key`),
  };
}

/** Sign a payload the way Apple does: ES256, with the chain in the header. */
export function signJws(
  payload: unknown,
  chain: TestChain,
): Promise<string> {
  return signEs256(
    { alg: 'ES256', x5c: chain.x5c },
    payload as Record<string, unknown>,
    chain.leafKeyPem,
  );
}

/**
 * Whether openssl can be run to build a chain.
 *
 * A missing openssl is a reason to skip. A missing permission is not: these are
 * the tests standing between a forged Apple payload and a granted subscription,
 * and quietly skipping them because the runner was invoked without
 * `--allow-run` is how they come to be green and absent at the same time.
 */
export const opensslAvailable: boolean = await (async () => {
  try {
    const { code } = await new Deno.Command('openssl', {
      args: ['version'],
      stdout: 'null',
      stderr: 'null',
    }).output();
    return code === 0;
  } catch (e) {
    if (
      e instanceof Deno.errors.NotCapable ||
      e instanceof Deno.errors.PermissionDenied
    ) {
      throw new Error(
        'Certificate chain tests need --allow-run=openssl, --allow-read and ' +
          '--allow-write. Refusing to skip them silently.',
      );
    }
    return false;
  }
})();
