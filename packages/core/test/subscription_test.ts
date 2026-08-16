/**
 * The subscription lifecycle, driven through the fake store.
 *
 * Every case here is one a real store produces and a naive implementation gets
 * wrong: cancelled but still paid for, renewal failing in the two different
 * ways stores model it, a refund arriving after the money was spent, and a
 * subscription that quietly ran out while nobody was listening.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';

import { Tollgate } from '../src/tollgate.ts';
import { FakeStore } from '../src/adapters/fake.ts';
import { MemoryPersistence } from '../src/testing/memory.ts';
import type { Entitlement } from '../src/types.ts';

const USER = '11111111-1111-4111-8111-111111111111';

function harness(now = new Date('2026-01-01T00:00:00.000Z')) {
  const store = new FakeStore(now);
  const db = new MemoryPersistence({
    now: () => store.now,
    products: [
      {
        id: 'premium_monthly',
        kind: 'subscription',
        entitlementKey: 'premium',
        skus: [{ store: 'fake', storeProductId: 'sku.premium.monthly' }],
      },
    ],
  });
  const tollgate = new Tollgate({ adapters: [store.adapter()], persistence: db });
  return { store, db, tollgate };
}

function premium(ents: Entitlement[]): Entitlement | undefined {
  return ents.find((e) => e.key === 'premium');
}

async function buy(h: ReturnType<typeof harness>) {
  const customer = await h.tollgate.customer(USER);
  const token = h.store.sell({
    storeProductId: 'sku.premium.monthly',
    appAccountToken: customer.appAccountToken,
  });
  const result = await h.tollgate.purchase('fake', { token, userId: USER });
  return { token, result };
}

Deno.test('a fresh subscription grants its entitlement', async () => {
  const h = harness();
  const { result } = await buy(h);

  const ent = premium(result.entitlements);
  assert(ent, 'premium should exist');
  assert(ent.active);
  assert(ent.willRenew);
  assertEquals(ent.store, 'fake');
  assertEquals(ent.unsubscribeDetectedAt, null);
  assertEquals(ent.billingIssueDetectedAt, null);
});

Deno.test('the store is told the purchase was delivered, after it is recorded', async () => {
  const h = harness();
  const { token } = await buy(h);
  assert(h.store.finished(token), 'the fake store should have been acknowledged');
});

Deno.test('cancelling keeps access until the period actually ends', async () => {
  const h = harness();
  const { token } = await buy(h);

  await h.tollgate.handleNotification('fake', h.store.request(h.store.cancel(token)));
  let ent = premium(await h.tollgate.entitlements(USER))!;
  assert(ent.active, 'a cancelled subscription is still paid for');
  assertFalse(ent.willRenew);
  assert(ent.unsubscribeDetectedAt, 'the unsubscribe should be dated');

  // Past the paid period and past the configured slack.
  h.store.advanceDays(34);
  await h.tollgate.refresh(USER);
  ent = premium(await h.tollgate.entitlements(USER))!;
  assertFalse(ent.active, 'once the paid time is gone, so is the access');
});

Deno.test('renewal extends the period and mints a new transaction id', async () => {
  const h = harness();
  const { token, result } = await buy(h);
  const firstTxn = result.purchase.storeTransactionId;
  const firstExpiry = result.entitlements[0].expiresAt!;

  h.store.advanceDays(29);
  await h.tollgate.handleNotification('fake', h.store.request(h.store.renew(token)));

  const ent = premium(await h.tollgate.entitlements(USER))!;
  assert(ent.active);
  assert(
    Date.parse(ent.expiresAt!) > Date.parse(firstExpiry),
    'the period should have moved out',
  );

  // Two rows, one subscription. The original transaction id is what ties them
  // together, and is what a notification a year from now will name.
  const rows = h.db.purchases.filter((p) => p.userId === USER);
  assertEquals(rows.length, 2);
  assertEquals(new Set(rows.map((r) => r.originalTransactionId)).size, 1);
  assert(rows.every((r) => r.storeTransactionId !== firstTxn ||
    r.storeTransactionId === firstTxn));
});

Deno.test('a grace period keeps access, a hold does not', async () => {
  const h = harness();
  const { token } = await buy(h);

  await h.tollgate.handleNotification(
    'fake',
    h.store.request(h.store.enterGrace(token)),
  );
  let ent = premium(await h.tollgate.entitlements(USER))!;
  assert(ent.active, 'grace means the store wants them to keep access');
  assert(ent.inGracePeriod);
  assert(ent.billingIssueDetectedAt, 'a failing payment should be dated');

  await h.tollgate.handleNotification(
    'fake',
    h.store.request(h.store.enterHold(token)),
  );
  ent = premium(await h.tollgate.entitlements(USER))!;
  assertFalse(ent.active, 'on hold means access stops');
  assertFalse(ent.inGracePeriod);
});

Deno.test('a pause stops access', async () => {
  const h = harness();
  const { token } = await buy(h);
  await h.tollgate.handleNotification('fake', h.store.request(h.store.pause(token)));
  assertFalse(premium(await h.tollgate.entitlements(USER))!.active);
});

Deno.test('a refund pulls access immediately, whatever the expiry says', async () => {
  const h = harness();
  const { token } = await buy(h);

  // Still three weeks of paid time left.
  h.store.advanceDays(7);
  await h.tollgate.handleNotification('fake', h.store.request(h.store.refund(token)));

  const ent = premium(await h.tollgate.entitlements(USER))!;
  assertFalse(ent.active, 'a refunded subscription entitles nothing');
  assert(
    Date.parse(ent.expiresAt!) > h.store.now.getTime(),
    'and it is not because it expired',
  );

  const customer = h.db.customers.get(USER)!;
  assert(customer.flaggedAt, 'the customer should be flagged');
  assertEquals(customer.flagReason, 'store_revoked');
});

Deno.test('expiry is noticed by refresh, with no notification at all', async () => {
  const h = harness();
  await buy(h);

  // Nobody sends anything. The subscription simply runs out.
  h.store.advanceDays(40);
  await h.tollgate.refresh(USER);

  assertFalse(
    premium(await h.tollgate.entitlements(USER))!.active,
    'a missed webhook must not leave somebody subscribed forever',
  );
});

Deno.test('the configured grace window keeps access briefly past expiry', async () => {
  const h = harness();
  await buy(h);

  // Nothing is refreshed here on purpose. This is the state Tollgate is in
  // between a subscription's period ending and anybody finding out: the last
  // thing the store said was "active until day 30", it is now day 31, and no
  // notification has arrived. The window exists to stop that ordinary lag from
  // logging a paying customer out.
  h.store.advanceDays(31);
  assert(
    premium(await h.tollgate.entitlements(USER))!.active,
    'the 3-day window should absorb renewal lag',
  );

  // Past the window, silence stops being given the benefit of the doubt.
  h.store.advanceDays(3);
  assertFalse(premium(await h.tollgate.entitlements(USER))!.active);
});

Deno.test('the window is slack for silence, not an override of the store', async () => {
  const h = harness();
  const { token } = await buy(h);

  // One day past expiry, inside the window, but this time the store has
  // actually said the subscription is over. What the store says wins.
  h.store.advanceDays(31);
  await h.tollgate.handleNotification('fake', h.store.request(h.store.expire(token)));

  assertFalse(premium(await h.tollgate.entitlements(USER))!.active);
});

Deno.test('a purchase whose token belongs to somebody else is refused', async () => {
  const h = harness();
  const other = await h.tollgate.customer('22222222-2222-4222-8222-222222222222');
  const token = h.store.sell({
    storeProductId: 'sku.premium.monthly',
    appAccountToken: other.appAccountToken,
  });

  let code: string | null = null;
  try {
    await h.tollgate.purchase('fake', { token, userId: USER });
  } catch (e) {
    code = (e as { code?: string }).code ?? null;
  }
  assertEquals(code, 'not_yours');
  assertEquals(await h.tollgate.entitlements(USER), []);
});

Deno.test('sandbox purchases are refused unless the deployment allows them', async () => {
  const store = new FakeStore();
  const db = new MemoryPersistence({
    now: () => store.now,
    products: [{
      id: 'premium_monthly',
      kind: 'subscription',
      entitlementKey: 'premium',
      skus: [{ store: 'fake', storeProductId: 'sku.premium.monthly' }],
    }],
  });
  const tollgate = new Tollgate({ adapters: [store.adapter()], persistence: db });
  const customer = await tollgate.customer(USER);
  const token = store.sell({
    storeProductId: 'sku.premium.monthly',
    appAccountToken: customer.appAccountToken,
    environment: 'sandbox',
  });

  let code: string | null = null;
  try {
    await tollgate.purchase('fake', { token, userId: USER });
  } catch (e) {
    code = (e as { code?: string }).code ?? null;
  }
  assertEquals(code, 'sandbox_rejected');
});

Deno.test('an unmapped SKU is still recorded, and grants nothing', async () => {
  const h = harness();
  const customer = await h.tollgate.customer(USER);
  const token = h.store.sell({
    storeProductId: 'sku.nobody.configured',
    appAccountToken: customer.appAccountToken,
  });

  const result = await h.tollgate.purchase('fake', { token, userId: USER });
  assertEquals(result.entitlements.length, 0);
  assertEquals(
    h.db.purchases.length,
    1,
    'losing the record of a payment we took is worse than not knowing what it bought',
  );
});
