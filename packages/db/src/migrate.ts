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
    // `git`'s `core.autocrlf` checks these files out differently machine to
    // machine (LF as committed, CRLF on a Windows clone with autocrlf on),
    // so the exact same, unedited migration can hash differently purely
    // depending on which OS last checked it out — confirmed live, this
    // raised a false "migration changed after it was applied" for a file
    // nobody had touched. Checksums already recorded on a database created
    // before this fix existed were themselves computed on raw, un-normalised
    // bytes, on whichever line-ending convention that machine had at the
    // time — so accepting only the normalised hash here would just move the
    // false mismatch onto every migration whose recorded checksum happens
    // to be a raw CRLF one instead (confirmed live, on `0001_foundation`,
    // the very next run after only normalising). Comparing against *both*
    // forms is what tolerates that mixed history; new checksums are still
    // always recorded normalised, so it converges going forward rather than
    // perpetuating the ambiguity.
    const normalised = body.replace(/\r\n/g, '\n');
    const checksum = createHash('sha256').update(normalised).digest('hex').slice(0, 16);
    const rawChecksum = normalised === body ? checksum
      : createHash('sha256').update(body).digest('hex').slice(0, 16);
    const seen = applied.get(version);

    if (seen === checksum || seen === rawChecksum) continue;
    if (seen && seen !== checksum && seen !== rawChecksum) {
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
