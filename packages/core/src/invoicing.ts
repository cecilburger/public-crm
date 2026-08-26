/**
 * Invoice shape and arithmetic. Pure, integer rupiah, no I/O.
 *
 * The numbers are computed once, at issue time, and then frozen onto the
 * invoice. A bill that recalculates itself when the price list changes is not a
 * bill, it is a bug with a due date.
 */

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'overdue' | 'void' | 'written_off';

export interface InvoiceLine {
  key: string;
  label: string;
  qty: number;
  unitIdr: number;
  amountIdr: number;
}

export interface InvoiceTotals {
  subtotalIdr: number;
  ppnIdr: number;
  totalIdr: number;
}

/** PPN is added on top; every price we publish is stated excluding it. */
export function totalsFor(lines: InvoiceLine[], ppnRate: number): InvoiceTotals {
  const subtotal = lines.reduce((sum, line) => sum + line.amountIdr, 0);
  // Rounded once, at the end. Rounding each line accumulates a visible error.
  const ppn = Math.round(subtotal * ppnRate);
  return { subtotalIdr: subtotal, ppnIdr: ppn, totalIdr: subtotal + ppn };
}

/**
 * `KIR/2026/000123` — the shape Indonesian bookkeeping expects: a prefix, the
 * year, and a sequence that resets annually.
 */
export function formatInvoiceNumber(year: number, sequence: number, prefix = 'KIR'): string {
  return `${prefix}/${year}/${String(sequence).padStart(6, '0')}`;
}

export const NET_DAYS = 14;

export function dueDate(issuedAt: Date, netDays = NET_DAYS): Date {
  const due = new Date(issuedAt);
  due.setUTCDate(due.getUTCDate() + netDays);
  return due;
}

/**
 * When to chase, and when to stop serving.
 *
 * Deliberately gentle at first: an Indonesian SMB pays by bank transfer and a
 * reminder three days after the due date is a courtesy, not a threat. Suspension
 * is three weeks late, and it is the last step rather than the second.
 */
export const DUNNING_DAYS = [3, 7, 14] as const;
export const ESCALATE_AFTER_DAYS = 21;

export type DunningAction =
  | { action: 'none' }
  | { action: 'remind'; step: number; daysOverdue: number }
  // Not "suspend": cutting a shop off stops *their* customers being answered,
  // which is a decision for a person. The job flags, a human decides.
  | { action: 'escalate'; daysOverdue: number };

export function dunningFor(
  invoice: { status: InvoiceStatus; dueAt: Date; remindersSent: number },
  now: Date,
): DunningAction {
  if (invoice.status !== 'issued' && invoice.status !== 'overdue') return { action: 'none' };

  const daysOverdue = Math.floor((now.getTime() - invoice.dueAt.getTime()) / 86_400_000);
  if (daysOverdue < 0) return { action: 'none' };
  if (daysOverdue >= ESCALATE_AFTER_DAYS) return { action: 'escalate', daysOverdue };

  // Send the next reminder whose threshold has passed, and only that one.
  const due = DUNNING_DAYS.filter((d) => daysOverdue >= d).length;
  if (due > invoice.remindersSent) {
    return { action: 'remind', step: invoice.remindersSent + 1, daysOverdue };
  }
  return { action: 'none' };
}

export const formatInvoiceIdr = (n: number): string => `Rp ${n.toLocaleString('id-ID')}`;
