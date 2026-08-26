import {
  withTenant, eachTenant, allTenants, audit, verifyAuditChain, releaseOrder,
  recordSecurityEvent, listSecurityEvents, type Database,
} from '@kirana/db';
import { LogAlertSink, notificationDeadline, type AlertSink } from '@kirana/core';

/**
 * Retention is a promise with a deadline, so it runs on a schedule rather than
 * when someone remembers. Message bodies are redacted rather than rows deleted:
 * the conversation counts still have to reconcile with invoices that were
 * already issued.
 */
export async function purgeExpiredData(db: Database, control: Database, now = new Date()) {
  const tenants = await eachTenant(control, 'the retention sweep');

  const summary: { tenantId: string; messages: number; timeline: number }[] = [];

  for (const t of tenants) {
    const result = await withTenant(db, t.id, async (tx) => {
      const messages = await tx.query(
        `update messages set body_enc = null, media = '[]'
          where tenant_id = $1 and body_enc is not null
            and created_at < $2 - make_interval(days => $3)
          returning 1`,
        [t.id, now, t.retentionDays],
      );
      const timeline = await tx.query(
        `delete from timeline_events
          where tenant_id = $1 and occurred_at < $2 - make_interval(days => $3)
          returning 1`,
        [t.id, now, t.retentionDays],
      );
      if (messages.length || timeline.length) {
        await audit(tx, t.id, {
          actorType: 'system', action: 'retention.purged', resourceType: 'tenant', resourceId: t.id,
          meta: { retentionDays: t.retentionDays, messagesRedacted: messages.length, timelineDeleted: timeline.length },
        });
      }
      return { messages: messages.length, timeline: timeline.length };
    });
    summary.push({ tenantId: t.id, ...result });
  }
  return summary;
}

/**
 * Nightly integrity check. A broken chain is a page, not a ticket — and under UU
 * PDP it starts a 3×24-hour clock, so it is recorded as a security event the
 * moment it is found rather than living in a job's return value.
 */
export async function verifyAllAuditChains(
  db: Database, control: Database, sink: AlertSink = new LogAlertSink(),
) {
  const tenants = await allTenants(control, 'audit chain verification');

  const broken: { tenantId: string; brokenAt?: number }[] = [];
  for (const t of tenants) {
    const result = await withTenant(db, t.id, (tx) => verifyAuditChain(tx, t.id));
    if (result.ok) continue;

    broken.push({ tenantId: t.id, brokenAt: result.brokenAt });
    const recorded = await withTenant(db, t.id, (tx) =>
      recordSecurityEvent(tx, t.id, 'audit_chain_broken', { brokenAt: result.brokenAt ?? null }));
    await sink.deliver(recorded.alert);
  }
  return { checked: tenants.length, broken };
}

/**
 * Keeps the statutory clocks visible.
 *
 * Runs hourly. Anything notifiable that is inside its last twelve hours, or past
 * the deadline entirely, gets alerted again — because the failure mode is not
 * "nobody detected it", it is "somebody detected it on Friday afternoon".
 */
export async function sweepSecurityClocks(
  db: Database, control: Database, sink: AlertSink = new LogAlertSink(), now = new Date(),
) {
  const tenants = await eachTenant(control, 'the breach notification clock sweep');

  const pressing: { tenantId: string; eventId: string; clock: string; deadline: string }[] = [];

  for (const tenant of tenants) {
    const events = await withTenant(db, tenant.id, (tx) =>
      listSecurityEvents(tx, tenant.id, { openOnly: false, limit: 200 }));

    for (const event of events) {
      if (event.clock !== 'due_soon' && event.clock !== 'overdue') continue;
      pressing.push({
        tenantId: tenant.id, eventId: event.id, clock: event.clock,
        deadline: (event.deadline ?? notificationDeadline(event.detectedAt)).toISOString(),
      });
      await sink.deliver({
        kind: event.kind,
        severity: event.clock === 'overdue' ? 'critical' : 'warning',
        tenantId: tenant.id,
        summary: event.clock === 'overdue'
          ? `NOTIFICATION OVERDUE — ${event.summary}`
          : `Notification due within 12 hours — ${event.summary}`,
        detail: { eventId: event.id, detectedAt: event.detectedAt.toISOString(), ...event.detail },
        detectedAt: event.detectedAt,
        notifiable: true,
      });
    }
  }
  return pressing;
}

/**
 * Unpaid orders give their stock back.
 *
 * A reservation is a promise to hold something; a promise with no deadline is a
 * shop that thinks it is sold out while the shelf is full. Default window is 24
 * hours, which is also roughly how long a WhatsApp customer takes to transfer.
 */
export async function expireUnpaidOrders(
  db: Database, control: Database, opts: { hours?: number } = {},
) {
  const hours = opts.hours ?? 24;
  const tenants = await eachTenant(control, 'expiring unpaid orders');

  const summary: { tenantId: string; expired: number; stockRestored: number }[] = [];

  for (const tenant of tenants) {
    const result = await withTenant(db, tenant.id, async (tx) => {
      const stale = await tx.query<{ id: string }>(
        `select id from orders
          where tenant_id = $1 and status = 'awaiting_payment'
            and updated_at < now() - make_interval(hours => $2)
          limit 200`,
        [tenant.id, hours],
      );

      let expired = 0;
      let stockRestored = 0;
      for (const order of stale) {
        const released = await releaseOrder({ tx, tenantId: tenant.id, kek: Buffer.alloc(0) }, {
          orderId: order.id, reason: `unpaid for ${hours}h`,
        });
        if (released.released) { expired += 1; stockRestored += released.restored; }
      }
      return { expired, stockRestored };
    });

    if (result.expired > 0) summary.push({ tenantId: tenant.id, ...result });
  }
  return summary;
}
