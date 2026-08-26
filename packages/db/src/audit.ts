import { auditHash } from '@kirana/core';
import type { Sql } from './sql.ts';

export interface AuditEvent {
  actorType: 'user' | 'api_key' | 'system' | 'support';
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Append one link to the tenant's audit chain. The per-tenant advisory lock
 * serialises writers so the chain cannot fork under concurrency — auditing is
 * one of the few places where a little contention is the correct trade.
 */
export async function audit(tx: Sql, tenantId: string, ev: AuditEvent): Promise<string> {
  await tx.query('select pg_advisory_xact_lock(hashtext($1), 991)', [tenantId]);

  const prev = await tx.query<{ hash: string }>(
    'select hash from audit_events where tenant_id = $1 order by id desc limit 1',
    [tenantId],
  );

  const body = {
    tenant_id: tenantId,
    actor_type: ev.actorType,
    actor_id: ev.actorId ?? null,
    action: ev.action,
    resource_type: ev.resourceType,
    resource_id: ev.resourceId ?? null,
    meta: ev.meta ?? {},
  };
  const hash = auditHash(prev[0]?.hash ?? null, body);

  await tx.query(
    `insert into audit_events
       (tenant_id, actor_type, actor_id, action, resource_type, resource_id, ip, user_agent, meta, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [tenantId, ev.actorType, ev.actorId ?? null, ev.action, ev.resourceType, ev.resourceId ?? null,
     ev.ip ?? null, ev.userAgent ?? null, JSON.stringify(ev.meta ?? {}), prev[0]?.hash ?? null, hash],
  );
  return hash;
}

/**
 * Recomputes the chain. Run nightly; a mismatch means rows were deleted or
 * edited out of band, which the grants are supposed to make impossible.
 */
export async function verifyAuditChain(tx: Sql, tenantId: string): Promise<{ ok: boolean; brokenAt?: number }> {
  const rows = await tx.query<{
    id: number; actor_type: string; actor_id: string | null; action: string;
    resource_type: string; resource_id: string | null; meta: unknown; prev_hash: string | null; hash: string;
  }>(
    `select id, actor_type, actor_id, action, resource_type, resource_id, meta, prev_hash, hash
       from audit_events where tenant_id = $1 order by id asc`,
    [tenantId],
  );

  let prev: string | null = null;
  for (const r of rows) {
    const expected = auditHash(prev, {
      tenant_id: tenantId,
      actor_type: r.actor_type,
      actor_id: r.actor_id,
      action: r.action,
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      meta: typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta,
    });
    if (expected !== r.hash || r.prev_hash !== prev) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true };
}
