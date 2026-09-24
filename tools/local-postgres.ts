/**
 * A real Postgres 16 server for the dev stack, with no Docker and nothing
 * installed system-wide: `embedded-postgres` ships the server binaries as an
 * npm package, and the cluster lives in `.dev-stack-pg/` (gitignored).
 *
 * This replaced PGlite for the dev stack. PGlite is Postgres compiled to WASM,
 * running inside the API's own Node process on a single connection — every
 * query blocked the event loop the HTTP server also runs on, and every
 * transaction waited in one global queue behind every other. On a slow
 * machine that was the lag. A real server runs queries in its own processes,
 * in parallel, off the API's thread.
 *
 * Set `DEV_STACK_DATABASE_URL` to use a Postgres you already run instead; it
 * must connect as a superuser or the schema owner, like the test suite's
 * `TEST_DATABASE_URL`.
 */
import path from 'node:path';
import { connectPostgres } from '@kirana/db';

export interface LocalPostgres {
  /** Owner connection string for the `kirana` database. */
  url: string;
  /** Stops the server if this process started it; a no-op otherwise. */
  stop(): Promise<void>;
}

const USER = 'kirana_owner';
const PASSWORD = 'kirana-owner-local';
const DATABASE = 'kirana';

async function reachable(url: string): Promise<boolean> {
  try {
    const probe = await connectPostgres(url, { max: 1 });
    await probe.query('select 1');
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

export async function startLocalPostgres(rootDir: string): Promise<LocalPostgres> {
  if (process.env.DEV_STACK_DATABASE_URL) {
    return { url: process.env.DEV_STACK_DATABASE_URL, stop: async () => {} };
  }

  const port = Number(process.env.DEV_STACK_PG_PORT ?? 5433);
  const serverUrl = (db: string) => `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${db}`;

  // A server left running by an earlier run that was killed without the
  // chance to shut it down — reuse it rather than fail on the port.
  let stop = async () => {};
  if (!(await reachable(serverUrl('postgres')))) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const databaseDir = path.join(rootDir, '.dev-stack-pg');
    const pg = new EmbeddedPostgres({
      databaseDir, port, user: USER, password: PASSWORD, persistent: true,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      // Sized for a small machine. synchronous_commit=off can lose the last
      // few milliseconds of commits on a power cut, never corrupts — fsync
      // stays on, since this directory can hold real paired sessions.
      postgresFlags: [
        '-c', 'listen_addresses=127.0.0.1',
        '-c', 'max_connections=40',
        '-c', 'shared_buffers=64MB',
        '-c', 'work_mem=4MB',
        '-c', 'synchronous_commit=off',
      ],
      onLog: () => {},
      onError: (err) => console.error('[postgres]', err),
    });
    const fs = await import('node:fs');
    if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) {
      console.log(`[dev-stack] creating a Postgres cluster in ${databaseDir}`);
      await pg.initialise();
    }
    await pg.start();
    stop = () => pg.stop();
  }

  const admin = await connectPostgres(serverUrl('postgres'), { max: 1 });
  const exists = await admin.query(`select 1 from pg_database where datname = $1`, [DATABASE]);
  if (!exists[0]) await admin.exec(`create database ${DATABASE}`);
  await admin.close();

  return { url: serverUrl(DATABASE), stop };
}
