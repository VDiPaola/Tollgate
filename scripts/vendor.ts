/**
 * Copy the TypeScript packages into a host project's edge functions.
 *
 *   deno task vendor ../Learning-app/supabase/functions/_shared/tollgate
 *
 * A stopgap until the packages are published to JSR. Supabase edge functions
 * resolve imports relative to the functions directory, so a path escaping it
 * does not work locally and does not survive a deploy; publishing is the real
 * answer and this is what makes testing possible before then.
 *
 * The copy is one-way and the target is overwritten. Nothing in a vendored tree
 * should ever be edited: run this again instead.
 */

const [target] = Deno.args;
if (!target) {
  console.error('Usage: deno task vendor <target-directory>');
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

async function copyTree(from: string, to: string, rewrite: boolean) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = `${from}/${entry.name}`;
    const dst = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await copyTree(src, dst, rewrite);
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
    await Deno.writeTextFile(dst, text);
  }
}

// Removed first so a file deleted upstream does not linger here and keep
// compiling against an interface that no longer exists.
try {
  await Deno.remove(target, { recursive: true });
} catch {
  // Nothing there yet.
}

await copyTree(`${here}packages/core/src`, `${target}/core`, false);
await copyTree(`${here}packages/supabase/src`, `${target}/supabase`, true);

await Deno.writeTextFile(
  `${target}/README.md`,
  `# Vendored Tollgate\n\n` +
    `Copied from the tollgate repository by \`deno task vendor\`. Do not edit\n` +
    `anything here: run the task again instead.\n\n` +
    `Generated ${new Date().toISOString().slice(0, 10)}.\n`,
);

console.log(`Vendored core and supabase into ${target}`);
