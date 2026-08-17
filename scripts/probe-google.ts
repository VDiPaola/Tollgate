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

import { loadEnv } from './env.ts';

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

console.log('\nTollgate: Google Play credential probe\n');

const env = await loadEnv('.env');
for (const problem of env.problems) {
  console.log(
    `[${SKIP}] .env line ${problem.line} ignored: ${problem.reason}`,
  );
}

function get(name: string): string | undefined {
  return env.values.get(name) || undefined;
}

function required(name: string): string | null {
  const value = get(name);
  if (!value) {
    fail(name, `Not set. See docs/google-setup.md.`);
    return null;
  }
  return value;
}

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

// --- 3. Google accepts the assertion ----------------------------------------

// This proves the key is genuine and the Google Play Android Developer API is
// enabled. It does NOT prove the Play Console grants have taken effect: the
// token exchange is a Cloud operation and knows nothing about Play. That is
// what step 4 is for.
const auth = new GoogleAuth(account);
try {
  await auth.accessToken();
  pass('access token', 'Google accepted the service account assertion');
} catch (e) {
  fail('access token', e instanceof Error ? e.message : String(e));
  console.log(
    '\nUntil this passes nothing else will. Check that the Google Play\n' +
      'Android Developer API is enabled on the Cloud project.\n',
  );
  Deno.exit(1);
}

// --- 4. Play Console grants have propagated ---------------------------------

/**
 * List the app's catalogue.
 *
 * This is the check that actually exercises the Play Console permissions, and
 * it is the one that fails for a day or two after they are granted. It also
 * prints the product and base plan ids, which are exactly what has to go into
 * `tollgate.store_products` and are otherwise transcribed by hand from the
 * Console.
 */
async function playGet<T>(path: string): Promise<T> {
  const token = await auth.accessToken();
  const res = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(packageName!)}${path}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`${res.status} ${detail}`);
  }
  return await res.json() as T;
}

interface SubscriptionListing {
  productId?: string;
  basePlans?: Array<{ basePlanId?: string; state?: string }>;
}

let catalogueReadable = false;
try {
  const subs = await playGet<{ subscriptions?: SubscriptionListing[] }>(
    '/subscriptions?pageSize=50',
  );
  catalogueReadable = true;
  const list = subs.subscriptions ?? [];
  pass(
    'Play Console permissions',
    `the catalogue is readable, ${list.length} subscription${
      list.length === 1 ? '' : 's'
    }`,
  );

  if (list.length === 0) {
    console.log(
      '\n         No subscriptions exist yet. They are created under\n' +
        '         Monetise with Play, and need a build on a track first.\n',
    );
  } else {
    console.log('\n         Subscriptions, as tollgate.store_products rows:\n');
    for (const s of list) {
      for (const plan of s.basePlans ?? [{}]) {
        const state = plan.state ? ` -- ${plan.state}` : '';
        console.log(
          `           ('google', '${s.productId}', ` +
            `${plan.basePlanId ? `'${plan.basePlanId}'` : 'null'}, ` +
            `'<your product id>')${state}`,
        );
      }
    }
    console.log('');
  }
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  fail('Play Console permissions', message);
  // Two different 403s wear the same status code and mean opposite things, so
  // the body has to be read rather than the code. Telling somebody to wait a
  // day for permissions when the real answer is one checkbox in Cloud console
  // costs them the day.
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
    console.log(
      '         The Google Play Android Developer API is not enabled on the\n' +
        '         Cloud project. Enable it there, wait a minute or two for it\n' +
        '         to take, and run this again. This is not a permissions\n' +
        '         problem and waiting will not fix it.\n',
    );
  } else {
    console.log(
      '         The API is enabled and the key works, so this is the Play\n' +
        '         Console grants. Check that the service account was invited\n' +
        '         with "View financial data" and "Manage orders and\n' +
        '         subscriptions" on this app. New grants commonly take a day\n' +
        '         or two to propagate.\n',
    );
  }
}

