/**
 * Stripe: normalisation from recorded payloads, and webhook signatures signed
 * for real with a known secret.
 */

import { assert, assertEquals, assertFalse, assertRejects } from '@std/assert';

import { StripeAdapter } from '../src/adapters/stripe/adapter.ts';
import {
  normalizePaymentIntent,
  normalizeSubscription,
  subscriptionStatus,
} from '../src/adapters/stripe/normalize.ts';
import type {
  StripePaymentIntent,
  StripeSubscription,
} from '../src/adapters/stripe/types.ts';
import { hmacSha256Hex } from '../src/crypto/hmac.ts';
import { TollgateError } from '../src/errors.ts';
import { purchaseEntitles } from '../src/types.ts';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SECRET = 'whsec_test_secret';
const NOW = Date.parse('2026-08-17T12:00:00.000Z');

const ctx = {
  accountTokenKey: 'tollgate_account_token',
  productKey: 'tollgate_product',
};

function subscription(over: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_1ABC',
    object: 'subscription',
    status: 'active',
    customer: 'cus_1ABC',
    latest_invoice: 'in_1ABC',
    start_date: Math.floor(Date.parse('2026-08-01T10:00:00Z') / 1000),
    cancel_at_period_end: false,
    livemode: false,
    metadata: { tollgate_account_token: ACCOUNT },
    items: {
      data: [{
        id: 'si_1',
        current_period_end: Math.floor(Date.parse('2026-09-01T10:00:00Z') / 1000),
        price: { id: 'price_premium', currency: 'gbp', unit_amount: 599 },
      }],
    },
    ...over,
  };
}

Deno.test('an active subscription normalizes completely', () => {
  const p = normalizeSubscription(subscription(), ctx);

  assertEquals(p.store, 'stripe');
  assertEquals(p.kind, 'subscription');
  assertEquals(p.status, 'active');
  assertEquals(p.storeProductId, 'price_premium');
  assertEquals(p.expiresAt, '2026-09-01T10:00:00.000Z');
  assert(p.willRenew);
  assertEquals(p.appAccountToken, ACCOUNT);
  assertEquals(p.priceAmountMicros, 5_990_000);
  assertEquals(p.priceCurrency, 'gbp');
  assert(purchaseEntitles(p, new Date('2026-08-17T00:00:00Z')));
});

Deno.test('the subscription is the original id and the invoice is the transaction', () => {
  const p = normalizeSubscription(subscription(), ctx);
  // The subscription id is stable for its whole life, so it is what a webhook
  // about a renewal names. The invoice changes every period, which is what
  // gives each billing period its own row.
  assertEquals(p.originalTransactionId, 'sub_1ABC');
  assertEquals(p.storeTransactionId, 'in_1ABC');

  const renewed = normalizeSubscription(
    subscription({ latest_invoice: 'in_2DEF' }),
    ctx,
  );
  assertEquals(renewed.originalTransactionId, 'sub_1ABC');
  assert(renewed.storeTransactionId !== p.storeTransactionId);
});

Deno.test('the period is read from either place Stripe puts it', () => {
  // Stripe moved this onto the items, and both shapes are live depending on the
  // pinned API version.
  const onItem = normalizeSubscription(subscription(), ctx);
  const onSub = normalizeSubscription(
    subscription({
      items: { data: [{ price: { id: 'price_premium' } }] },
      current_period_end: Math.floor(Date.parse('2026-09-01T10:00:00Z') / 1000),
    }),
    ctx,
  );
  assertEquals(onItem.expiresAt, onSub.expiresAt);
});

Deno.test('every Stripe status maps somewhere deliberate', () => {
  const cases: Array<[string, string, boolean]> = [
    ['active', 'active', true],
    ['trialing', 'active', true],
    // Stripe is still retrying and the subscription is still theirs. Cutting
    // access at the first failed renewal punishes an expired card harder than
    // either mobile store would.
    ['past_due', 'grace', true],
    // Where Stripe puts it once it has given up retrying.
    ['unpaid', 'on_hold', false],
    ['paused', 'paused', false],
    ['canceled', 'canceled', true],
    ['incomplete', 'pending', false],
    ['incomplete_expired', 'expired', false],
    ['something_new', 'pending', false],
  ];

  for (const [status, expected, entitles] of cases) {
    assertEquals(subscriptionStatus(status), expected, status);
    const p = normalizeSubscription(
      subscription({ status: status as never }),
      ctx,
    );
    assertEquals(
      purchaseEntitles(p, new Date('2026-08-17T00:00:00Z')),
      entitles,
      `${status} should ${entitles ? '' : 'not '}entitle`,
    );
  }
});

