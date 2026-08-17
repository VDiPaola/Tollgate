/**
 * The Play Developer API calls: which endpoint gets used, what happens when it
 * says no, and the access-token exchange in front of all of it.
 *
 * `fetch` is stubbed and every request is recorded, so these assert on the URLs
 * and methods actually produced. That is the part no amount of reading the
 * documentation confirms.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';

import { GoogleAdapter } from '../src/adapters/google/adapter.ts';
import { GoogleAuth } from '../src/adapters/google/auth.ts';
import { parseServiceAccount } from '../src/adapters/google/auth.ts';
import { TollgateError } from '../src/errors.ts';
import { bytesToBase64, utf8 } from '../src/crypto/encoding.ts';

const PACKAGE = 'com.example.app';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-08-16T12:00:00.000Z');

const keyPair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);

const privatePem = await (async () => {
  const der = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  );
  return `-----BEGIN PRIVATE KEY-----\n${
    bytesToBase64(der).replace(/(.{64})/g, '$1\n')
  }\n-----END PRIVATE KEY-----\n`;
})();

const SERVICE_ACCOUNT = {
  client_email: 'svc@example.iam.gserviceaccount.com',
  private_key: privatePem,
  private_key_id: 'key-1',
  project_id: 'example',
};

interface Call {
  url: string;
  method: string;
}

/** Answers the token exchange, then whatever each test scripts per path. */
function stub(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method });

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: 'ya29.stub', expires_in: 3600 }),
          { status: 200 },
        ),
      );
    }
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return Promise.resolve(respond());
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function adapterWith(routes: Record<string, () => Response>) {
  const { fetchImpl, calls } = stub(routes);
  return {
    calls,
    adapter: new GoogleAdapter({
      packageName: PACKAGE,
      serviceAccount: SERVICE_ACCOUNT,
      fetch: fetchImpl,
      now: () => NOW,
    }),
  };
}

const SUBSCRIPTION_BODY = {
  startTime: '2026-08-01T10:00:00.000Z',
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  latestOrderId: 'GPA.1111-2222-3333-44444',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  externalAccountIdentifiers: { obfuscatedExternalAccountId: ACCOUNT },
  lineItems: [{
    productId: 'premium',
    expiryTime: '2026-09-01T10:00:00.000Z',
    offerDetails: { basePlanId: 'monthly' },
    autoRenewingPlan: { autoRenewEnabled: true },
  }],
};

const PRODUCT_BODY = {
  orderId: 'GPA.9999-8888-7777-66666',
  purchaseCompletionTime: '2026-08-16T09:00:00.000Z',
  purchaseStateContext: { purchaseState: 'PURCHASED' },
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  obfuscatedExternalAccountId: ACCOUNT,
  productLineItem: [{
    productId: 'gems_500',
    productOfferDetails: {
      quantity: 1,
      consumptionState: 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED',
    },
  }],
};

function ok(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { status: 200 });
}

Deno.test('a subscription is read from subscriptionsv2, by token alone', async () => {
  const { adapter, calls } = adapterWith({
    'subscriptionsv2': ok(SUBSCRIPTION_BODY),
  });

  const p = await adapter.verify({
    token: 'token-abc',
    userId: 'u',
    appAccountToken: ACCOUNT,
    kind: 'subscription',
  });

  assertEquals(p.status, 'active');
  assertEquals(p.storeProductId, 'premium');

  const call = calls.find((c) => c.url.includes('subscriptionsv2'))!;
  assert(call.url.includes(`/applications/${PACKAGE}/`), call.url);
  assert(call.url.endsWith('/purchases/subscriptionsv2/tokens/token-abc'), call.url);
  assertEquals(call.method, 'GET');
});

Deno.test('a one-time purchase is read from productsv2, by token alone', async () => {
  const { adapter, calls } = adapterWith({ '/purchases/productsv2/': ok(PRODUCT_BODY) });

  const p = await adapter.verify({
    token: 'token-gems',
    userId: 'u',
    appAccountToken: ACCOUNT,
    kind: 'consumable',
  });

  // v2 takes the token alone. The v1 endpoint needed the product id in the
  // path, which meant a refund naming only a token could not be looked up.
  const call = calls.find((c) => c.url.includes('/purchases/productsv2/'))!;
  assert(call.url.endsWith('/purchases/productsv2/tokens/token-gems'), call.url);
  assertEquals(p.storeProductId, 'gems_500');
  assertEquals(p.status, 'active');
  assertEquals(p.kind, 'consumable');
  assertEquals(p.environment, 'production');
});

Deno.test('a productsv2 test purchase is marked sandbox', async () => {
  const { adapter } = adapterWith({
    '/purchases/productsv2/': ok({
      ...PRODUCT_BODY,
      testPurchaseContext: { fopType: 'TEST' },
    }),
  });

  const p = await adapter.verify({
    token: 'token-gems',
    userId: 'u',
    appAccountToken: ACCOUNT,
    kind: 'consumable',
  });
  assertEquals(p.environment, 'sandbox');
});

