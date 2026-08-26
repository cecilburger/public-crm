/**
 * A deliberately tiny driver seam.
 *
 * Production runs postgres-js against real Postgres. Tests run the identical
 * SQL against PGlite (Postgres compiled to WASM) so row-level security, roles
 * and advisory locks are exercised for real rather than mocked away.
 */
export type Row = Record<string, unknown>;

export interface Sql {
  query<T = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Multi-statement DDL. No parameters — never build this from user input. */
  exec(text: string): Promise<void>;
}

export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** True when the connection is privileged and must `set local role` itself. */
  readonly assumeRole: boolean;
}

/* ------------------------------------------------------------- postgres-js */

export async function connectPostgres(
  url: string,
  opts: { max?: number; assumeRole?: boolean; poolMode?: 'session' | 'transaction' } = {},
): Promise<Database> {
  const { default: postgres } = await import('postgres');
  const transactionPooled = opts.poolMode === 'transaction';

  const sql = postgres(url, {
    max: opts.max ?? 20,
    idle_timeout: 30,
    connect_timeout: 10,
    // Named prepared statements are bound to one server connection. Behind a
    // transaction-mode pooler the connection changes between transactions, and
    // the statement is gone — an error that appears only under concurrency, in
    // production, and never in a test.
    prepare: !transactionPooled,
    onnotice: () => {},
  });

  const wrap = (h: typeof sql): Sql => ({
    async query<T>(text: string, params: readonly unknown[] = []) {
      return (await h.unsafe(text, params as never[])) as unknown as T[];
    },
    async exec(text: string) {
      await h.unsafe(text).simple();
    },
  });

  return {
    ...wrap(sql),
    assumeRole: opts.assumeRole ?? false,
    async transaction<T>(fn: (tx: Sql) => Promise<T>) {
      return sql.begin(async (t) => fn(wrap(t as unknown as typeof sql))) as Promise<T>;
    },
    async close() { await sql.end({ timeout: 5 }); },
  };
}

/* ------------------------------------------------------------------ PGlite */

export async function connectPglite(dataDir?: string): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  await db.waitReady;

  const base: Sql = {
    async query<T>(text: string, params: readonly unknown[] = []) {
      const res = await db.query(text, params as unknown[]);
      return res.rows as T[];
    },
    async exec(text: string) { await db.exec(text); },
  };

  // PGlite is a single connection, so overlapping transactions would interleave
  // their statements into one another. Real Postgres gives each transaction its
  // own connection from the pool; this queue reproduces that guarantee.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    ...base,
    // PGlite connects as the bootstrap superuser, which bypasses RLS unless we
    // drop into the application role inside each transaction.
    assumeRole: true,
    transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        await db.exec('begin');
        try {
          const out = await fn(base);
          await db.exec('commit');
          return out;
        } catch (err) {
          await db.exec('rollback');
          throw err;
        }
      });
      queue = run.catch(() => undefined);
      return run as Promise<T>;
    },
    async close() { await db.close(); },
  };
}