Deno.test('cancel_at_period_end keeps access but stops renewal', () => {
  const p = normalizeSubscription(
    subscription({ cancel_at_period_end: true }),
    ctx,
  );
  // Stripe still reports `active`, and it is: they have paid for the period.
  assertEquals(p.status, 'active');
  assertFalse(p.willRenew);
  assert(purchaseEntitles(p, new Date('2026-08-17T00:00:00Z')));
});

Deno.test('test mode is sandbox, live mode is not', () => {
  // Unlike Google, Stripe has a genuinely separate environment, and livemode is
  // how an object says which one it came from.
  assertEquals(normalizeSubscription(subscription(), ctx).environment, 'sandbox');
  assertEquals(
    normalizeSubscription(subscription({ livemode: true }), ctx).environment,
    'production',
  );
});

Deno.test('the account token is read from the customer when the object lacks it', () => {
  const p = normalizeSubscription(
    subscription({ metadata: {} }),
    { ...ctx, customerMetadata: { tollgate_account_token: ACCOUNT } },
  );
  // Most integrations put it on the customer, because it describes who they
  // are rather than what they bought.
  assertEquals(p.appAccountToken, ACCOUNT);
});

// --- one-off payments -------------------------------------------------------

function intent(over: Partial<StripePaymentIntent> = {}): StripePaymentIntent {
  return {
    id: 'pi_1ABC',
    object: 'payment_intent',
    status: 'succeeded',
    amount: 179,
    currency: 'gbp',
    customer: 'cus_1ABC',
    created: Math.floor(Date.parse('2026-08-17T09:00:00Z') / 1000),
    livemode: false,
    metadata: {
      tollgate_account_token: ACCOUNT,
      tollgate_product: 'gems_small',
    },
    ...over,
  };
}

Deno.test('a succeeded payment normalizes as active', () => {
  const p = normalizePaymentIntent(intent(), ctx);

  assertEquals(p.status, 'active');
  assertEquals(p.storeProductId, 'gems_small');
  // A one-off payment is its own original: nothing renews from it.
  assertEquals(p.originalTransactionId, 'pi_1ABC');
  assertEquals(p.storeTransactionId, 'pi_1ABC');
  assertEquals(p.expiresAt, null);
  assertFalse(p.willRenew);
  assertEquals(p.priceAmountMicros, 1_790_000);
});

Deno.test('a payment that has not settled grants nothing', () => {
  for (
    const status of [
      'requires_payment_method',
      'requires_action',
      'processing',
      'requires_confirmation',
    ] as const
  ) {
    const p = normalizePaymentIntent(intent({ status }), ctx);
    assertEquals(p.status, 'pending', status);
    assertFalse(purchaseEntitles(p, new Date(NOW)));
  }
  assertEquals(
    normalizePaymentIntent(intent({ status: 'canceled' }), ctx).status,
    'expired',
  );
});

// --- webhooks ---------------------------------------------------------------

function adapterWith(routes: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return Promise.resolve(respond());
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;

  return {
    calls,
    adapter: new StripeAdapter({
      secretKey: 'sk_test_123',
      webhookSecret: SECRET,
      fetch: fetchImpl,
      now: () => NOW,
    }),
  };
}

async function webhook(
  event: unknown,
  opts: { secret?: string; timestamp?: number } = {},
): Promise<Request> {
  const body = JSON.stringify(event);
  const t = opts.timestamp ?? Math.floor(NOW / 1000);
  const signature = await hmacSha256Hex(opts.secret ?? SECRET, `${t}.${body}`);
  return new Request('https://example.invalid/stripe', {
    method: 'POST',
    headers: {
      'stripe-signature': `t=${t},v1=${signature}`,
      'content-type': 'application/json',
    },
    body,
  });
}

Deno.test('a properly signed webhook is accepted', async () => {
  const { adapter } = adapterWith();
  const parsed = await adapter.parseNotification(
    await webhook({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1ABC' } },
    }),
  );

  assertEquals(parsed.storeEventId, 'evt_1');
  assertEquals(parsed.eventType, 'customer.subscription.updated');
  assertEquals(parsed.refs[0].originalTransactionId, 'sub_1ABC');
  assertEquals(parsed.refs[0].kind, 'subscription');
});

Deno.test('a webhook signed with the wrong secret is refused', async () => {
  const { adapter } = adapterWith();
  const req = await webhook(
    { id: 'evt_2', type: 'customer.subscription.updated', data: { object: {} } },
    { secret: 'whsec_not_it' },
  );
  const e = await assertRejects(() => adapter.parseNotification(req));
  assertEquals((e as TollgateError).code, 'bad_signature');
});