Deno.test('a purchase carrying somebody elses account token is refused', async () => {
  const { adapter } = adapterWith({ 'subscriptionsv2': ok(SUBSCRIPTION_BODY) });

  const e = await assertRejects(() =>
    adapter.verify({
      token: 'token-abc',
      userId: 'u',
      appAccountToken: '99999999-9999-4999-8999-999999999999',
      kind: 'subscription',
    })
  );
  // A purchase token passes through a client, so this is the check that stops
  // a stolen one being redeemed by whoever presents it first.
  assertEquals((e as TollgateError).code, 'not_yours');
});

Deno.test('a 404 means gone, not broken', async () => {
  const { adapter } = adapterWith({
    'subscriptionsv2': () => new Response('{}', { status: 404 }),
  });

  // Play forgets consumed purchases and long-expired subscriptions. Nothing to
  // record and nothing to revoke, so the stored row is left to age out.
  const p = await adapter.refresh({
    store: 'google',
    originalTransactionId: 'token-gone',
    kind: 'subscription',
  });
  assertEquals(p, null);
});

Deno.test('a 403 says what it usually means', async () => {
  const { adapter } = adapterWith({
    'subscriptionsv2': () =>
      new Response('{"error":{"message":"The current user has insufficient permissions"}}', {
        status: 403,
      }),
  });

  const e = await assertRejects(() =>
    adapter.refresh({
      store: 'google',
      originalTransactionId: 'token-abc',
      kind: 'subscription',
    })
  ) as TollgateError;

  assertEquals(e.code, 'invalid_request');
  // Not retryable, and the message names the actual cause, because the default
  // assumption is a broken key and the answer is nearly always permissions
  // that have not propagated yet.
  assert(!e.retryable);
  assert(e.message.includes('propagated'), e.message);
});

Deno.test('a 500 is retryable and a 400 is not', async () => {
  const server = adapterWith({
    'subscriptionsv2': () => new Response('boom', { status: 503 }),
  });
  const e1 = await assertRejects(() =>
    server.adapter.refresh({
      store: 'google',
      originalTransactionId: 't',
      kind: 'subscription',
    })
  ) as TollgateError;
  assert(e1.retryable);

  const client = adapterWith({
    'subscriptionsv2': () => new Response('nope', { status: 400 }),
  });
  const e2 = await assertRejects(() =>
    client.adapter.refresh({
      store: 'google',
      originalTransactionId: 't',
      kind: 'subscription',
    })
  ) as TollgateError;
  assert(!e2.retryable);
});

// --- finishing --------------------------------------------------------------

Deno.test('a consumable is consumed, not merely acknowledged', async () => {
  const { adapter, calls } = adapterWith({
    ':consume': ok({}),
    ':acknowledge': ok({}),
  });

  await adapter.finish({
    store: 'google',
    storeTransactionId: 'GPA.1',
    originalTransactionId: 'token-gems',
    storeProductId: 'gems_500',
    kind: 'consumable',
    status: 'active',
    environment: 'production',
    offerType: 'none',
    purchasedAt: '2026-08-16T00:00:00.000Z',
    expiresAt: null,
    willRenew: false,
    quantity: 1,
    appAccountToken: ACCOUNT,
    raw: PRODUCT_BODY,
  });

  const call = calls.find((c) => c.url.includes('/purchases/products/'))!;
  // Acknowledging instead would leave the customer unable to ever buy a second
  // one, which is a bug that only shows up on the second purchase.
  assert(call.url.endsWith(':consume'), call.url);
  assertEquals(call.method, 'POST');
});

Deno.test('a subscription is acknowledged on its own endpoint', async () => {
  const { adapter, calls } = adapterWith({ ':acknowledge': ok({}) });

  await adapter.finish({
    store: 'google',
    storeTransactionId: 'GPA.1',
    originalTransactionId: 'token-abc',
    storeProductId: 'premium',
    kind: 'subscription',
    status: 'active',
    environment: 'production',
    offerType: 'none',
    purchasedAt: '2026-08-16T00:00:00.000Z',
    expiresAt: '2026-09-16T00:00:00.000Z',
    willRenew: true,
    quantity: 1,
    appAccountToken: ACCOUNT,
    raw: SUBSCRIPTION_BODY,
  });

  const call = calls.find((c) => c.url.includes('/purchases/subscriptions/'))!;
  assert(
    call.url.endsWith('/purchases/subscriptions/premium/tokens/token-abc:acknowledge'),
    call.url,
  );
});

Deno.test('something already settled is not settled again', async () => {
  const { adapter, calls } = adapterWith({});

  await adapter.finish({
    store: 'google',
    storeTransactionId: 'GPA.1',
    originalTransactionId: 'token-abc',
    storeProductId: 'premium',
    kind: 'subscription',
    status: 'active',
    environment: 'production',
    offerType: 'none',
    purchasedAt: '2026-08-16T00:00:00.000Z',
    expiresAt: '2026-09-16T00:00:00.000Z',
    willRenew: true,
    quantity: 1,
    appAccountToken: ACCOUNT,
    raw: {
      ...SUBSCRIPTION_BODY,
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    },
  });

  // Play answers 400 to a second acknowledge. A failed finish is only logged,
  // so this would be a predictable error on every notification, hiding real
  // ones underneath it.
  assertEquals(calls.filter((c) => c.url.includes(':acknowledge')).length, 0);
});

