/**
 * The App Store Server API calls and the notification endpoint.
 *
 * `fetch` is stubbed and every request recorded, so these assert on the URLs
 * actually produced, including the sandbox retry. The payloads are signed by a
 * throwaway chain the test holds the keys to, which is what makes it possible
 * to check that a forged one is refused: with Apple's own chain the only case
 * that can be tested is the one that works.
 */

import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';

import { AppleAdapter } from '../src/adapters/apple/adapter.ts';
import type { StoreAdapter } from '../src/adapter.ts';
import type {
  AppleNotification,
  AppleRenewalInfo,
  AppleTransactionInfo,
} from '../src/adapters/apple/types.ts';
import { TollgateError } from '../src/errors.ts';
import { decodeJwt } from '../src/crypto/jwt.ts';
import { bytesToBase64 } from '../src/crypto/encoding.ts';
import { makeChain, opensslAvailable, signJws, type TestChain } from './support/chain.ts';

const BUNDLE = 'com.example.app';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const PROD = 'https://api.storekit.itunes.apple.com';
const SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';

/** An App Store Connect key, which is an EC P-256 key in a .p8 file. */
const P8 = await (async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return `-----BEGIN PRIVATE KEY-----\n${
    bytesToBase64(der).replace(/(.{64})/g, '$1\n')
  }\n-----END PRIVATE KEY-----\n`;
})();

const chain: TestChain | null = opensslAvailable ? await makeChain() : null;

// The real clock, because the certificates in `chain` are issued now and the
// chain check reads a clock. A fixed date here would make these tests start
// failing on whichever day it fell outside the generated validity window.
//
// Read AFTER the chain is built, and that order is load-bearing. X.509 stamps
// notBefore to the second, and issuing three certificates takes a second or
// two, so reading the clock first leaves this fixed `now` fractionally before
// the certificates exist. Every signature check then fails as "outside its
// validity", and it does it intermittently, depending on which side of a
// second boundary the run happens to land.
const NOW = Date.now();

function transaction(
  over: Partial<AppleTransactionInfo> = {},
): AppleTransactionInfo {
  return {
    transactionId: '2000000000000002',
    originalTransactionId: '2000000000000001',
    bundleId: BUNDLE,
    productId: 'premium.monthly',
    type: 'Auto-Renewable Subscription',
    purchaseDate: NOW - 86_400_000,
    expiresDate: NOW + 86_400_000 * 30,
    quantity: 1,
    appAccountToken: ACCOUNT,
    environment: 'Production',
    ...over,
  };
}

async function statusBody(
  over: Partial<AppleTransactionInfo> = {},
  renewal: Partial<AppleRenewalInfo> = {},
): Promise<string> {
  return JSON.stringify({
    environment: 'Production',
    bundleId: BUNDLE,
    data: [{
      subscriptionGroupIdentifier: '20000000',
      lastTransactions: [{
        originalTransactionId: '2000000000000001',
        status: 1,
        signedTransactionInfo: await signJws(transaction(over), chain!),
        signedRenewalInfo: await signJws(
          { originalTransactionId: '2000000000000001', autoRenewStatus: 1, ...renewal },
          chain!,
        ),
      }],
    }],
  });
}

interface Call {
  url: string;
  authorization: string;
}

function adapterWith(
  routes: Record<string, () => Response>,
  opts: { environment?: 'production' | 'sandbox'; root?: string } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization') ?? '',
    });
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return Promise.resolve(respond());
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;

  const adapter = new AppleAdapter({
    bundleId: BUNDLE,
    issuerId: '57246542-96fe-1a63-e053-0824d011072a',
    keyId: 'ABCD123456',
    privateKey: P8,
    environment: opts.environment,
    trustedRootSpki: opts.root ?? chain!.rootSpki,
    fetch: fetchImpl,
    now: () => NOW,
  });
  return { adapter, calls };
}

function ok(body: string): () => Response {
  return () => new Response(body, { status: 200 });
}

