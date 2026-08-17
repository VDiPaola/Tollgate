/**
 * Cancel or revoke a Google Play subscription, so a purchase flow can be tested
 * more than once.
 *
 *   deno task revoke:google <purchaseToken>          # immediate, refunds
 *   deno task revoke:google <purchaseToken> --cancel # at period end
 *
 * A development tool. Play only lets an account own a subscription once, so
 * after the first test purchase the buy button reports the item as already
 * owned and there is no way through the flow again from inside the app. An app
 * must never offer this to a real customer: cancelling is the store's own
 * screen, reached through a deep link.
 *
 * `revoke` terminates immediately and refunds, which is what a test loop wants.
 * `--cancel` stops the renewal and leaves the paid period running, which is
 * what a real cancellation does and is worth exercising at least once, since
 * "cancelled but still entitled" is the state most billing code gets wrong.
 *
 * The purchase token is the `original_transaction_id` on the row in
 * `tollgate.purchases`, and the bench prints it too.
 */

import { GoogleAuth, parseServiceAccount } from '@tollgate/core';

import { loadEnv } from './env.ts';

const args = Deno.args.filter((a) => !a.startsWith('--'));
const cancelOnly = Deno.args.includes('--cancel');
const [token] = args;

if (!token) {
  console.error(
    'Usage: deno task revoke:google <purchaseToken> [--cancel]\n\n' +
      'The token is original_transaction_id in tollgate.purchases:\n' +
      "  select original_transaction_id, store_product_id, status\n" +
      "  from tollgate.purchases where kind = 'subscription'\n" +
      '  order by created_at desc limit 5;',
  );
  Deno.exit(1);
}

const env = await loadEnv('.env');
const packageName = env.values.get('GOOGLE_PLAY_PACKAGE_NAME');
const key = env.values.get('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64');

if (!packageName || !key) {
  console.error(
    'GOOGLE_PLAY_PACKAGE_NAME and GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 must be ' +
      'set in .env. See docs/google-setup.md.',
  );
  Deno.exit(1);
}

const auth = new GoogleAuth(parseServiceAccount(key));
const accessToken = await auth.accessToken();

const action = cancelOnly ? 'cancel' : 'revoke';
const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/` +
  `applications/${encodeURIComponent(packageName)}` +
  `/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}:${action}`;

const res = await fetch(url, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  },
  // revoke wants to be told what to do about the money. A full refund is the
  // only sensible thing for a test purchase, and it is what makes the
  // subscription buyable again straight away.
  body: cancelOnly ? '{}' : JSON.stringify({
    revocationContext: { fullRefund: {} },
  }),
});

if (!res.ok) {
  const detail = (await res.text().catch(() => '')).slice(0, 400);
  console.error(`Google refused the ${action} (${res.status}).\n${detail}`);
  // A 400 naming the subscription state usually means it is already gone, in
  // which case the flow is buyable again and there is nothing to do.
  Deno.exit(1);
}

console.log(
  cancelOnly
    ? 'Cancelled. It stays entitled until the period ends, which under ' +
      'licence testing is minutes.'
    : 'Revoked and refunded. The subscription can be bought again now.',
);
console.log(
  '\nTollgate will not know until it hears about it. Either wait for the ' +
    'store notification, or press Restore in the app, which re-reads ' +
    'everything from Google.',
);