Deno.test('a replayed webhook is refused once it is old enough', async () => {
  const { adapter } = adapterWith();
  // Correctly signed, and captured an hour ago. Without a timestamp check a
  // signature is valid for ever and a replay is indistinguishable from a real
  // delivery.
  const req = await webhook(
    { id: 'evt_3', type: 'customer.subscription.updated', data: { object: {} } },
    { timestamp: Math.floor(NOW / 1000) - 3600 },
  );
  const e = await assertRejects(() => adapter.parseNotification(req));
  assertEquals((e as TollgateError).code, 'bad_signature');
});

Deno.test('a tampered body is refused', async () => {
  const { adapter } = adapterWith();
  const good = await webhook({
    id: 'evt_4',
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_1ABC' } },
  });
  // Same signature header, different body.
  const tampered = new Request(good.url, {
    method: 'POST',
    headers: good.headers,
    body: JSON.stringify({
      id: 'evt_4',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_SOMEBODY_ELSE' } },
    }),
  });
  const e = await assertRejects(() => adapter.parseNotification(tampered));
  assertEquals((e as TollgateError).code, 'bad_signature');
});

Deno.test('a refund is reported as revoked, not as a refresh', async () => {
  const { adapter } = adapterWith();
  // A refunded payment intent still reports `succeeded`; the refund lives on
  // the charge. So re-reading would never reveal it, and the event is the only
  // place the fact is stated.
  const parsed = await adapter.parseNotification(
    await webhook({
      id: 'evt_5',
      type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_1ABC', refunded: true } },
    }),
  );

  assertEquals(parsed.refs.length, 0);
  assertEquals(parsed.revoked?.length, 1);
  assertEquals(parsed.revoked?.[0].originalTransactionId, 'pi_1ABC');
});

Deno.test('a dispute is treated the same as a refund', async () => {
  const { adapter } = adapterWith();
  const parsed = await adapter.parseNotification(
    await webhook({
      id: 'evt_6',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: 'pi_1ABC' } },
    }),
  );
  assertEquals(parsed.revoked?.[0].originalTransactionId, 'pi_1ABC');
});

Deno.test('an event about nothing purchasable is recorded and ignored', async () => {
  const { adapter } = adapterWith();
  const parsed = await adapter.parseNotification(
    await webhook({
      id: 'evt_7',
      type: 'price.updated',
      data: { object: { id: 'price_premium' } },
    }),
  );
  assertEquals(parsed.eventType, 'price.updated');
  assertEquals(parsed.refs.length, 0);
  assertEquals(parsed.revoked?.length ?? 0, 0);
});

Deno.test('webhooks are refused outright without a signing secret', async () => {
  const adapter = new StripeAdapter({ secretKey: 'sk_test_123', now: () => NOW });
  const req = await webhook({ id: 'evt_8', type: 'x', data: { object: {} } });
  // Failing closed. An adapter that accepted unsigned webhooks because nobody
  // configured the check would be a public write endpoint.
  const e = await assertRejects(() => adapter.parseNotification(req));
  assertEquals((e as TollgateError).code, 'invalid_request');
});

// --- reading ----------------------------------------------------------------

Deno.test('the id decides which endpoint answers', async () => {
  const { adapter, calls } = adapterWith({
    '/subscriptions/': () => new Response(JSON.stringify(subscription())),
    '/customers/': () => new Response(JSON.stringify({ id: 'cus_1ABC' })),
  });

  const p = await adapter.refresh({
    store: 'stripe',
    originalTransactionId: 'sub_1ABC',
  });
  assertEquals(p?.storeProductId, 'price_premium');
  // Stripe ids carry their own type, so unlike Google no caller has to say what
  // kind of thing it is asking about.
  assert(calls.some((c) => c.includes('/subscriptions/sub_1ABC')));
});

Deno.test('an id of no recognisable kind is refused rather than guessed at', async () => {
  const { adapter } = adapterWith();
  const e = await assertRejects(() =>
    adapter.refresh({ store: 'stripe', originalTransactionId: 'cus_1ABC' })
  );
  assertEquals((e as TollgateError).code, 'invalid_request');
});

Deno.test('a purchase belonging to somebody else is refused', async () => {
  const { adapter } = adapterWith({
    '/subscriptions/': () => new Response(JSON.stringify(subscription())),
    '/customers/': () => new Response(JSON.stringify({ id: 'cus_1ABC' })),
  });

  const e = await assertRejects(() =>
    adapter.verify({
      token: 'sub_1ABC',
      userId: 'u',
      appAccountToken: '99999999-9999-4999-8999-999999999999',
    })
  );
  assertEquals((e as TollgateError).code, 'not_yours');
});

Deno.test('a publishable key is refused at construction', () => {
  let code: string | null = null;
  try {
    new StripeAdapter({ secretKey: 'pk_test_123' });
  } catch (e) {
    code = (e as TollgateError).code;
  }
  // The API errors a publishable key produces would never say "you have put
  // your secret in the wrong place", which is what this almost always means.
  assertEquals(code, 'invalid_request');
});
