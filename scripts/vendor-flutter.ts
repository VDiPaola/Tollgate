/**
 * Copy the Dart package into a host project.
 *
 *   deno task vendor:flutter ../Learning-app/packages/tollgate
 *   deno task vendor:flutter ../Learning-app/packages/tollgate --check
 *
 * Same reasoning as the TypeScript vendor task, arrived at from the other
 * direction. A host app can depend on this package three ways:
 *
 *   path:  a sibling checkout. Works on the machine that has both repositories
 *          and nowhere else, so a build runner fails at `flutter pub get` on a
 *          directory that does not exist.
 *   git:   fine for a public repository. This one is private, so it would mean
 *          putting a credential on every runner that builds the app.
 *   pub:   the real answer, and not yet true.
 *
 * So the package is copied in and committed, exactly like the edge functions,
 * until it is published. Only the sources travel: no tests, no lockfile, no
 * build output.
 */

import { readme, run } from './vendor-lib.ts';

const args = Deno.args.filter((a) => !a.startsWith('--'));
const checkOnly = Deno.args.includes('--check');
const [target] = args;

if (!target) {
  console.error(
    [
      'Usage: deno task vendor:flutter <target-directory> [--check]',
      '',
      '  --check  report whether the target is up to date and change nothing.',
      '           Exits non-zero when it is stale, so a build can refuse to',
      '           ship an app built against an older copy of the SDK.',
    ].join('\n'),
  );
  Deno.exit(1);
}

const here = new URL('..', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
const source = `${here}packages/flutter`;

/**
 * What a consumer needs.
 *
 * `pubspec.lock` is deliberately absent: it is the source repository's
 * resolution, and a package's lockfile is ignored when it is depended on
 * anyway. The host app's own lockfile is the one that decides versions.
 */
const FILES = ['pubspec.yaml', 'analysis_options.yaml'];

const wanted = new Map<string, string>();

async function collect(from: string, to: string) {
  for await (const entry of Deno.readDir(from)) {
    const src = `${from}/${entry.name}`;
    const dst = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await collect(src, dst);
      continue;
    }
    if (!entry.name.endsWith('.dart')) continue;
    wanted.set(dst, await Deno.readTextFile(src));
  }
}

await collect(`${source}/lib`, `${target}/lib`);

for (const name of FILES) {
  wanted.set(`${target}/${name}`, await Deno.readTextFile(`${source}/${name}`));
}

wanted.set(
  `${target}/README.md`,
  readme([
    'The Dart package, copied by `deno task vendor:flutter`.',
    '',
    'It is committed on purpose. The app depends on it by path, and a path',
    'pointing at a sibling checkout is a directory that does not exist on a',
    'build runner.',
    '',
    '`deno task vendor:flutter <dir> --check` reports whether this copy is',
    'stale. That check can only run where both repositories are checked out,',
    'which is a laptop rather than CI, so run it before pushing.',
    '',
    'The package documentation lives in the source repository.',
  ]),
);

await run(target, wanted, checkOnly, 'deno task vendor:flutter');
