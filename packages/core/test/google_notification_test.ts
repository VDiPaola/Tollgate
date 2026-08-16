/**
 * The notification path: signature checking, envelope decoding, and which
 * purchases an event turns out to be about.
 *
 * The signing here is real. A key pair is generated, tokens are signed with it,
 * and the JWKS endpoint is stubbed to serve the matching public key, so the
 * verification code is genuinely exercised rather than mocked past.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';

import { GoogleAdapter } from '../src/adapters/google/adapter.ts';
import { resetGoogleKeyCache, signRs256 } from '../src/crypto/jwt.ts';
import { base64UrlEncode, bytesToBase64 } from '../src/crypto/encoding.ts';
import { TollgateError } from '../src/errors.ts';
import type { DeveloperNotification } from '../src/adapters/google/types.ts';

const PACKAGE = 'com.example.app';
const AUDIENCE = 'https://example.supabase.co/functions/v1/tollgate-google';
const PUSH_EMAIL = 'pubsub-pusher@example.iam.gserviceaccount.com';
const KID = 'test-key-1';
const NOW = Date.parse('2026-08-16T12:00:00.000Z');

// A throwaway RSA key pair standing in for Google's.
const pair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);

const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
const privatePem = await exportPem(pair.privateKey);

async function exportPem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key));
  const b64 = bytesToBase64(der).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** A Google-shaped ID token, signed with the stand-in key. */
async function idToken(over: Record<string, unknown> = {}): Promise<string> {
  const issued = Math.floor(NOW / 1000);
  return await signRs256(
    { alg: 'RS256', typ: 'JWT', kid: KID },
    {
      iss: 'https://accounts.google.com',
      aud: AUDIENCE,
      email: PUSH_EMAIL,
      email_verified: true,
      iat: issued,
      exp: issued + 3600,
      ...over,
    },
    privatePem,
  );
}

/** Serves the stand-in public key where Google's JWKS lives, and nothing else. */
function stubFetch(): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('oauth2/v3/certs')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }],
          }),
          {
            status: 200,
            headers: { 'cache-control': 'public, max-age=3600' },
          },
        ),
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as typeof fetch;
}

function adapter(): GoogleAdapter {
  return new GoogleAdapter({
    packageName: PACKAGE,
    // Never exercised in this file: nothing here reaches the Play API.
    serviceAccount: {
      client_email: 'svc@example.iam.gserviceaccount.com',
      private_key: privatePem,
    },
    pubsubAudience: AUDIENCE,
    pubsubServiceAccountEmail: PUSH_EMAIL,
    fetch: stubFetch(),
    now: () => NOW,
  });
}

async function push(
  note: DeveloperNotification,
  opts: { token?: string; messageId?: string } = {},
): Promise<Request> {
  const token = opts.token ?? await idToken();
  return new Request(AUDIENCE, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        data: base64UrlEncode(JSON.stringify(note)),
        messageId: opts.messageId ?? '12345678901234',
        publishTime: '2026-08-16T12:00:00.000Z',
      },
      subscription: 'projects/example/subscriptions/play-rtdn-dev',
    }),
  });
}

function subNote(
  notificationType: number,
  over: Partial<DeveloperNotification> = {},
): DeveloperNotification {
  return {
    version: '1.0',
    packageName: PACKAGE,
    eventTimeMillis: String(NOW),
    subscriptionNotification: {
      version: '1.0',
      notificationType,
      purchaseToken: 'token-abc',
      subscriptionId: 'premium',
    },
    ...over,
  };
}

Deno.test('a properly signed push is accepted and decoded', async () => {
  resetGoogleKeyCache();
  const parsed = await adapter().parseNotification(await push(subNote(4)));

  assertEquals(parsed.eventType, 'SUBSCRIPTION_PURCHASED');
  assertEquals(parsed.storeEventId, '12345678901234');
  assertEquals(parsed.refs.length, 1);
  assertEquals(parsed.refs[0].originalTransactionId, 'token-abc');
  assertEquals(parsed.refs[0].storeProductId, 'premium');
  assertEquals(parsed.refs[0].kind, 'subscription');
  assertEquals(parsed.revoked?.length ?? 0, 0);
});

Deno.test('the message id is the dedupe key', async () => {
  resetGoogleKeyCache();
  const a = await adapter().parseNotification(
    await push(subNote(2), { messageId: 'm-1' }),
  );
  const b = await adapter().parseNotification(
    await push(subNote(2), { messageId: 'm-2' }),
  );
  assertEquals(a.storeEventId, 'm-1');
  assertEquals(b.storeEventId, 'm-2');
});

Deno.test('an unsigned push is refused', async () => {
  resetGoogleKeyCache();
  const req = new Request(AUDIENCE, {
    method: 'POST',
    body: JSON.stringify({ message: { data: '', messageId: 'x' } }),
  });
  const e = await assertRejects(() => adapter().parseNotification(req));
  assertEquals((e as TollgateError).code, 'bad_signature');
});

