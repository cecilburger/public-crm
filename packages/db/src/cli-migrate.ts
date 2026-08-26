import { connectPostgres } from './sql.ts';
import { migrate } from './migrate.ts';
import { env } from '@kirana/core';

const e = env();
const db = await connectPostgres(e.DATABASE_URL, { max: 2 });
try {
  const result = await migrate(db, { log: (m) => console.log(m) });
  console.log(`migrations: ${result.applied} applied, ${result.total} total`);
} finally {
  await db.close();
}
