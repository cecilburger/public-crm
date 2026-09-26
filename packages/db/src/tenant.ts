import type { Database, Sql } from './sql.ts';

export class TenantContextError extends Error {}

const UUID = /^[0-9a-f-]{36}$/i;

export interface TenantScope {
  /**
   * The Marketing/AI division to pin alongside the tenant. Set on every API
   * request and on every worker ingest once the channel is known; left unset
   * by tenant-wide work (billing, retention, rotation, sweeps), which then
   * sees every division — the `division_isolation` policies in 0059 only
   * narrow when a division is set.
   */
  divisionId?: string | null;
}

/**
 * Every tenant-scoped read and write goes through here. It opens a transaction,
 * pins `app.tenant_id` (and, when given, `app.division_id`) for its lifetime
 * and drops to the unprivileged role, so the row-level security policies decide
 * what the query can see — not the caller's memory of adding a WHERE clause.
 */
export async function withTenant<T>(
  db: Database, tenantId: string, fn: (tx: Sql) => Promise<T>, scope: TenantScope = {},
): Promise<T> {
  if (!UUID.test(tenantId)) throw new TenantContextError('tenantId must be a uuid');
  if (scope.divisionId && !UUID.test(scope.divisionId)) throw new TenantContextError('divisionId must be a uuid');

  return db.transaction(async (tx) => {
    await tx.query('select set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    if (scope.divisionId) await tx.query('select set_config($1, $2, true)', ['app.division_id', scope.divisionId]);
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
