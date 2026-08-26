import { shouldOpenWindow, windowExpiry, periodFor, emptyUsage, type UsageSnapshot } from '@kirana/core';
import type { Sql } from './sql.ts';

export interface BillableResult {
  /** True when this message opened a new 24-hour window the customer pays for. */
  billed: boolean;
  windowId: string;
  billingPeriodId: string;
}

/**
 * Ensures there is an open billing period covering `now`, anchored to the day
 * the subscription started rather than the calendar month.
 */
export async function ensureBillingPeriod(tx: Sql, tenantId: string, now: Date): Promise<{ id: string }> {
  const open = await tx.query<{ id: string }>(
    `select id from billing_periods
      where tenant_id = $1 and starts_at <= $2 and ends_at > $2 and status = 'open'
      limit 1`,
    [tenantId, now],
  );
  if (open[0]) return open[0];

  const sub = await tx.query<{ anchor_at: Date; plan_code: string }>(
    `select anchor_at, plan_code from subscriptions
      where tenant_id = $1 and status <> 'cancelled' limit 1`,
    [tenantId],
  );
  if (!sub[0]) throw new Error(`Tenant ${tenantId} has no active subscription`);

  const { startsAt, endsAt } = periodFor(new Date(sub[0].anchor_at), now);
  const created = await tx.query<{ id: string }>(
    `insert into billing_periods (tenant_id, starts_at, ends_at, plan_code)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, starts_at) do update set status = billing_periods.status
     returning id`,
    [tenantId, startsAt, endsAt, sub[0].plan_code],
  );
  return created[0]!;
}

/**
 * The meter.
 *
 * Called once per inbound message. Takes a transaction-scoped advisory lock on
 * (tenant, contact) first: two messages arriving in the same millisecond must
 * not open two billable windows, and a unique index cannot express "one row
 * where expires_at > now()" because now() is not immutable.
 */
export async function recordConversationActivity(
  tx: Sql,
  args: { tenantId: string; contactId: string; channelId: string; messageId?: string; now?: Date },
): Promise<BillableResult> {
  const now = args.now ?? new Date();

  await tx.query('select pg_advisory_xact_lock(hashtext($1), hashtext($2))', [args.tenantId, args.contactId]);

  const period = await ensureBillingPeriod(tx, args.tenantId, now);

  const active = await tx.query<{ id: string; expires_at: Date }>(
    `select id, expires_at from billable_conversations
      where tenant_id = $1 and contact_id = $2
      order by expires_at desc limit 1`,
    [args.tenantId, args.contactId],
  );

  const current = active[0] ? { id: active[0].id, expiresAt: new Date(active[0].expires_at) } : null;

  if (!shouldOpenWindow(current, now)) {
    return { billed: false, windowId: current!.id, billingPeriodId: period.id };
  }

  const opened = await tx.query<{ id: string }>(
    `insert into billable_conversations
       (tenant_id, contact_id, channel_id, billing_period_id, opened_at, expires_at, opened_by_message_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [args.tenantId, args.contactId, args.channelId, period.id, now, windowExpiry(now), args.messageId ?? null],
  );

  await incrementUsage(tx, args.tenantId, period.id, 'conversations', 1);
  return { billed: true, windowId: opened[0]!.id, billingPeriodId: period.id };
}

/** Atomic, contention-free counter bump. Never read-modify-write in app code. */
export async function incrementUsage(
  tx: Sql, tenantId: string, billingPeriodId: string, metric: string, by = 1,
): Promise<void> {
  await tx.query(
    `insert into usage_counters (tenant_id, billing_period_id, metric, value)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, billing_period_id, metric)
     do update set value = usage_counters.value + excluded.value, updated_at = now()`,
    [tenantId, billingPeriodId, metric, by],
  );
}

export async function currentUsage(tx: Sql, tenantId: string, now = new Date()) {
  const period = await ensureBillingPeriod(tx, tenantId, now);
  const rows = await tx.query<{ metric: string; value: string }>(
    'select metric, value from usage_counters where tenant_id = $1 and billing_period_id = $2',
    [tenantId, period.id],
  );
  const usage: UsageSnapshot = emptyUsage();
  for (const r of rows) {
    if (r.metric in usage) usage[r.metric as keyof UsageSnapshot] = Number(r.value);
  }
  return { billingPeriodId: period.id, usage };
}