Deno.test({
  name: 'a device JWS names the transaction, and the API decides its state',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter, calls } = adapterWith({
      '/subscriptions/': ok(await statusBody()),
    });

    const purchase = await adapter.verify({
      token: await signJws(transaction(), chain!),
      userId: 'user-1',
      appAccountToken: ACCOUNT,
    });

    assertEquals(purchase.storeProductId, 'premium.monthly');
    assertEquals(purchase.status, 'active');
    assertEquals(purchase.originalTransactionId, '2000000000000001');
    // The kind came out of the client's own JWS, so the transactions endpoint
    // was never needed: Apple states the product type on the payload.
    assert(calls.every((c) => !c.url.includes('/transactions/')));
    assert(calls[0].url.startsWith(`${PROD}/inApps/v1/subscriptions/`));
  },
});

Deno.test({
  name: 'an unknown kind is resolved by asking, not guessed',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter, calls } = adapterWith({
      '/transactions/': ok(JSON.stringify({
        signedTransactionInfo: await signJws(transaction(), chain!),
      })),
      '/subscriptions/': ok(await statusBody()),
    });

    // A bare transaction id, which is what a restored purchase or an old client
    // sends. Apple's transaction endpoint takes any id and states the type,
    // so the subscription lookup that follows is informed rather than a guess.
    const purchase = await adapter.refresh({
      store: 'apple',
      originalTransactionId: '2000000000000002',
    });

    assertEquals(purchase?.kind, 'subscription');
    assertEquals(purchase?.status, 'active');
    assert(calls[0].url.includes('/transactions/2000000000000002'));
    assert(calls.some((c) => c.url.includes('/subscriptions/')));
  },
});

Deno.test({
  name: 'a one-time purchase never touches the subscription endpoint',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter, calls } = adapterWith({
      '/transactions/': ok(JSON.stringify({
        signedTransactionInfo: await signJws(
          transaction({
            type: 'Consumable',
            productId: 'gems.1',
            quantity: 2,
            expiresDate: undefined,
            transactionId: '3000000000000001',
            originalTransactionId: '3000000000000001',
          }),
          chain!,
        ),
      })),
    });

    const purchase = await adapter.verify({
      token: '3000000000000001',
      userId: 'user-1',
      appAccountToken: ACCOUNT,
      kind: 'consumable',
    });

    assertEquals(purchase.kind, 'consumable');
    assertEquals(purchase.quantity, 2);
    assertEquals(purchase.expiresAt, null);
    assert(calls.every((c) => !c.url.includes('/subscriptions/')));
  },
});

Deno.test({
  name: 'a purchase missing from one environment is looked for in the other',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter, calls } = adapterWith({
      [`${SANDBOX}/inApps/v1/subscriptions/`]: ok(
        await statusBody({ environment: 'Sandbox' }),
      ),
      // Production answers 404, which is what a sandbox purchase looks like
      // from there. Anything else would tell the buyer the App Store has no
      // record of a purchase they were just charged for.
    });

    const purchase = await adapter.refresh({
      store: 'apple',
      originalTransactionId: '2000000000000001',
      kind: 'subscription',
    });

    assertEquals(purchase?.environment, 'sandbox');
    assert(calls[0].url.startsWith(PROD));
    assert(calls[1].url.startsWith(SANDBOX));
  },
});

Deno.test({
  name: 'a purchase in neither environment is absent rather than an error',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter, calls } = adapterWith({});
    assertEquals(
      await adapter.refresh({
        store: 'apple',
        originalTransactionId: 'nope',
        kind: 'subscription',
      }),
      null,
    );
    assertEquals(calls.length, 2);
  },
});

Deno.test({
  name: 'a purchase made by somebody else is refused',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter } = adapterWith({
      '/subscriptions/': ok(await statusBody()),
    });

    const error = await assertRejects(
      () =>
        adapter.verify({
          token: '2000000000000001',
          userId: 'user-2',
          appAccountToken: '22222222-2222-4222-8222-222222222222',
          kind: 'subscription',
        }),
      TollgateError,
    );
    assertEquals(error.code, 'not_yours');
  },
});

Deno.test({
  name: 'a purchase from another app is refused',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter } = adapterWith({
      '/subscriptions/': ok(await statusBody({ bundleId: 'com.someone.else' })),
    });

    const error = await assertRejects(
      () =>
        adapter.verify({
          token: '2000000000000001',
          userId: 'user-1',
          appAccountToken: ACCOUNT,
          kind: 'subscription',
        }),
      TollgateError,
    );
    assertEquals(error.code, 'not_yours');
  },
});

