import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Database } from './sql.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Forward-only, checksummed, one transaction per file. A changed checksum on an
 * already-applied migration is a hard error: editing history silently is how
 * staging and production drift apart.
 */
export async function migrate(db: Database, opts: { dir?: string; log?: (m: string) => void } = {}) {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => {});

  await db.exec(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now(),
      checksum   text not null
    );
  `);

  const applied = new Map(
    (await db.query<{ version: string; checksum: string }>('select version, checksum from schema_migrations'))
      .map((r) => [r.version, r.checksum]),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const body = await readFile(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16);
    const seen = applied.get(version);

    if (seen === checksum) continue;
    if (seen && seen !== checksum) {
      throw new Error(
        `Migration ${version} changed after it was applied (${seen} → ${checksum}). ` +
        `Write a new migration instead of editing this one.`,
      );
    }

    await db.exec(body);
    await db.query('insert into schema_migrations (version, checksum) values ($1, $2)', [version, checksum]);
    log(`applied ${version}`);
    count += 1;
  }

  return { applied: count, total: files.length };
}
