import { connectPostgres } from './sql.ts';
import { rotateTenantDek, rewrapUnderNewKek } from './rotation.ts';
import { env, loadKek } from '@kirana/core';

/**
 * Key rotation, by hand.
 *
 *   npm run rotate -- dek <tenantId>     re-encrypt one tenant onto a fresh key
 *   npm run rotate -- kek <newKekBase64> re-wrap every tenant under a new KEK
 *
 * The DEK rotation is resumable: run it again after an interruption and it picks
 * up from its cursor.
 */
const [mode, argument] = process.argv.slice(2);
const e = env();
const db = await connectPostgres(e.DATABASE_URL, { max: 4 });
const control = await connectPostgres(e.DATABASE_URL, { max: 2 });

try {
  if (mode === 'dek') {
    if (!argument) throw new Error('Usage: npm run rotate -- dek <tenantId>');
    const result = await rotateTenantDek(db, loadKek(e.KIRANA_KEK), argument, { batchSize: 500 });
    console.log(JSON.stringify(result, null, 2));
    if (!result.finished) console.error('Not finished — run it again to resume.');
  } else if (mode === 'kek') {
    if (!argument) throw new Error('Usage: npm run rotate -- kek <newKekBase64>');
    const result = await rewrapUnderNewKek(db, control, e.KIRANA_KEK, argument);
    console.log(`re-wrapped ${result.rewrapped} tenants — now set KIRANA_KEK to the new value and redeploy`);
  } else {
    console.error('Usage: npm run rotate -- dek <tenantId> | kek <newKekBase64>');
    process.exitCode = 1;
  }
} finally {
  await Promise.all([db.close(), control.close()]);
}