Deno.test('the manage link points at Play, since an IAP cannot be cancelled in-app', () => {
  const { adapter } = adapterWith({});
  const url = adapter.manageUrl({
    store: 'google',
    storeTransactionId: 'GPA.1',
    originalTransactionId: 'token-abc',
    storeProductId: 'premium',
    kind: 'subscription',
    status: 'active',
    environment: 'production',
    offerType: 'none',
    purchasedAt: '2026-08-16T00:00:00.000Z',
    expiresAt: null,
    willRenew: true,
    quantity: 1,
    appAccountToken: null,
  })!;

  assert(url.includes('play.google.com'));
  assert(url.includes('sku=premium'));
  assert(url.includes(`package=${PACKAGE}`));
});

// --- authentication ---------------------------------------------------------

Deno.test('the access token is minted once and reused', async () => {
  const { fetchImpl, calls } = stub({});
  const auth = new GoogleAuth(SERVICE_ACCOUNT, fetchImpl);

  const first = await auth.accessToken(NOW);
  const second = await auth.accessToken(NOW + 60_000);

  assertEquals(first, 'ya29.stub');
  assertEquals(second, 'ya29.stub');
  // An hour-long token fetched per call would put an RSA signature and a round
  // trip in front of every notification.
  assertEquals(calls.length, 1);

  // And it is refreshed before it actually expires, not after.
  await auth.accessToken(NOW + 3600_000);
  assertEquals(calls.length, 2);
});

Deno.test('concurrent cold calls mint one token between them', async () => {
  const { fetchImpl, calls } = stub({});
  const auth = new GoogleAuth(SERVICE_ACCOUNT, fetchImpl);

  await Promise.all([
    auth.accessToken(NOW),
    auth.accessToken(NOW),
    auth.accessToken(NOW),
  ]);
  assertEquals(calls.length, 1);
});

Deno.test('a rejected assertion is reported as configuration, not as a blip', async () => {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response('{"error":"invalid_grant"}', { status: 400 }),
    )) as typeof fetch;
  const auth = new GoogleAuth(SERVICE_ACCOUNT, fetchImpl);

  const e = await assertRejects(() => auth.accessToken(NOW)) as TollgateError;
  // Retrying a key Google has refused will never work, and saying "try again"
  // sends somebody looking in the wrong place for a day.
  assert(!e.retryable);
  assert(e.message.includes('propagated'), e.message);
});

Deno.test('a service account key is read from base64 or raw JSON', () => {
  const raw = JSON.stringify(SERVICE_ACCOUNT);
  const encoded = bytesToBase64(utf8(raw));

  assertEquals(parseServiceAccount(encoded).client_email, SERVICE_ACCOUNT.client_email);
  assertEquals(parseServiceAccount(raw).client_email, SERVICE_ACCOUNT.client_email);
  assertEquals(
    parseServiceAccount(`  ${encoded}  `).client_email,
    SERVICE_ACCOUNT.client_email,
  );
});

Deno.test('an unusable service account key says so plainly', () => {
  const e1 = assertThrowsCode(() => parseServiceAccount('not-a-key'));
  assertEquals(e1, 'invalid_request');

  const e2 = assertThrowsCode(() =>
    parseServiceAccount(JSON.stringify({ client_email: 'a@b.com' }))
  );
  assertEquals(e2, 'invalid_request');
});

function assertThrowsCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as TollgateError).code;
  }
  throw new Error('Expected a throw.');
}

Deno.test('a token of unknown kind falls back to the other endpoint', async () => {
  // The exact failure this exists for: a real, paid-for one-time purchase
  // looked up on the subscriptions endpoint answers 404, and the customer is
  // told Google Play has no record of a purchase they were just charged for.
  const { adapter, calls } = adapterWith({
    'subscriptionsv2': () => new Response('{}', { status: 404 }),
    '/purchases/productsv2/': ok(PRODUCT_BODY),
  });

  const p = await adapter.refresh({
    store: 'google',
    originalTransactionId: 'token-gems',
    // Deliberately unstated, as a restored purchase arrives.
  });

  assertEquals(p?.storeProductId, 'gems_500');
  assertEquals(p?.status, 'active');
  assert(calls.some((c) => c.url.includes('subscriptionsv2')));
  assert(calls.some((c) => c.url.includes('/purchases/productsv2/')));
});

Deno.test('a stated kind is trusted, and costs no second request', async () => {
  const { adapter, calls } = adapterWith({
    'subscriptionsv2': () => new Response('{}', { status: 404 }),
  });

  const p = await adapter.refresh({
    store: 'google',
    originalTransactionId: 'token-gone',
    kind: 'subscription',
  });

  assertEquals(p, null);
  // No fallback. The caller said what it was, so a 404 means gone rather than
  // looked up in the wrong place.
  assertEquals(calls.filter((c) => c.url.includes('productsv2')).length, 0);
});
