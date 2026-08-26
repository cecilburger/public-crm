import {
  totalsFor, formatInvoiceNumber, dueDate, PPN_RATE,
  type InvoiceLine, type InvoiceStatus,
} from '@kirana/core';
import type { Sql } from './sql.ts';
import { audit } from './audit.ts';

export interface IssuedInvoice {
  id: string;
  number: string;
  subtotalIdr: number;
  ppnIdr: number;
  totalIdr: number;
  dueAt: Date;
  lines: InvoiceLine[];
}

/**
 * Allocate the next number for this tenant and year, atomically.
 *
 * `ON CONFLICT DO UPDATE … RETURNING` is the whole trick: two rollups running at
 * once cannot be handed the same number, and there are no gaps to explain to an
 * accountant.
 */
export async function nextInvoiceNumber(tx: Sql, tenantId: string, year: number): Promise<string> {
  const rows = await tx.query<{ last_seq: number }>(
    `insert into invoice_counters (tenant_id, year, last_seq) values ($1, $2, 1)
     on conflict (tenant_id, year) do update set last_seq = invoice_counters.last_seq + 1
     returning last_seq`,
    [tenantId, year],
  );
  return formatInvoiceNumber(year, rows[0]!.last_seq);
}

/**
 * Turn a closed billing period into a durable invoice.
 *
 * Idempotent: a partial unique index means one invoice per period, so re-running
 * the rollup after a crash returns the existing one instead of billing twice.
 */