Deno.test('a token for another audience is refused', async () => {
  resetGoogleKeyCache();
  const token = await idToken({ aud: 'https://someone-elses-service.example' });
  const req = await push(subNote(4), { token });
  const e = await assertRejects(() => adapter().parseNotification(req));
  assertEquals((e as TollgateError).code, 'bad_signature');
});

Deno.test('a token from another service account is refused', async () => {
  resetGoogleKeyCache();
  // Correctly signed by Google, correct audience, wrong customer. Without the
  // email check this would be accepted, and anyone able to make Google mint a
  // token for this URL could post notifications.
  const token = await idToken({ email: 'someone-else@evil.iam.gserviceaccount.com' });
  const req = await push(subNote(4), { token });
  const e = await assertRejects(() => adapter().parseNotification(req));
  assertEquals((e as TollgateError).code, 'bad_signature');
});

Deno.test('an expired token is refused', async () => {
  resetGoogleKeyCache();
  const issued = Math.floor(NOW / 1000) - 7200;
  const token = await idToken({ iat: issued, exp: issued + 3600 });
  const req = await push(subNote(4), { token });
  const e = await assertRejects(() => adapter().parseNotification(req));
  assertEquals((e as TollgateError).code, 'bad_signature');
});

Deno.test('a notification for another app is refused', async () => {
  resetGoogleKeyCache();
  const req = await push(subNote(4, { packageName: 'com.example.other' }));
  const e = await assertRejects(() => adapter().parseNotification(req));
  assertEquals((e as TollgateError).code, 'invalid_request');
});

Deno.test('a revoked subscription is reported as revoked, not as a refresh', async () => {
  resetGoogleKeyCache();
  // SUBSCRIPTION_REVOKED. Re-reading would not reveal this: Play can still
  // report the subscription as active until it catches up, so the notification
  // is the only place the refund is stated.
  const parsed = await adapter().parseNotification(await push(subNote(12)));

  assertEquals(parsed.eventType, 'SUBSCRIPTION_REVOKED');
  assertEquals(parsed.refs.length, 0);
  assertEquals(parsed.revoked?.length, 1);
  assertEquals(parsed.revoked?.[0].originalTransactionId, 'token-abc');
});

Deno.test('a voided purchase is reported as revoked', async () => {
  resetGoogleKeyCache();
  const parsed = await adapter().parseNotification(
    await push({
      version: '1.0',
      packageName: PACKAGE,
      eventTimeMillis: String(NOW),
      voidedPurchaseNotification: {
        purchaseToken: 'token-gems',
        orderId: 'GPA.1',
        productType: 2,
        refundType: 1,
      },
    }),
  );

  assertEquals(parsed.eventType, 'VOIDED_PURCHASE');
  assertEquals(parsed.revoked?.length, 1);
  assertEquals(parsed.revoked?.[0].originalTransactionId, 'token-gems');
});

Deno.test('a one-time purchase notification points at the products endpoint', async () => {
  resetGoogleKeyCache();
  const parsed = await adapter().parseNotification(
    await push({
      version: '1.0',
      packageName: PACKAGE,
      eventTimeMillis: String(NOW),
      oneTimeProductNotification: {
        version: '1.0',
        notificationType: 1,
        purchaseToken: 'token-gems',
        sku: 'gems_500',
      },
    }),
  );

  assertEquals(parsed.eventType, 'ONE_TIME_PRODUCT_PURCHASED');
  assertEquals(parsed.refs[0].storeProductId, 'gems_500');
  // Play cannot say whether this is consumable; what matters here is only that
  // the ref does not read as a subscription, which would query the wrong API.
  assert(parsed.refs[0].kind !== 'subscription');
});

Deno.test('the console test notification names no purchase and breaks nothing', async () => {
  resetGoogleKeyCache();
  const parsed = await adapter().parseNotification(
    await push({
      version: '1.0',
      packageName: PACKAGE,
      eventTimeMillis: String(NOW),
      testNotification: { version: '1.0' },
    }),
  );

  assertEquals(parsed.eventType, 'TEST');
  assertEquals(parsed.refs.length, 0);
  assertEquals(parsed.revoked?.length ?? 0, 0);
});

Deno.test('an unknown notification type is named rather than dropped', async () => {
  resetGoogleKeyCache();
  const parsed = await adapter().parseNotification(await push(subNote(99)));
  // Play adds these over time. Recording it under a legible name beats
  // discarding an event nobody has taught this code about yet.
  assertEquals(parsed.eventType, 'SUBSCRIPTION_99');
  assertEquals(parsed.refs.length, 1);
});

Deno.test('notifications are refused outright when no audience is configured', async () => {
  resetGoogleKeyCache();
  const noAudience = new GoogleAdapter({
    packageName: PACKAGE,
    serviceAccount: { client_email: 'a@b.com', private_key: privatePem },
    fetch: stubFetch(),
    now: () => NOW,
  });
  // Failing closed. An adapter that accepted unauthenticated pushes because
  // nobody configured the check would be a public write endpoint.
  const req = await push(subNote(4));
  const e = await assertRejects(() => noAudience.parseNotification(req));
  assertEquals((e as TollgateError).code, 'invalid_request');
});
