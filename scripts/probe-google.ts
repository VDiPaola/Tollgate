/**
 * Check that Google Play credentials work, before trusting any of the rest.
 *
 *   deno task probe:google
 *
 * Reads `.env` and reports, in order, the things that go wrong in practice:
 * a key that cannot be decoded, an API that was never enabled, Play Console
 * grants that have not propagated, and a purchase token that does not resolve.
 *
 * Output is written to be safe to paste into a bug report or a chat. Nothing
 * secret is printed: keys never are, the service account address is partly
 * masked, and a purchase token is shown only as a short prefix.
 */

import {
  GoogleAdapter,
  GoogleAuth,
  parseServiceAccount,
  type NormalizedPurchase,
  type ProductKind,
  TollgateError,
} from '@tollgate/core';

const OK = '  ok  ';
const NO = ' fail ';
const SKIP = ' skip ';

let failures = 0;

function pass(what: string, detail?: string) {
  console.log(`[${OK}] ${what}${detail ? `: ${detail}` : ''}`);
}

function fail(what: string, why: string) {
  failures += 1;
  console.log(`[${NO}] ${what}`);
  for (const line of wrap(why)) console.log(`         ${line}`);
}

function skip(what: string, why: string) {
  console.log(`[${SKIP}] ${what}: ${why}`);
}

function wrap(text: string, width = 68): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      lines.push(line.trim());
      line = word;
    } else {
      line += ` ${word}`;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

/** `service-account@project.iam.gserviceaccount.com` without the middle. */
function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return '***';
  const head = name.slice(0, 3);
  return `${head}${'*'.repeat(Math.max(3, name.length - 3))}@${domain}`;
}

function maskToken(token: string): string {
  return `${token.slice(0, 8)}… (${token.length} chars)`;
}

function required(name: string): string | null {
  const value = Deno.env.get(name);
  if (!value) {
    fail(name, `Not set. See docs/google-setup.md.`);
    return null;
  }
  return value;
}

console.log('\nTollgate: Google Play credential probe\n');

// --- 1. Configuration is present --------------------------------------------

const packageName = required('GOOGLE_PLAY_PACKAGE_NAME');
const rawKey = required('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64');

if (!packageName || !rawKey) {
  console.log('\nNothing further can be checked without those.\n');
  Deno.exit(1);
}
pass('GOOGLE_PLAY_PACKAGE_NAME', packageName);

// --- 2. The key parses ------------------------------------------------------

let account;
try {
  account = parseServiceAccount(rawKey);
  pass('service account key', maskEmail(account.client_email));
} catch (e) {
  fail(
    'service account key',
    e instanceof Error ? e.message : String(e),
  );
  console.log('\nNothing further can be checked without a readable key.\n');
  Deno.exit(1);
}

// --- 3. Google accepts it ---------------------------------------------------

// This is the step that fails for a day or two after the Play Console grants
// are made, and the failure looks identical to a broken key.
try {
  const auth = new GoogleAuth(account);
  await auth.accessToken();
  pass('access token', 'Google accepted the service account assertion');
} catch (e) {
  fail('access token', e instanceof Error ? e.message : String(e));
  console.log(
    '\nUntil this passes nothing else will. Check that the Google Play\n' +
      'Android Developer API is enabled on the Cloud project, and that the\n' +
      'service account has been invited in Play Console.\n',
  );
  Deno.exit(1);
}

// --- 4. The Play API answers for this app -----------------------------------

const adapter = new GoogleAdapter({
  packageName,
  serviceAccount: account,
  pubsubAudience: Deno.env.get('GOOGLE_PUBSUB_AUDIENCE'),
  pubsubServiceAccountEmail: Deno.env.get('GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL'),
});

const purchaseToken = Deno.env.get('GOOGLE_TEST_PURCHASE_TOKEN');
const productId = Deno.env.get('GOOGLE_TEST_PRODUCT_ID');
const basePlanId = Deno.env.get('GOOGLE_TEST_BASE_PLAN_ID');

if (!purchaseToken) {
  skip(
    'purchase lookup',
    'GOOGLE_TEST_PURCHASE_TOKEN is not set. Make a licence-tester purchase ' +
      'on a device and paste its token in to check this half.',
  );
} else {
  // Subscriptions can be looked up by token alone; one-time products need
  // their SKU, so which endpoint to try is decided by what was supplied.
  const kind: ProductKind | undefined = productId && !basePlanId
    ? 'non_consumable'
    : 'subscription';

  try {
    const purchase = await adapter.refresh({
      store: 'google',
      originalTransactionId: purchaseToken,
      storeProductId: productId,
      basePlanId,
      kind,
    });

    if (!purchase) {
      fail(
        'purchase lookup',
        `Play has no record of ${maskToken(purchaseToken)}. A consumed ` +
          'one-time purchase or a long-expired subscription reads this way.',
      );
    } else {
      pass('purchase lookup', maskToken(purchaseToken));
      report(purchase);
    }
  } catch (e) {
    fail(
      'purchase lookup',
      e instanceof TollgateError ? e.message : String(e),
    );
  }
}

// --- 5. Notification settings are present -----------------------------------

if (!Deno.env.get('GOOGLE_PUBSUB_AUDIENCE')) {
  skip(
    'notification settings',
    'GOOGLE_PUBSUB_AUDIENCE is not set, so notifications would be refused.',
  );
} else if (!Deno.env.get('GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL')) {
  skip(
    'notification settings',
    'GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL is not set. Pushes will be checked ' +
      'for a Google signature and the right audience, but not for which ' +
      'account minted them.',
  );
} else {
  pass('notification settings', 'audience and push account both configured');
}

/** What Tollgate made of the purchase, in the terms it will store it. */
function report(p: NormalizedPurchase) {
  const rows: Array<[string, string]> = [
    ['product', `${p.storeProductId}${p.basePlanId ? ` / ${p.basePlanId}` : ''}`],
    ['kind', p.kind],
    ['status', p.status],
    ['environment', p.environment],
    ['purchased', p.purchasedAt],
    ['expires', p.expiresAt ?? 'never'],
    ['renews', String(p.willRenew)],
    ['account token', p.appAccountToken ?? 'NONE'],
  ];
  console.log('');
  for (const [label, value] of rows) {
    console.log(`         ${label.padEnd(14)} ${value}`);
  }
  console.log('');

  if (p.environment === 'sandbox') {
    console.log(
      '         This is a test purchase. It grants nothing unless\n' +
        "         tollgate.config.sandbox is 'allow' on this stack.\n",
    );
  }
  if (!p.appAccountToken) {
    console.log(
      '         No account token is attached, so a notification about this\n' +
        '         purchase could not be traced back to a user. The app must\n' +
        '         set it at purchase time via setObfuscatedAccountId.\n',
    );
  }
}

console.log(
  failures === 0
    ? '\nAll checks passed.\n'
    : `\n${failures} check${failures === 1 ? '' : 's'} failed.\n`,
);
Deno.exit(failures === 0 ? 0 : 1);
