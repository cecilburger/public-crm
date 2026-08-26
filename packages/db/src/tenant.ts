import type { Database, Sql } from './sql.ts';

export class TenantContextError extends Error {}

/**
 * Every tenant-scoped read and write goes through here. It opens a transaction,
 * pins `app.tenant_id` for its lifetime and drops to the unprivileged role, so
 * the row-level security policies decide what the query can see — not the
 * caller's memory of adding a WHERE clause.
 */
export async function withTenant<T>(db: Database, tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new TenantContextError('tenantId must be a uuid');

  return db.transaction(async (tx) => {
    await tx.query('select set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    if (db.assumeRole) await tx.exec('set local role kirana_app');
    return fn(tx);
  });
}

/**
 * For the handful of operations that legitimately span tenants: provisioning a
 * new tenant, the webhook spool, platform-wide billing rollups. Kept separate
 * and loud so it shows up in review.
 */
export async function withoutTenant<T>(db: Database, reason: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (!reason) throw new TenantContextError('withoutTenant requires a stated reason');
  return db.transaction(fn);
}