export async function issueInvoiceForPeriod(
  tx: Sql,
  tenantId: string,
  args: { billingPeriodId: string; lines: InvoiceLine[]; issuedAt?: Date; notes?: string },
): Promise<IssuedInvoice | null> {
  const existing = await tx.query<{ id: string; number: string; subtotal_idr: string; ppn_idr: string; total_idr: string; due_at: Date }>(
    `select id, number, subtotal_idr, ppn_idr, total_idr, due_at
       from invoices where tenant_id = $1 and billing_period_id = $2`,
    [tenantId, args.billingPeriodId],
  );
  if (existing[0]) {
    const lines = await invoiceLines(tx, tenantId, existing[0].id);
    return {
      id: existing[0].id, number: existing[0].number,
      subtotalIdr: Number(existing[0].subtotal_idr),
      ppnIdr: Number(existing[0].ppn_idr),
      totalIdr: Number(existing[0].total_idr),
      dueAt: new Date(existing[0].due_at), lines,
    };
  }

  if (args.lines.length === 0) return null;

  const issuedAt = args.issuedAt ?? new Date();
  const totals = totalsFor(args.lines, PPN_RATE);
  const number = await nextInvoiceNumber(tx, tenantId, issuedAt.getUTCFullYear());
  const due = dueDate(issuedAt);

  // The bill-to details are copied, not referenced: an invoice must still read
  // correctly after the company changes its address.
  const profile = await tx.query<{
    legal_name: string; npwp: string | null; address: string | null; billing_email: string | null;
  }>(
    'select legal_name, npwp, address, billing_email from billing_profiles where tenant_id = $1',
    [tenantId],
  );
  const fallback = await tx.query<{ name: string; billing_email: string | null }>(
    'select name, billing_email from tenants where id = $1', [tenantId]);

  const rows = await tx.query<{ id: string }>(
    `insert into invoices
       (tenant_id, number, billing_period_id, status, subtotal_idr, ppn_idr, total_idr, ppn_rate,
        bill_to_name, bill_to_npwp, bill_to_address, bill_to_email, notes, issued_at, due_at)
     values ($1,$2,$3,'issued',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning id`,
    [tenantId, number, args.billingPeriodId, totals.subtotalIdr, totals.ppnIdr, totals.totalIdr, PPN_RATE,
     profile[0]?.legal_name ?? fallback[0]?.name ?? 'Pelanggan',
     profile[0]?.npwp ?? null, profile[0]?.address ?? null,
     profile[0]?.billing_email ?? fallback[0]?.billing_email ?? null,
     args.notes ?? null, issuedAt, due],
  );

  const invoiceId = rows[0]!.id;
  for (const [index, line] of args.lines.entries()) {
    await tx.query(
      `insert into invoice_lines (tenant_id, invoice_id, position, key, label, qty, unit_idr, amount_idr)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, invoiceId, index, line.key, line.label, line.qty, line.unitIdr, line.amountIdr],
    );
  }

  await tx.query(
    `update billing_periods set status = 'invoiced' where tenant_id = $1 and id = $2`,
    [tenantId, args.billingPeriodId],
  );
  await audit(tx, tenantId, {
    actorType: 'system', action: 'invoice.issued', resourceType: 'invoice', resourceId: invoiceId,
    meta: { number, totalIdr: totals.totalIdr, lines: args.lines.length },
  });

  return { id: invoiceId, number, ...totals, dueAt: due, lines: args.lines };
}

export async function invoiceLines(tx: Sql, tenantId: string, invoiceId: string): Promise<InvoiceLine[]> {
  const rows = await tx.query<{ key: string; label: string; qty: number; unit_idr: string; amount_idr: string }>(
    `select key, label, qty, unit_idr, amount_idr from invoice_lines
      where tenant_id = $1 and invoice_id = $2 order by position asc`,
    [tenantId, invoiceId],
  );
  return rows.map((r) => ({
    key: r.key, label: r.label, qty: r.qty,
    unitIdr: Number(r.unit_idr), amountIdr: Number(r.amount_idr),
  }));
}

export interface InvoiceRow {
  id: string;
  number: string;
  status: InvoiceStatus;
  subtotalIdr: number;
  ppnIdr: number;
  totalIdr: number;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  remindersSent: number;
  billToName: string | null;
}

const toRow = (r: Record<string, unknown>): InvoiceRow => ({
  id: String(r.id),
  number: String(r.number),
  status: r.status as InvoiceStatus,
  subtotalIdr: Number(r.subtotal_idr),
  ppnIdr: Number(r.ppn_idr),
  totalIdr: Number(r.total_idr),
  issuedAt: r.issued_at ? new Date(r.issued_at as string) : null,
  dueAt: r.due_at ? new Date(r.due_at as string) : null,
  paidAt: r.paid_at ? new Date(r.paid_at as string) : null,
  remindersSent: Number(r.reminders_sent ?? 0),
  billToName: (r.bill_to_name as string) ?? null,
});

export async function listInvoices(tx: Sql, tenantId: string, limit = 50): Promise<InvoiceRow[]> {
  const rows = await tx.query<Record<string, unknown>>(
    `select id, number, status, subtotal_idr, ppn_idr, total_idr, issued_at, due_at, paid_at,
            reminders_sent, bill_to_name
       from invoices where tenant_id = $1 order by coalesce(issued_at, created_at) desc limit $2`,
    [tenantId, Math.min(limit, 200)],
  );
  return rows.map(toRow);
}

export async function getInvoice(
  tx: Sql, tenantId: string, id: string,
): Promise<(InvoiceRow & { lines: InvoiceLine[]; billToNpwp: string | null; billToAddress: string | null }) | null> {
  const rows = await tx.query<Record<string, unknown>>(
    `select id, number, status, subtotal_idr, ppn_idr, total_idr, issued_at, due_at, paid_at,
            reminders_sent, bill_to_name, bill_to_npwp, bill_to_address
       from invoices where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) return null;
  return {
    ...toRow(rows[0]),
    billToNpwp: (rows[0].bill_to_npwp as string) ?? null,
    billToAddress: (rows[0].bill_to_address as string) ?? null,
    lines: await invoiceLines(tx, tenantId, id),
  };
}

/**
 * Confirming a bank transfer by hand. The reference is whatever the operator
 * read off the statement, and it is recorded so the payment can be traced back.
 */
export async function markInvoicePaid(
  tx: Sql, tenantId: string, id: string, args: { userId: string; reference: string; at?: Date },
): Promise<boolean> {
  const rows = await tx.query<{ id: string; number: string; total_idr: string }>(
    `update invoices
        set status = 'paid', paid_at = $4, paid_by = $3, payment_ref = $5,
            provider = coalesce(provider, 'manual_transfer'), updated_at = now()
      where tenant_id = $1 and id = $2 and status in ('issued','overdue')
      returning id, number, total_idr`,
    [tenantId, id, args.userId, args.at ?? new Date(), args.reference],
  );
  if (!rows[0]) return false;

  // A shop that has paid is in good standing again.
  await tx.query(
    `update tenants set status = 'active' where id = $1 and status = 'past_due'`, [tenantId]);
  await audit(tx, tenantId, {
    actorType: 'user', actorId: args.userId, action: 'invoice.paid',
    resourceType: 'invoice', resourceId: id,
    meta: { number: rows[0].number, totalIdr: Number(rows[0].total_idr), reference: args.reference },
  });
  return true;
}
