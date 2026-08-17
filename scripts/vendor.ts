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
 *
 * The Dart package is vendored separately, by `deno task vendor:flutter`.
 */

import { readme, run } from './vendor-lib.ts';

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

await collect(`${here}packages/core/src`, `${target}/core`, false);
await collect(`${here}packages/supabase/src`, `${target}/supabase`, true);

wanted.set(
  `${target}/README.md`,
  readme([
    'The TypeScript packages, copied by `deno task vendor`.',
    '',
    'It is committed on purpose. A Supabase deploy bundles from the',
    'repository, so a checkout without this cannot deploy the edge functions',
    'at all.',
    '',
    '`deno task vendor <dir> --check` reports whether this copy is stale.',
  ]),
);

await run(target, wanted, checkOnly, 'deno task vendor');
