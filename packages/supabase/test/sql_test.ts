/**
 * Runs the SQL pack against a real Postgres.
 *
 * A throwaway container, not a Supabase stack and emphatically not any project's
 * database: the container is created, used and destroyed by this file alone. It
 * starts from bare `postgres` on purpose, which proves the pack needs nothing
 * from Supabase but `auth.users`, `auth.uid()` and the three standard roles.
 *
 *   deno task test:db
 */

import { assertEquals } from '@std/assert';

const CONTAINER = 'tollgate_sqltest';
const IMAGE = 'postgres:17-alpine';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const sqlDir = `${here}sql`;
const migrationsDir = `${here}../migrations`;

/** The order matters: stand-ins, then the pack, then the app, then the tests. */
const SCRIPTS = [
  `${sqlDir}/00_bootstrap.sql`,
  `${migrationsDir}/0001_tollgate_schema.sql`,
  `${migrationsDir}/0002_tollgate_functions.sql`,
  `${sqlDir}/10_seed.sql`,
  `${sqlDir}/20_entitlements.sql`,
  `${sqlDir}/30_consumables.sql`,
  `${sqlDir}/40_security.sql`,
];

async function docker(
  args: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const cmd = new Deno.Command('docker', {
    args,
    stdin: stdin === undefined ? 'null' : 'piped',
    stdout: 'piped',
    stderr: 'piped',
  });
  const child = cmd.spawn();
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const { code, stdout, stderr } = await child.output();
  return {
    code,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  };
}

async function psql(sql: string): Promise<{ code: number; out: string; err: string }> {
  return await docker([
    'exec',
    '-i',
    CONTAINER,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-q',
  ], sql);
}

/**
 * Wait for the container name to be free.
 *
 * `docker rm -f` returns before the name is released, so starting the next run
 * immediately fails with "name already in use". The symptom is every step
 * failing at once, which reads like a broken migration rather than a race.
 */
async function waitForNameFree(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await docker(['ps', '-aq', '-f', `name=^${CONTAINER}$`]);
    if (r.out.trim() === '') return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Container "${CONTAINER}" would not go away.`);
}

async function waitForPostgres(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres']);
    if (r.code === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Postgres never became ready.');
}

Deno.test({
  name: 'the SQL pack installs and behaves',
  // The container is the only resource, and it is torn down in the finally.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    await docker(['rm', '-f', CONTAINER]);
    await waitForNameFree();
    const started = await docker([
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-e',
      'POSTGRES_PASSWORD=postgres',
      IMAGE,
    ]);
    if (started.code !== 0) {
      throw new Error(`Could not start ${IMAGE}: ${started.err}`);
    }

    try {
      await waitForPostgres();

      for (const path of SCRIPTS) {
        const name = path.split('/').pop()!;
        await t.step(name, async () => {
          const sql = await Deno.readTextFile(path);
          const r = await psql(sql);
          if (r.code !== 0) {
            throw new Error(`${name} failed:\n${r.err}\n${r.out}`);
          }
          // psql reports RAISE NOTICE on stderr; surface the per-case names so
          // a run reads like a test run rather than a single opaque pass.
          const notices = r.err.split('\n')
            .filter((l) => l.includes('ok  '))
            .map((l) => l.replace(/^NOTICE:\s*/, '').trim());
          for (const n of notices) console.log(`    ${n}`);
          assertEquals(r.code, 0);
        });
      }
    } finally {
      await docker(['rm', '-f', CONTAINER]);
    }
  },
});
