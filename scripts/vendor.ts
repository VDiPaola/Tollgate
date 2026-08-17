/**
 * Copy the TypeScript packages into a host project's edge functions.
 *
 *   deno task vendor ../Learning-app/supabase/functions/_shared/tollgate
 *   deno task vendor ../Learning-app/supabase/functions/_shared/tollgate --check
 *
 * A stopgap until the packages are published to JSR. Supabase edge functions
 * resolve imports relative to the functions directory, so a path escaping it
 * does not work locally and does not survive a deploy; publishing is the real
 * answer and this is what makes shipping possible before then.
 *
 * The result is meant to be committed. A Supabase deploy bundles from the
 * repository, so a checkout without it cannot deploy the edge functions at all.
 *
 * `--check` changes nothing and exits non-zero when the target is stale, which
 * is what stops a build shipping edge functions that quietly run an older copy
 * of the SDK than the tests were run against.
 */

const args = Deno.args.filter((a) => !a.startsWith('--'));
const checkOnly = Deno.args.includes('--check');
const [target] = args;

if (!target) {
  console.error(
    [
      'Usage: deno task vendor <target-directory> [--check]',
      '',
      '  --check  report whether the target is up to date and change nothing.',
      '           Exits non-zero when it is stale, so a build can refuse to',
      '           ship edge functions running an older copy of the SDK.',
    ].join('\n'),
  );
  Deno.exit(1);
}

const here = new URL('..', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

/** Rewrites applied to the supabase package, whose imports are bare. */
const REWRITES: Array<[RegExp, string]> = [
  [/from '@tollgate\/core'/g, "from '../core/index.ts'"],
  [/from '@supabase\/supabase-js'/g, "from 'jsr:@supabase/supabase-js@2'"],
];

/** Every path the target should hold, and what it should contain. */
const wanted = new Map<string, string>();

async function collect(from: string, to: string, rewrite: boolean) {
  for await (const entry of Deno.readDir(from)) {
    const src = `${from}/${entry.name}`;
    const dst = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await collect(src, dst, rewrite);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    // Tests never travel: they pull in @std/assert, which a host project has no
    // reason to resolve, and a failing import in a vendored tree looks like a
    // broken SDK rather than a file that should not be there.
    if (entry.name.endsWith('_test.ts')) continue;

    let text = await Deno.readTextFile(src);
    if (rewrite) {
      for (const [pattern, replacement] of REWRITES) {
        text = text.replace(pattern, replacement);
      }
    }
    wanted.set(dst, text);
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return;
  }
  for await (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

await collect(`${here}packages/core/src`, `${target}/core`, false);
await collect(`${here}packages/supabase/src`, `${target}/supabase`, true);

wanted.set(
  `${target}/README.md`,
  [
    '# Vendored Tollgate',
    '',
    'Copied from the tollgate repository by `deno task vendor`. Do not edit',
    'anything here: run the task again instead, and commit the result.',
    '',
    'It is committed on purpose. A Supabase deploy bundles from the repository,',
    'so a checkout without this cannot deploy the edge functions at all. It goes',
    'away once the packages are published and the functions import them by',
    'version instead.',
    '',
    '`deno task vendor <dir> --check` reports whether this copy is stale.',
    '',
  ].join('\n'),
);

if (checkOnly) {
  const stale: string[] = [];

  for (const [path, text] of wanted) {
    let current: string | null = null;
    try {
      current = await Deno.readTextFile(path);
    } catch {
      // Missing entirely.
    }
    if (current !== text) stale.push(path);
  }

  // And anything here that the SDK no longer has, which would otherwise keep
  // compiling against an interface that has gone.
  for await (const path of walk(target)) {
    if (!wanted.has(path)) stale.push(`${path} (no longer in the SDK)`);
  }

  if (stale.length === 0) {
    console.log(`${target} is up to date.`);
    Deno.exit(0);
  }

  console.error(
    `${target} is stale. Run \`deno task vendor ${target}\` and commit:`,
  );
  for (const path of stale) console.error(`  ${path}`);
  Deno.exit(1);
}

// Removed first so a file deleted upstream does not linger.
try {
  await Deno.remove(target, { recursive: true });
} catch {
  // Nothing there yet.
}

for (const [path, text] of wanted) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, text);
}

console.log(`Vendored ${wanted.size} files into ${target}`);