if (catalogueReadable) {
  // Two catalogue APIs exist for one-time products. `monetization.onetimeproducts`
  // is the current one and the only one an app migrated to the one-time product
  // model will answer from; `inappproducts` is the older one, which returns
  // "Please migrate to the new publishing API" once that migration has happened.
  // Try the new one, fall back to the old, so this works either way.
  const oneTime = await listOneTimeProducts();
  if ('error' in oneTime) {
    fail('one-time products', oneTime.error);
  } else if (oneTime.products.length === 0) {
    pass('one-time products', 'none defined yet');
  } else {
    pass(
      'one-time products',
      `${oneTime.products.length} defined via ${oneTime.via}`,
    );
    console.log('\n         One-time products, as tollgate.store_products rows:\n');
    for (const p of oneTime.products) {
      const options = p.purchaseOptions?.length
        ? `  -- purchase options: ${p.purchaseOptions.join(', ')}`
        : '';
      console.log(
        `           ('google', '${p.productId}', null, '<your product id>')${options}`,
      );
    }
    console.log('');
  }
}

interface OneTimeProduct {
  productId: string;
  purchaseOptions?: string[];
}

type CatalogueResult =
  | { products: OneTimeProduct[]; via: string }
  | { error: string };

/**
 * List one-time products, from whichever catalogue API this app answers.
 *
 * `monetization.oneTimeProducts` is the current one. `inappproducts` is the
 * older model, and an app migrated to one-time products refuses it outright
 * with "Please migrate to the new publishing API", so both have to be tried.
 *
 * Both failures are reported rather than swallowed. An earlier version hid
 * them, which turned a wrong URL into "neither catalogue API answered" and gave
 * nobody anything to act on.
 */
async function listOneTimeProducts(): Promise<CatalogueResult> {
  const problems: string[] = [];

  try {
    const body = await playGet<{
      oneTimeProducts?: Array<{
        productId?: string;
        purchaseOptions?: Array<{ purchaseOptionId?: string }>;
      }>;
    }>('/oneTimeProducts?pageSize=50');

    return {
      via: 'monetization.oneTimeProducts',
      products: (body.oneTimeProducts ?? [])
        .filter((p) => !!p.productId)
        .map((p) => ({
          productId: p.productId!,
          purchaseOptions: (p.purchaseOptions ?? [])
            .map((o) => o.purchaseOptionId)
            .filter((id): id is string => !!id),
        })),
    };
  } catch (e) {
    problems.push(`oneTimeProducts: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const body = await playGet<{ inappproduct?: Array<{ sku?: string }> }>(
      '/inappproducts',
    );
    return {
      via: 'inappproducts (legacy)',
      products: (body.inappproduct ?? [])
        .filter((p) => !!p.sku)
        .map((p) => ({ productId: p.sku! })),
    };
  } catch (e) {
    problems.push(`inappproducts: ${e instanceof Error ? e.message : e}`);
  }

  return { error: problems.join(' | ') };
}

// --- 5. A real purchase resolves --------------------------------------------

const adapter = new GoogleAdapter({
  packageName,
  serviceAccount: account,
  pubsubAudience: get('GOOGLE_PUBSUB_AUDIENCE'),
  pubsubServiceAccountEmail: get('GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL'),
});

// A token on the command line wins over the one in .env, so a purchase can be
// checked without editing a file:
//   deno task probe:google <purchaseToken> [productId]
const [argToken, argProduct] = Deno.args;
const purchaseToken = argToken ?? get('GOOGLE_TEST_PURCHASE_TOKEN');
const productId = argProduct ?? get('GOOGLE_TEST_PRODUCT_ID');
const basePlanId = get('GOOGLE_TEST_BASE_PLAN_ID');

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

// --- 6. Notification settings are present -----------------------------------

if (!get('GOOGLE_PUBSUB_AUDIENCE')) {
  skip(
    'notification settings',
    'GOOGLE_PUBSUB_AUDIENCE is not set, so notifications would be refused.',
  );
} else if (!get('GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL')) {
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
