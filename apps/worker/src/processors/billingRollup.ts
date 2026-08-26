import {
  estimate, overage, planOf, fromMicros, dunningFor, formatInvoiceIdr,
  LogAlertSink, type PlanCode, type InvoiceLine, type AlertSink,
} from '@kirana/core';
import {
  withTenant, eachTenant, currentUsage, audit, issueInvoiceForPeriod,
  type Database,
} from '@kirana/db';
import { sendBillingEmail, type EmailDeps } from '../email/send.ts';

export interface IssuedInvoiceSummary {
  tenantId: string;
  billingPeriodId: string;
  invoiceId: string;
  number: string;
  totalIdr: number;
  lines: InvoiceLine[];
}

/**
 * Closes a period and issues a real, numbered invoice: subscription, then
 * metered overage, then Meta's fee passed through at cost as its own line so a
 * customer can reconcile it against Meta's own billing export.
 *
 * Idempotent — one invoice per period — so a retried job cannot double-bill.
 */
export async function closePeriodAndIssueInvoice(
  db: Database, tenantId: string, now = new Date(), email?: EmailDeps,
): Promise<IssuedInvoiceSummary | null> {
  const summary = await withTenant(db, tenantId, async (tx) => {
    const due = await tx.query<{ id: string; ends_at: Date; plan_code: PlanCode }>(
      `select id, ends_at, plan_code from billing_periods
        where tenant_id = $1 and status = 'open' and ends_at <= $2
        order by ends_at asc limit 1`,
      [tenantId, now],
    );
    if (!due[0]) return null;

    const sub = await tx.query<{ interval: 'monthly' | 'annual'; extra_numbers: number;
      extra_seats: number; ai_packs: number; addons: string[] }>(
      `select interval, extra_numbers, extra_seats, ai_packs, addons
         from subscriptions where tenant_id = $1 and status <> 'cancelled' limit 1`,
      [tenantId],
    );

    const counters = await tx.query<{ metric: string; value: string }>(
      'select metric, value from usage_counters where tenant_id = $1 and billing_period_id = $2',
      [tenantId, due[0].id],
    );
    const usage = Object.fromEntries(counters.map((c) => [c.metric, Number(c.value)]));
    const conversations = usage.conversations ?? 0;
    const metaMicros = usage.meta_cost_micros ?? 0;

    const lines: InvoiceLine[] = [];

    if (due[0].plan_code !== 'custom' && sub[0]) {
      const recurring = estimate({
        plan: due[0].plan_code, interval: sub[0].interval,
        extraNumbers: sub[0].extra_numbers, extraSeats: sub[0].extra_seats, aiPacks: sub[0].ai_packs,
        addons: { csm: sub[0].addons.includes('csm'), voice: sub[0].addons.includes('voice') },
      });
      for (const l of recurring.lines) {
        lines.push({ key: l.key, label: l.label, qty: l.qty, unitIdr: l.unitIdr, amountIdr: l.amountIdr });
      }
      if (recurring.annualDiscountIdr > 0) {
        lines.push({
          key: 'annual_discount', label: 'Annual discount (2 months free)',
          qty: 1, unitIdr: -recurring.annualDiscountIdr, amountIdr: -recurring.annualDiscountIdr,
        });
      }

      const over = overage(due[0].plan_code, conversations);
      if (over.chats > 0) {
        const p = planOf(due[0].plan_code);
        lines.push({
          key: 'overage',
          label: `${over.chats.toLocaleString('id-ID')} conversations beyond ${p.chats.toLocaleString('id-ID')}`,
          qty: over.chats, unitIdr: p.overagePerChatIdr, amountIdr: over.amountIdr,
        });
      }
    }

    if (metaMicros > 0) {
      const metaIdr = fromMicros(metaMicros);
      lines.push({
        key: 'meta_passthrough', label: 'WhatsApp conversation fees (Meta, at cost)',
        qty: 1, unitIdr: metaIdr, amountIdr: metaIdr,
      });
    }

    await tx.query(
      `update billing_periods set status = 'closed', closed_at = $3 where tenant_id = $1 and id = $2`,
      [tenantId, due[0].id, now],
    );
    await audit(tx, tenantId, {
      actorType: 'system', action: 'billing.period_closed', resourceType: 'billing_period',
      resourceId: due[0].id, meta: { conversations },
    });

    const invoice = await issueInvoiceForPeriod(tx, tenantId, {
      billingPeriodId: due[0].id, lines, issuedAt: now,
    });
    if (!invoice) return null;

    return {
      tenantId, billingPeriodId: due[0].id,
      invoiceId: invoice.id, number: invoice.number, totalIdr: invoice.totalIdr, lines,
    };
  });

  // Sent after the transaction commits: a mail server being slow or down must
  // not roll back an invoice that has already been numbered.
  if (summary && email) {
    await sendBillingEmail(email, tenantId, summary.invoiceId, { kind: 'invoice_issued' })
      .catch((err: Error) => console.error('[billing] invoice email failed:', err.message));
  }
  return summary;
}

