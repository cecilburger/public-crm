/**
 * One-time move of the dev stack's old PGlite data directory into Postgres.
 *
 * The dev stack used to keep everything in `.dev-stack-data/` (PGlite), and
 * that directory can hold setup that is slow to redo by hand — a paired
 * WhatsApp Web number, an Instagram login. Rather than start the new
 * database empty, the first run copies every row across.
 *
 * Both sides are brought to the same migration version first, so the tables
 * match column for column. Rows travel as JSON (`to_jsonb` out,
 * `jsonb_populate_recordset` in), which round-trips every column type the
 * schema uses — bytea, arrays, timestamps, enums — without a type map here.
 * Triggers are off for the load (`session_replication_role = replica`), so
 * the audit log's append-only guard and the foreign keys don't fight a bulk
 * copy of rows that were already valid.
 */
import { connectPglite, migrate, type Database } from '@kirana/db';

export async function importFromPglite(target: Database, pgliteDir: string): Promise<void> {
  const source = await connectPglite(pgliteDir);
  try {
    await migrate(source);

    const versions = async (db: Database) =>
      (await db.query<{ version: string }>('select version from schema_migrations order by version'))
        .map((r) => r.version).join(',');
    if ((await versions(source)) !== (await versions(target))) {
      throw new Error('the PGlite data and Postgres are on different migration versions');
    }

    // Plain tables and leaf partitions only — a partitioned parent holds no
    // rows of its own, and copying it too would load each row twice.
    const tables = (await source.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'
        order by c.relname`)).map((r) => r.name);
    const sequences = await source.query<{ name: string; last_value: string | null }>(
      `select sequencename as name, last_value::text from pg_sequences where schemaname = 'public'`);

    await target.transaction(async (tx) => {
      await tx.exec('set local session_replication_role = replica');
      // Migrations seed some reference rows; the source has the same ones.
      if (tables.length) await tx.exec(`truncate ${tables.map((t) => `"${t}"`).join(', ')}`);

      for (const table of tables) {
        const [result] = await source.query<{ rows: string }>(
          `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text as rows from "${table}" t`);
        const rows = result?.rows ?? '[]';
        if (rows === '[]') continue;
        await tx.query(
          `insert into "${table}" select * from jsonb_populate_recordset(null::"${table}", $1::text::jsonb)`,
          [rows]);
      }
      for (const seq of sequences) {
        if (seq.last_value !== null) {
          await tx.query(`select setval($1, $2::bigint, true)`, [`public."${seq.name}"`, seq.last_value]);
        }
      }
    });

    // Verify rather than trust: every table's count must match.
    for (const table of tables) {
      const count = async (db: Database) =>
        (await db.query<{ n: string }>(`select count(*)::text as n from "${table}"`))[0]!.n;
      const [from, to] = [await count(source), await count(target)];
      if (from !== to) throw new Error(`row count mismatch on ${table}: ${from} in PGlite, ${to} in Postgres`);
    }
    console.log(`[dev-stack] copied ${tables.length} tables from ${pgliteDir} into Postgres`);
  } finally {
    await source.close();
  }
}
