import { connectPostgres } from './sql.ts';
import { migrate } from './migrate.ts';
import { env } from '@kirana/core';

const e = env();

// The owner role, not the application one. `kirana_app` has no DDL rights by
// design, so migrating as it fails with "permission denied for schema public" —
// a confusing way to learn that this is the wrong connection. Naming which URL
// is in use turns that into something an operator can act on.
const url = e.MIGRATION_DATABASE_URL ?? e.DATABASE_URL;
if (!e.MIGRATION_DATABASE_URL) {
  console.warn(
    'MIGRATION_DATABASE_URL is not set — falling back to DATABASE_URL. '
    + 'If that is the application role this will fail: it owns nothing and cannot run DDL.',
  );
}
console.log(`migrating as ${url.replace(/\/\/([^:]+):[^@]*@/, '//$1:****@')}`);

const db = await connectPostgres(url, { max: 2 });
try {
  const result = await migrate(db, { log: (m) => console.log(m) });
  console.log(`migrations: ${result.applied} applied, ${result.total} total`);
} finally {
  await db.close();
}
