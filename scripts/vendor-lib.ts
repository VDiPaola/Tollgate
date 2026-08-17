/**
 * The part both vendor tasks share: writing a set of files into a host project,
 * or reporting that what is there no longer matches.
 *
 * Vendoring exists because this repository is not published anywhere a host
 * project's build can reach. The edge functions need it because a Supabase
 * deploy bundles from the repository; the Flutter package needs it because a
 * `path:` dependency pointing outside the repository is a directory that does
 * not exist on a build runner, and a `git:` dependency on a private repository
 * would mean putting a credential on the runner instead.
 */

/** Every file in a directory tree, recursively. Silent on a missing tree. */
export async function* walk(dir: string): AsyncGenerator<string> {
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

/**
 * Compare what is in the target against what should be, and report the
 * difference. Includes files the target holds that the SDK no longer has, which
 * would otherwise go on compiling against an interface that has gone.
 */
export async function stale(
  target: string,
  wanted: Map<string, string>,
): Promise<string[]> {
  const out: string[] = [];

  for (const [path, text] of wanted) {
    let current: string | null = null;
    try {
      current = await Deno.readTextFile(path);
    } catch {
      // Missing entirely.
    }
    if (current !== text) out.push(path);
  }

  for await (const path of walk(target)) {
    if (!wanted.has(path)) out.push(`${path} (no longer in the SDK)`);
  }

  return out;
}

/** Replace the target with exactly [wanted]. */
export async function write(
  target: string,
  wanted: Map<string, string>,
): Promise<void> {
  // Removed first, so a file deleted upstream does not linger.
  try {
    await Deno.remove(target, { recursive: true });
  } catch {
    // Nothing there yet.
  }

  for (const [path, text] of wanted) {
    await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/**
 * Do whichever of the two the caller asked for, and exit.
 *
 * `--check` exits non-zero when the copy is stale, which is what stops a build
 * shipping something older than the tests were run against.
 */
export async function run(
  target: string,
  wanted: Map<string, string>,
  checkOnly: boolean,
  task: string,
): Promise<never> {
  if (checkOnly) {
    const differences = await stale(target, wanted);
    if (differences.length === 0) {
      console.log(`${target} is up to date.`);
      Deno.exit(0);
    }
    console.error(`${target} is stale. Run \`${task} ${target}\` and commit:`);
    for (const path of differences) console.error(`  ${path}`);
    Deno.exit(1);
  }

  await write(target, wanted);
  console.log(`Vendored ${wanted.size} files into ${target}`);
  Deno.exit(0);
}

/** The note dropped into every vendored tree, so nobody edits one by accident. */
export function readme(lines: string[]): string {
  return [
    '# Vendored Tollgate',
    '',
    ...lines,
    '',
    'Do not edit anything here. Run the vendor task again instead, and commit',
    'the result. It goes away once the packages are published and the host',
    'depends on them by version.',
    '',
  ].join('\n');
}
