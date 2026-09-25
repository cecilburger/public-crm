import { DIVISION_KEYS, DIVISION_NAMES, type DivisionKey } from '@kirana/core';
import type { Sql } from './sql.ts';

/**
 * SQL for "the division this statement acts in": the caller's explicit one
 * when parameter `$n` is non-null, else the transaction's (`app.division_id`,
 * set on every API request), else Marketing. For the per-division rows that a
 * statement must pick by key — connections, calendar tokens — rather than
 * leave to row-level security.
 */
export const divisionSql = (param: number): string => `coalesce($${param}::uuid, app_default_division())`;

export interface DivisionRow {
  id: string;
  key: DivisionKey;
  name: string;
}

/** Both divisions of the current tenant, Marketing first. */
export async function listDivisions(tx: Sql, tenantId: string): Promise<DivisionRow[]> {
  return tx.query<DivisionRow>(
    `select id, key, name from divisions
      where tenant_id = $1
      order by (key = 'marketing') desc, key`,
    [tenantId],
  );
}

/** A division by its key, under the tenant the caller is already scoped to. */
export async function resolveDivision(tx: Sql, tenantId: string, key: string): Promise<DivisionRow | null> {
  const rows = await tx.query<DivisionRow>(
    'select id, key, name from divisions where tenant_id = $1 and key = $2',
    [tenantId, key],
  );
  return rows[0] ?? null;
}

/**
 * Creates the tenant's divisions if they are missing and returns both ids.
 * Idempotent, because the migration that introduced divisions seeded them for
 * every tenant that already existed; this is for tenants created afterwards.
 */
export async function ensureTenantDivisions(tx: Sql, tenantId: string): Promise<Record<DivisionKey, string>> {
  for (const key of DIVISION_KEYS) {
    await tx.query(
      `insert into divisions (tenant_id, key, name) values ($1, $2, $3)
       on conflict (tenant_id, key) do nothing`,
      [tenantId, key, DIVISION_NAMES[key]],
    );
  }
  const rows = await listDivisions(tx, tenantId);
  const ids = Object.fromEntries(rows.map((r) => [r.key, r.id])) as Record<DivisionKey, string>;
  for (const key of DIVISION_KEYS) {
    if (!ids[key]) throw new Error(`tenant ${tenantId} has no ${key} division`);
  }
  return ids;
}

/** The bridge session key for a division — `app_bridge_session_key` in 0059. */
export async function divisionSessionKey(tx: Sql, divisionId: string): Promise<string> {
  const rows = await tx.query<{ key: string | null }>('select app_bridge_session_key($1) as key', [divisionId]);
  if (!rows[0]?.key) throw new Error(`no such division: ${divisionId}`);
  return rows[0].key;
}
