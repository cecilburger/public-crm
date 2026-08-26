import {
  invoiceIssuedEmail, invoiceReminderEmail, paymentReceivedEmail,
  LogEmailSender, type EmailMessage, type EmailSender, type Env,
} from '@kirana/core';
import { withTenant, getInvoice, audit, type Database } from '@kirana/db';
import { SmtpEmailSender } from './smtp.ts';

export function resolveSender(env: Env): EmailSender {
  if (!env.SMTP_URL) {
    console.warn('SMTP_URL is not set — email is being logged, not delivered');
    return new LogEmailSender((line) => console.log(line));
  }
  return new SmtpEmailSender(env.SMTP_URL, env.EMAIL_FROM);
}

export interface EmailDeps {
  db: Database;
  sender: EmailSender;
}

export type BillingEmailKind =
  | { kind: 'invoice_issued' }
  | { kind: 'invoice_reminder'; step: number; daysOverdue: number }
  | { kind: 'payment_received'; reference: string };

export interface SendOutcome {
  sent: boolean;
  skipped?: 'already_sent' | 'no_recipient' | 'no_invoice';
  template?: string;
}

/**
 * Render and deliver one billing email.
 *
 * Idempotent through the `emails` unique index rather than a flag on the
 * invoice: one guarantee covers every template, including each reminder step,
 * and a retried job cannot mail a shop twice.
 */
export async function sendBillingEmail(
  deps: EmailDeps, tenantId: string, invoiceId: string, kind: BillingEmailKind,
): Promise<SendOutcome> {
  const context = await withTenant(deps.db, tenantId, async (tx) => {
    const invoice = await getInvoice(tx, tenantId, invoiceId);
    if (!invoice) return null;

    const profile = await tx.query<{ billing_email: string | null; bank_details: string | null; legal_name: string }>(
      'select billing_email, bank_details, legal_name from billing_profiles where tenant_id = $1',
      [tenantId],
    );
    const tenant = await tx.query<{ name: string; billing_email: string | null }>(
      'select name, billing_email from tenants where id = $1', [tenantId]);

    return {
      invoice,
      to: profile[0]?.billing_email ?? tenant[0]?.billing_email ?? null,
      shopName: profile[0]?.legal_name ?? invoice.billToName ?? tenant[0]?.name ?? 'Pelanggan',
      bankDetails: profile[0]?.bank_details ?? null,
    };
  });

  if (!context) return { sent: false, skipped: 'no_invoice' };
  if (!context.to) return { sent: false, skipped: 'no_recipient' };

  const base = {
    shopName: context.shopName,
    number: context.invoice.number,
    totalIdr: context.invoice.totalIdr,
    dueAt: context.invoice.dueAt ?? new Date(),
    lines: context.invoice.lines.map((l) => ({ label: l.label, amountIdr: l.amountIdr })),
    bankDetails: context.bankDetails,
    to: context.to,
  };

  const message: EmailMessage =
    kind.kind === 'invoice_issued' ? invoiceIssuedEmail(base)
    : kind.kind === 'invoice_reminder'
      ? invoiceReminderEmail({ ...base, step: kind.step, daysOverdue: kind.daysOverdue })
      : paymentReceivedEmail({
          shopName: context.shopName, number: context.invoice.number,
          totalIdr: context.invoice.totalIdr, reference: kind.reference, to: context.to,
        });

  // Claim the send first. If the row already exists, this template has gone out
  // for this invoice and nothing is delivered twice.
  const claimed = await withTenant(deps.db, tenantId, (tx) =>
    tx.query<{ id: string }>(
      `insert into emails (tenant_id, template, recipient, subject, reference)
       values ($1,$2,$3,$4,$5)
       on conflict do nothing
       returning id`,
      [tenantId, message.template, message.to, message.subject, invoiceId],
    ));
  if (!claimed[0]) return { sent: false, skipped: 'already_sent', template: message.template };

  try {
    const result = await deps.sender.send(message);
    await withTenant(deps.db, tenantId, async (tx) => {
      await tx.query('update emails set message_id = $2 where id = $1', [claimed[0]!.id, result.messageId]);
      await audit(tx, tenantId, {
        actorType: 'system', action: 'email.sent', resourceType: 'invoice', resourceId: invoiceId,
        meta: { template: message.template, to: message.to },
      });
    });
    return { sent: true, template: message.template };
  } catch (err) {
    // A failed send is recorded as failed, which also frees the unique index so
    // the next run may try again.
    await withTenant(deps.db, tenantId, (tx) =>
      tx.query(`update emails set status = 'failed', error = $2 where id = $1`,
        [claimed[0]!.id, (err as Error).message.slice(0, 500)]));
    throw err;
  }
}