Deno.test({
  name: 'a payload signed by anybody else is refused',
  ignore: !opensslAvailable,
  fn: async () => {
    const forged = await makeChain();
    const { adapter } = adapterWith({
      '/subscriptions/': ok(JSON.stringify({
        data: [{
          lastTransactions: [{
            originalTransactionId: '2000000000000001',
            status: 1,
            // Perfectly well-formed, internally consistent, and signed with a
            // key its author generated. Without the pinned root this grants a
            // subscription to whoever wrote it.
            signedTransactionInfo: await signJws(transaction(), forged),
          }],
        }],
      })),
    });

    const error = await assertRejects(
      () =>
        adapter.refresh({
          store: 'apple',
          originalTransactionId: '2000000000000001',
          kind: 'subscription',
        }),
      TollgateError,
    );
    assertEquals(error.code, 'bad_signature');
  },
});

Deno.test({
  name: 'the API token is a signed JWT for this app, and it is reused',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter, calls } = adapterWith({
      '/subscriptions/': ok(await statusBody()),
    });

    await adapter.refresh({
      store: 'apple',
      originalTransactionId: '2000000000000001',
      kind: 'subscription',
    });
    await adapter.refresh({
      store: 'apple',
      originalTransactionId: '2000000000000001',
      kind: 'subscription',
    });

    const { header, claims } = decodeJwt(calls[0].authorization.slice('Bearer '.length));
    assertEquals(header.alg, 'ES256');
    assertEquals(header.kid, 'ABCD123456');
    assertEquals(claims.aud, 'appstoreconnect-v1');
    assertEquals(claims.iss, '57246542-96fe-1a63-e053-0824d011072a');
    // Apple refuses a token whose bundle id is not the key's, which is what
    // stops one developer's key reading another's transactions.
    assertEquals(claims.bid, BUNDLE);
    assert((claims.exp as number) > (claims.iat as number));

    // Signing on every call would cost an ECDSA signature per notification.
    assertEquals(calls[0].authorization, calls[1].authorization);
  },
});

Deno.test({
  name: 'a refused key is reported as configuration, not as a blip',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter } = adapterWith({
      '/subscriptions/': () =>
        new Response(
          JSON.stringify({ errorCode: 4010000, errorMessage: 'Unauthenticated' }),
          { status: 401 },
        ),
    });

    const error = await assertRejects(
      () =>
        adapter.refresh({
          store: 'apple',
          originalTransactionId: '2000000000000001',
          kind: 'subscription',
        }),
      TollgateError,
    );
    assertEquals(error.code, 'invalid_request');
    assert(error.message.includes('In-App Purchase key'));
    assert(error.message.includes('4010000'));
  },
});

Deno.test({
  name: 'Apple being down asks for a retry, and a bad request does not',
  ignore: !opensslAvailable,
  fn: async () => {
    const down = adapterWith({
      '/subscriptions/': () => new Response('', { status: 503 }),
    });
    const outage = await assertRejects(
      () =>
        down.adapter.refresh({
          store: 'apple',
          originalTransactionId: '1',
          kind: 'subscription',
        }),
      TollgateError,
    );
    assertEquals(outage.code, 'store_unavailable');
    assertEquals(outage.retryable, true);

    const bad = adapterWith({
      '/subscriptions/': () => new Response('', { status: 400 }),
    });
    const rejected = await assertRejects(
      () =>
        bad.adapter.refresh({
          store: 'apple',
          originalTransactionId: '1',
          kind: 'subscription',
        }),
      TollgateError,
    );
    assertEquals(rejected.code, 'invalid_request');
    assertEquals(rejected.retryable, false);
  },
});

// --- notifications ----------------------------------------------------------

async function notify(
  adapter: AppleAdapter,
  note: Partial<AppleNotification>,
  data: Partial<AppleTransactionInfo> | null = {},
) {
  const signedPayload = await signJws(
    {
      version: '2.0',
      notificationUUID: 'a1b2c3d4-0000-4000-8000-000000000001',
      signedDate: NOW,
      ...note,
      data: data
        ? {
          bundleId: BUNDLE,
          environment: 'Production',
          status: 1,
          signedTransactionInfo: await signJws(transaction(data), chain!),
          ...(note.data ?? {}),
        }
        : note.data,
    },
    chain!,
  );
  return await adapter.parseNotification(
    new Request('https://example.test/hook', {
      method: 'POST',
      body: JSON.stringify({ signedPayload }),
    }),
  );
}

