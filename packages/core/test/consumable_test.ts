/**
 * Consumables, which is where money actually goes missing.
 *
 * A subscription that double-grants costs nothing, because the second grant
 * writes the same entitlement row. A consumable that double-grants hands out
 * free goods, and one that fails to grant takes money for nothing. Both are
 * one crash or one store redelivery away, so exactly-once is the property
 * these tests exist to pin down.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';

import { Tollgate } from '../src/tollgate.ts';
import { FakeStore } from '../src/adapters/fake.ts';
import { MemoryPersistence } from '../src/testing/memory.ts';

const USER = '11111111-1111-4111-8111-111111111111';

interface Ledger {
  balance: number;
  entries: Array<{ purchaseId: string; delta: number }>;
}

function harness(clawback: 'revoke' | 'keep' = 'revoke') {
  const store = new FakeStore();
  const ledger: Ledger = { balance: 0, entries: [] };

  const db = new MemoryPersistence({
    now: () => store.now,
    config: { clawback },
    products: [{
      id: 'gems_medium',
      kind: 'consumable',
      grantPayload: { gems: 500 },
      skus: [{ store: 'fake', storeProductId: 'sku.gems.medium' }],
    }],
    // Stands in for the SQL function a host app names in tollgate.config.
    grantHook: ({ payload, purchaseId }) => {
      const gems = (payload as { gems: number }).gems;
      ledger.balance += gems;
      ledger.entries.push({ purchaseId, delta: gems });
      return { balance: ledger.balance };
    },
    revokeHook: ({ payload, purchaseId, clawback: policy }) => {
      if (policy === 'keep') return { balance: ledger.balance, kept: true };
      const gems = (payload as { gems: number }).gems;
      ledger.balance -= gems;
      ledger.entries.push({ purchaseId, delta: -gems });
      return { balance: ledger.balance };
    },
  });

  const tollgate = new Tollgate({ adapters: [store.adapter()], persistence: db });
  return { store, db, tollgate, ledger };
}

async function buyGems(h: ReturnType<typeof harness>) {
  const customer = await h.tollgate.customer(USER);
  const token = h.store.sell({
    storeProductId: 'sku.gems.medium',
    kind: 'consumable',
    appAccountToken: customer.appAccountToken,
  });
  const result = await h.tollgate.purchase('fake', { token, userId: USER });
  return { token, result };
}

Deno.test('buying a consumable runs the grant hook once and delivers', async () => {
  const h = harness();
  const { result } = await buyGems(h);

  assert(result.granted);
  assertEquals(h.ledger.balance, 500);
  assertEquals((result.grantResult as { balance: number }).balance, 500);
  assertEquals(result.entitlements.length, 0, 'a gem pack unlocks nothing');
});

Deno.test('verifying the same purchase twice pays out once', async () => {
  const h = harness();
  const { token } = await buyGems(h);

  // A client that lost the response and retried, which is the ordinary case.
  const again = await h.tollgate.purchase('fake', { token, userId: USER });

  assertFalse(again.granted, 'the second call must not deliver again');
  assertEquals(h.ledger.balance, 500);
  assertEquals(h.ledger.entries.length, 1);
});

Deno.test('a redelivered store notification pays out nothing', async () => {
  const h = harness();
  const { token } = await buyGems(h);

  const note = { eventId: 'evt_dupe', type: 'PURCHASED', originalTransactionId: token };
  const first = await h.tollgate.handleNotification('fake', h.store.request(note));
  const second = await h.tollgate.handleNotification('fake', h.store.request(note));

  assert(first.handled);
  assertFalse(second.handled, 'the event id should have been recognised');
  assertEquals(h.ledger.balance, 500);
});

Deno.test('a notification arriving before the client verifies still finds the user', async () => {
  const h = harness();
  // The customer exists, so the token has been minted, but nothing has been
  // bought through Tollgate yet and no alias is stored.
  const customer = await h.tollgate.customer(USER);
  const token = h.store.sell({
    storeProductId: 'sku.gems.medium',
    kind: 'consumable',
    appAccountToken: customer.appAccountToken,
  });

  const result = await h.tollgate.handleNotification(
    'fake',
    h.store.request({
      eventId: 'evt_early',
      type: 'PURCHASED',
      originalTransactionId: token,
    }),
  );

  assertEquals(result.outcomes[0].action, 'recorded');
  assertEquals(result.outcomes[0].userId, USER);
  assertEquals(h.ledger.balance, 500, 'the app account token is what saved this');

  // And the client's own call, landing second, delivers nothing extra.
  const late = await h.tollgate.purchase('fake', { token, userId: USER });
  assertFalse(late.granted);
  assertEquals(h.ledger.balance, 500);
});

Deno.test('a purchase nobody can be matched to is recorded, not retried forever', async () => {
  const h = harness();
  // No appAccountToken at all: an app that did not attach one.
  const token = h.store.sell({
    storeProductId: 'sku.gems.medium',
    kind: 'consumable',
  });

  const result = await h.tollgate.handleNotification(
    'fake',
    h.store.request({
      eventId: 'evt_orphan',
      type: 'PURCHASED',
      originalTransactionId: token,
    }),
  );

  assertEquals(result.outcomes[0].action, 'unmapped_user');
  assert(result.handled, 'answering "handled" is what stops the redelivery loop');
  assertEquals(h.ledger.balance, 0);
});

Deno.test('a refund claws the gems back, into the negative if it has to', async () => {
  const h = harness('revoke');
  const { token } = await buyGems(h);
  assertEquals(h.ledger.balance, 500);

  // Spent before the refund landed, which is the whole problem.
  h.ledger.balance -= 400;

  await h.tollgate.handleNotification('fake', h.store.request(h.store.refund(token)));

  assertEquals(h.ledger.balance, -400, 'the debt is real and is recorded as such');
  const customer = h.db.customers.get(USER)!;
  assert(customer.flaggedAt);
  assertEquals(customer.flags.length, 1);
});

Deno.test('the keep policy reports the refund and leaves the balance alone', async () => {
  const h = harness('keep');
  const { token } = await buyGems(h);
  h.ledger.balance -= 400;

  await h.tollgate.handleNotification('fake', h.store.request(h.store.refund(token)));

  assertEquals(h.ledger.balance, 100, 'absorbed, not clawed back');
  assert(
    h.db.customers.get(USER)!.flaggedAt,
    'the customer is flagged either way, which is the point of flagging',
  );
});

Deno.test('a consumable is not delivered until the payment settles', async () => {
  const h = harness();
  const customer = await h.tollgate.customer(USER);
  const token = h.store.sell({
    storeProductId: 'sku.gems.medium',
    kind: 'consumable',
    appAccountToken: customer.appAccountToken,
  });
  // Deferred payment: Google's pending purchases sit like this for days.
  await h.tollgate.handleNotification(
    'fake',
    h.store.request(h.store.enterHold(token)),
  );
  assertEquals(h.ledger.balance, 0, 'nothing is owed until the money arrives');

  await h.tollgate.handleNotification('fake', h.store.request(h.store.renew(token)));
  assertEquals(h.ledger.balance, 500);
});

Deno.test('a failure to acknowledge does not fail the purchase', async () => {
  const h = harness();
  const customer = await h.tollgate.customer(USER);
  const token = h.store.sell({
    storeProductId: 'sku.gems.medium',
    kind: 'consumable',
    appAccountToken: customer.appAccountToken,
  });

  // verify() succeeds, then the acknowledge call fails.
  const original = h.store.adapter();
  const flaky = {
    ...original,
    store: 'fake' as const,
    verify: original.verify.bind(original),
    refresh: original.refresh.bind(original),
    parseNotification: original.parseNotification.bind(original),
    finish: () => Promise.reject(new Error('network went away')),
  };
  const tollgate = new Tollgate({ adapters: [flaky], persistence: h.db });

  const result = await tollgate.purchase('fake', { token, userId: USER });
  assert(result.granted, 'the customer paid and must get their goods');
  assertEquals(h.ledger.balance, 500);
  assert(result.finishWarning, 'but the risk of a store-side auto-refund is reported');
});
