/**
 * A tolerant `.env` reader.
 *
 * Deno has `--env-file`, and it is not used here because a single malformed
 * line panics the runtime: a line with an empty key makes it try to set an
 * environment variable named `""`, which the OS refuses, and the result is a
 * Rust panic with a stack-trace URL rather than anything resembling an error
 * message. A stray character in a config file should not look like a bug in the
 * toolchain.
 *
 * This reads the file, ignores what it cannot parse, and says which line it
 * ignored.
 */

export interface LoadedEnv {
  values: Map<string, string>;
  /** Line numbers and reasons for anything skipped. */
  problems: Array<{ line: number; reason: string }>;
}

export async function loadEnv(path: string): Promise<LoadedEnv> {
  const values = new Map<string, string>();
  const problems: Array<{ line: number; reason: string }> = [];

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return { values, problems: [{ line: 0, reason: `${path} does not exist` }] };
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 0) {
      problems.push({ line: i + 1, reason: 'no "=" on the line' });
      continue;
    }

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key) {
      // The exact shape that panics Deno's own parser. Usually a comment that
      // lost its leading "#", such as a "# ====" separator.
      problems.push({
        line: i + 1,
        reason: 'no name before the "=" (a comment missing its "#"?)',
      });
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push({ line: i + 1, reason: `"${key}" is not a valid name` });
      continue;
    }

    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, which is what every other reader does.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    // First definition wins, matching Deno and most dotenv readers, so a value
    // appended below an empty original does not quietly take effect.
    if (!values.has(key)) values.set(key, value);
  }

  return { values, problems };
}