Deno.test({
  name: 'a renewal names the subscription to re-read',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter } = adapterWith({});
    const parsed = await notify(adapter, {
      notificationType: 'DID_RENEW',
    });

    assertEquals(parsed.eventType, 'DID_RENEW');
    assertEquals(parsed.storeEventId, 'a1b2c3d4-0000-4000-8000-000000000001');
    assertEquals(parsed.refs.length, 1);
    assertEquals(parsed.refs[0].originalTransactionId, '2000000000000001');
    assertEquals(parsed.refs[0].kind, 'subscription');
    assertEquals(parsed.revoked?.length ?? 0, 0);
  },
});

Deno.test({
  name: 'a subtype is kept, because it is often the whole news',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter } = adapterWith({});
    const parsed = await notify(adapter, {
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_DISABLED',
    });
    assertEquals(parsed.eventType, 'DID_CHANGE_RENEWAL_STATUS.AUTO_RENEW_DISABLED');
  },
});

Deno.test({
  name: 'a refund is reported as a revocation rather than a re-read',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter } = adapterWith({});
    const parsed = await notify(
      adapter,
      { notificationType: 'REFUND' },
      { revocationDate: NOW, revocationReason: 1 },
    );

    assertEquals(parsed.refs.length, 0);
    assertEquals(parsed.revoked?.length, 1);
    assertEquals(parsed.revoked?.[0].originalTransactionId, '2000000000000001');
  },
});

Deno.test({
  name: 'a notification about nothing in particular is handled and empty',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter } = adapterWith({});
    const parsed = await notify(adapter, { notificationType: 'TEST' }, null);

    assertEquals(parsed.eventType, 'TEST');
    assertEquals(parsed.refs.length, 0);
  },
});

Deno.test({
  name: 'a notification for another app is refused',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter } = adapterWith({});
    const error = await assertRejects(
      () =>
        notify(adapter, {
          notificationType: 'DID_RENEW',
          data: { bundleId: 'com.someone.else' },
        }, null),
      TollgateError,
    );
    assertEquals(error.code, 'invalid_request');
  },
});

Deno.test({
  name: 'an unsigned notification is refused, and so is an unsigned body',
  ignore: !opensslAvailable,
  fn: async () => {
    const { adapter } = adapterWith({});

    const unsigned = await assertRejects(
      () =>
        adapter.parseNotification(
          new Request('https://example.test/hook', {
            method: 'POST',
            body: JSON.stringify({ notificationType: 'DID_RENEW' }),
          }),
        ),
      TollgateError,
    );
    assertEquals(unsigned.code, 'bad_signature');

    const garbage = await assertRejects(
      () =>
        adapter.parseNotification(
          new Request('https://example.test/hook', {
            method: 'POST',
            body: 'not json',
          }),
        ),
      TollgateError,
    );
    assertEquals(garbage.code, 'bad_signature');
  },
});

Deno.test('cancelling is a page, because an app cannot do it', () => {
  const adapter: StoreAdapter = new AppleAdapter({
    bundleId: BUNDLE,
    issuerId: 'issuer',
    keyId: 'key',
    privateKey: P8,
  });
  assertEquals(
    adapter.manageUrl?.(transaction() as never),
    'https://apps.apple.com/account/subscriptions',
  );
  // Apple has no server-side acknowledgement: finishing is the device's job,
  // and an adapter that offered one would have the orchestrator waiting on a
  // call that cannot exist.
  assertEquals(adapter.finish, undefined);
});

Deno.test('missing credentials are refused at construction', () => {
  const error = assertThrows(
    () =>
      new AppleAdapter({
        bundleId: '',
        issuerId: 'issuer',
        keyId: 'key',
        privateKey: P8,
      }),
    TollgateError,
    'bundleId',
  );
  assertEquals((error as TollgateError).code, 'invalid_request');
});