/** Warns before the bill does. Runs hourly; alerts once per threshold crossed. */
export async function checkUsageThresholds(db: Database, control: Database, now = new Date()) {
  const tenants = await eachTenant(control, 'usage threshold alerts', { statuses: ['active'] });

  const alerts: { tenantId: string; percent: number }[] = [];
  for (const t of tenants) {
    const snapshot = await withTenant(db, t.id, async (tx) => {
      const sub = await tx.query<{ plan_code: PlanCode }>(
        `select plan_code from subscriptions where tenant_id = $1 and status <> 'cancelled' limit 1`, [t.id]);
      if (!sub[0] || sub[0].plan_code === 'custom') return null;
      const { usage } = await currentUsage(tx, t.id, now);
      return { plan: sub[0].plan_code, conversations: usage.conversations };
    });
    if (!snapshot) continue;

    const percent = Math.round((snapshot.conversations / planOf(snapshot.plan).chats) * 100);
    if (percent >= 80) alerts.push({ tenantId: t.id, percent });
  }
  return alerts;
}

/* ---------------------------------------------------------------- dunning */

export interface DunningOutcome {
  tenantId: string;
  invoiceId: string;
  number: string;
  action: 'remind' | 'escalate';
  daysOverdue: number;
  /** Which reminder this was — 1, 2 or 3 — so the wording can escalate. */
  step?: number;
}

/**
 * Chase unpaid invoices, gently and then less gently.
 *
 * Reminders at 3, 7 and 14 days past due; at 21 the tenant is flagged
 * `past_due` and a human is alerted. It deliberately does **not** cut anyone
 * off: suspending a shop stops *their* customers being answered, and that is a
 * decision a person should make with the account in front of them.
 *
 * Delivery of the reminder itself is not built — there is no email sender yet.
 * Each reminder is recorded and alerted so nothing is silently skipped.
 */
export async function runDunning(
  db: Database, control: Database, sink: AlertSink = new LogAlertSink(),
  now = new Date(), email?: EmailDeps,
): Promise<DunningOutcome[]> {
  const tenants = await eachTenant(control, 'chasing unpaid invoices');

  const outcomes: DunningOutcome[] = [];

  for (const tenant of tenants) {
    const chased = await withTenant(db, tenant.id, async (tx) => {
      const invoices = await tx.query<{
        id: string; number: string; status: string; due_at: Date; reminders_sent: number; total_idr: string;
      }>(
        `select id, number, status, due_at, reminders_sent, total_idr
           from invoices
          where tenant_id = $1 and status in ('issued','overdue') and due_at is not null
          order by due_at asc limit 100`,
        [tenant.id],
      );

      const done: DunningOutcome[] = [];
      for (const invoice of invoices) {
        const decision = dunningFor(
          {
            status: invoice.status as 'issued' | 'overdue',
            dueAt: new Date(invoice.due_at),
            remindersSent: invoice.reminders_sent,
          },
          now,
        );
        if (decision.action === 'none') continue;

        await tx.query(
          `update invoices set status = 'overdue', updated_at = now()
            where tenant_id = $1 and id = $2 and status = 'issued'`,
          [tenant.id, invoice.id],
        );

        if (decision.action === 'remind') {
          await tx.query(
            `update invoices set reminders_sent = reminders_sent + 1, last_reminder_at = $3
              where tenant_id = $1 and id = $2`,
            [tenant.id, invoice.id, now],
          );
          await audit(tx, tenant.id, {
            actorType: 'system', action: 'invoice.reminder_due', resourceType: 'invoice',
            resourceId: invoice.id,
            meta: { number: invoice.number, step: decision.step, daysOverdue: decision.daysOverdue },
          });
        } else {
          await tx.query(
            `update tenants set status = 'past_due' where id = $1 and status <> 'past_due'`, [tenant.id]);
          await audit(tx, tenant.id, {
            actorType: 'system', action: 'invoice.escalated', resourceType: 'invoice',
            resourceId: invoice.id,
            meta: { number: invoice.number, daysOverdue: decision.daysOverdue },
          });
        }

        done.push({
          tenantId: tenant.id, invoiceId: invoice.id, number: invoice.number,
          action: decision.action, daysOverdue: decision.daysOverdue,
          ...(decision.action === 'remind' ? { step: decision.step } : {}),
        });
      }
      return done;
    });

    for (const outcome of chased) {
      if (email && outcome.action === 'remind' && outcome.step) {
        await sendBillingEmail(email, tenant.id, outcome.invoiceId, {
          kind: 'invoice_reminder', step: outcome.step, daysOverdue: outcome.daysOverdue,
        }).catch((err: Error) => console.error('[billing] reminder email failed:', err.message));
      }

      const invoiceTotal = outcome.action === 'escalate' ? ' — account flagged past due' : '';
      await sink.deliver({
        kind: 'dsr_overdue', // reused channel: an operational item needing a person
        severity: outcome.action === 'escalate' ? 'warning' : 'info',
        tenantId: outcome.tenantId,
        summary: `Invoice ${outcome.number} is ${outcome.daysOverdue} days overdue${invoiceTotal}`,
        detail: { invoiceId: outcome.invoiceId, action: outcome.action },
        detectedAt: now,
        notifiable: false,
      });
    }
    outcomes.push(...chased);
  }

  return outcomes;
}

export { formatInvoiceIdr };
