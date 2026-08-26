import type { Database } from './sql.ts';
import { withoutTenant } from './tenant.ts';

/**
 * The only sanctioned ways to look across tenants.
 *
 * `withoutTenant` is a hole in the isolation model. It began as three call sites
 * and grew to twenty-three as background jobs arrived, at which point "grep it
 * and read them" stopped being a real review. These primitives close most of
 * that: each does exactly one thing, and — the property that actually matters —
 * **each returns identifiers, statuses or counts, never tenant data.** A bug in
 * one of them cannot leak a customer's messages, because none of them can read a
 * customer's messages.
 *
 * Anything that genuinely needs more still calls `withoutTenant` directly, and
 * tests/architecture.test.ts pins that list so growing it is a deliberate act
 * that shows up in review.
 */

export interface TenantRef {
  id: string;
  status: string;
  retentionDays: number;
}

/** Every background job that sweeps the platform enumerates tenants through here. */
export async function eachTenant(
  control: Database,
  purpose: string,
  opts: { statuses?: readonly string[] } = {},
): Promise<TenantRef[]> {
  const statuses = opts.statuses ?? ['trial', 'active', 'past_due'];
  const rows = await withoutTenant(control, `listing tenants: ${purpose}`, (tx) =>
    tx.query<{ id: string; status: string; retention_days: number }>(
      `select id, status, retention_days from tenants
        where $1::text[] is null or status = any($1)`,
      [statuses.length > 0 ? statuses : null],
    ));
  return rows.map((r) => ({ id: r.id, status: r.status, retentionDays: r.retention_days }));
}

/** Every tenant, including closed ones. For integrity sweeps, not for work. */
export const allTenants = (control: Database, purpose: string): Promise<TenantRef[]> =>
  eachTenant(control, purpose, { statuses: [] });

/**
 * Slug to id, at sign-in. Returns the status too — a suspended workspace must be
 * refused with the right message — and deliberately nothing else.
 */
export async function resolveWorkspace(
  control: Database, slug: string,
): Promise<{ id: string; status: string } | null> {
  const rows = await withoutTenant(control, 'resolving a workspace slug before any session exists', (tx) =>
    tx.query<{ id: string; status: string }>(
      'select id, status from tenants where slug = $1', [slug]));
  return rows[0] ?? null;
}

export interface PlatformHealthSnapshot {
  webhookBacklogSeconds: number;
  outboxDepth: number;
  outboxOldestSeconds: number;
  flaggedChannels: number;
  openCriticalEvents: number;
  connectionsInUse: number;
  meteringWindows: number;
  meteringCounter: number;
}

/**
 * Every number the health checks need, in one pass.
 *
 * Previously six separate cross-tenant queries scattered through the worker.
 * Gathering them here keeps the platform-wide reads in one auditable place, and
 * the return type makes it obvious that nothing but counts leaves.
 */
export async function platformHealthSnapshot(control: Database): Promise<PlatformHealthSnapshot> {
  return withoutTenant(control, 'gathering platform health counters', async (tx) => {
    const spool = await tx.query<{ oldest: number | null }>(
      `select extract(epoch from (now() - min(received_at)))::int as oldest
         from webhook_events where status = 'received'`);

    const outbox = await tx.query<{ depth: number; oldest: number | null }>(
      `select count(*)::int as depth,
              extract(epoch from (now() - min(created_at)))::int as oldest
         from message_outbox`);

    const flagged = await tx.query<{ n: number }>(
      `select count(*)::int as n from channels where quality = 'flagged'`);

    const events = await tx.query<{ n: number }>(
      `select count(*)::int as n from security_events
        where severity = 'critical' and acknowledged_at is null`);

    const connections = await tx.query<{ in_use: number }>(
      `select count(*)::int as in_use from pg_stat_activity where datname = current_database()`)
      .catch(() => [{ in_use: 0 }]);

    const metering = await tx.query<{ windows: number; counted: number }>(
      `select
         (select count(*)::int from billable_conversations) as windows,
         (select coalesce(sum(value), 0)::int from usage_counters where metric = 'conversations') as counted`);

    return {
      webhookBacklogSeconds: Number(spool[0]?.oldest ?? 0),
      outboxDepth: Number(outbox[0]?.depth ?? 0),
      outboxOldestSeconds: Number(outbox[0]?.oldest ?? 0),
      flaggedChannels: Number(flagged[0]?.n ?? 0),
      openCriticalEvents: Number(events[0]?.n ?? 0),
      connectionsInUse: Number(connections[0]?.in_use ?? 0),
      meteringWindows: Number(metering[0]?.windows ?? 0),
      meteringCounter: Number(metering[0]?.counted ?? 0),
    };
  });
}
