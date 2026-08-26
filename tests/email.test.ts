import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  invoiceIssuedEmail, invoiceReminderEmail, paymentReceivedEmail, LogEmailSender,
} from '@kirana/core';
import { withTenant, issueInvoiceForPeriod, type Database } from '@kirana/db';
import { sendBillingEmail } from '../apps/worker/src/email/send.ts';
import { runDunning } from '../apps/worker/src/processors/billingRollup.ts';
import { freshDb, makeTenant, type TestTenant } from './helpers/db.ts';

const DAY = 86_400_000;
const base = {
  shopName: 'PT Toko Demo', number: 'KIR/2026/000001', totalIdr: 4_329_000,
  dueAt: new Date('2026-09-09T00:00:00Z'),
  lines: [{ label: 'Growth — 3.000 chats', amountIdr: 3_900_000 }],
  bankDetails: 'BCA 1234567890 a.n. PT Toko Demo',
  to: 'owner@toko.id',
};

describe('what the shop actually receives', () => {
  it('states the amount, the date and how to pay — in that order', () => {
    const mail = invoiceIssuedEmail(base);
    expect(mail.subject).toBe('Tagihan KIR/2026/000001 — Rp 4.329.000');
    expect(mail.text).toContain('Rp 4.329.000');
    expect(mail.text).toContain('9 September 2026');
    expect(mail.text).toContain('BCA 1234567890');
    expect(mail.text.indexOf('Total')).toBeLessThan(mail.text.indexOf('Cara bayar'));
  });

  it('asks them to quote the invoice number, so reconciliation is possible', () => {
    expect(invoiceIssuedEmail(base).text).toContain('Sebutkan nomor tagihan KIR/2026/000001');
  });

  it('escapes anything a shop typed into its own name', () => {
    const nasty = invoiceIssuedEmail({ ...base, shopName: 'Toko <script>alert(1)</script>' });
    expect(nasty.html).not.toContain('<script>');
    expect(nasty.html).toContain('&lt;script&gt;');
  });

  it('sends both a text and an HTML part', () => {
    const mail = invoiceIssuedEmail(base);
    expect(mail.text.length).toBeGreaterThan(50);
    expect(mail.html).toContain('<!doctype html>');
  });

  it('gets firmer with each reminder without ever threatening', () => {
    const first = invoiceReminderEmail({ ...base, step: 1, daysOverdue: 3 });
    const third = invoiceReminderEmail({ ...base, step: 3, daysOverdue: 14 });

    expect(first.text).toContain('Sekadar mengingatkan');
    expect(third.text).toContain('Mohon segera diselesaikan');
    expect(first.template).toBe('invoice_reminder_1');
    expect(third.template).toBe('invoice_reminder_3');
    for (const mail of [first, third]) {
      expect(mail.text).not.toMatch(/tuntut|hukum|denda/i);
      // Somebody who already paid should not be made to feel accused.
      expect(mail.text).toContain('Kalau sudah ditransfer, abaikan pesan ini');
    }
  });

  it('confirms a payment with the reference the operator recorded', () => {
    const mail = paymentReceivedEmail({
      shopName: 'PT Toko Demo', number: 'KIR/2026/000001',
      totalIdr: 4_329_000, reference: 'BCA/8891', to: 'owner@toko.id',
    });
    expect(mail.subject).toContain('Pembayaran diterima');
    expect(mail.text).toContain('BCA/8891');
  });
});

describe('delivering it', () => {
  let db: Database;
  let t: TestTenant;
  let sender: LogEmailSender;
  let invoiceId = '';

  const setup = async (billingEmail: string | null) => {
    await withTenant(db, t.tenantId, async (tx) => {
      if (billingEmail) {
        await tx.query(
          `insert into billing_profiles (tenant_id, legal_name, billing_email, bank_details)
           values ($1, 'PT Toko Demo', $2, 'BCA 1234567890')`,
          [t.tenantId, billingEmail]);
      }
      const period = await tx.query<{ id: string }>(
        `insert into billing_periods (tenant_id, starts_at, ends_at, plan_code)
         values ($1, now() - interval '30 days', now(), 'growth') returning id`, [t.tenantId]);
      const invoice = await issueInvoiceForPeriod(tx, t.tenantId, {
        billingPeriodId: period[0]!.id,
        lines: [{ key: 'plan', label: 'Growth', qty: 1, unitIdr: 3_900_000, amountIdr: 3_900_000 }],
      });
      invoiceId = invoice!.id;
    });
  };

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'mail');
    sender = new LogEmailSender();
  });
  afterEach(async () => { await db.close(); });

  it('sends the invoice to the billing address on file', async () => {
    await setup('billing@toko.id');
    const result = await sendBillingEmail({ db, sender }, t.tenantId, invoiceId, { kind: 'invoice_issued' });

    expect(result).toEqual({ sent: true, template: 'invoice_issued' });
    expect(sender.sent[0]!.to).toBe('billing@toko.id');
    expect(sender.sent[0]!.text).toContain('BCA 1234567890');
  });

  it('never mails the same invoice twice, however many times the job retries', async () => {
    await setup('billing@toko.id');
    const deps = { db, sender };
    await sendBillingEmail(deps, t.tenantId, invoiceId, { kind: 'invoice_issued' });
    const again = await sendBillingEmail(deps, t.tenantId, invoiceId, { kind: 'invoice_issued' });

    expect(again).toMatchObject({ sent: false, skipped: 'already_sent' });
    expect(sender.sent).toHaveLength(1);
  });

  it('treats each reminder step as its own message', async () => {
    await setup('billing@toko.id');
    const deps = { db, sender };
    await sendBillingEmail(deps, t.tenantId, invoiceId, { kind: 'invoice_reminder', step: 1, daysOverdue: 3 });
    await sendBillingEmail(deps, t.tenantId, invoiceId, { kind: 'invoice_reminder', step: 2, daysOverdue: 7 });
    await sendBillingEmail(deps, t.tenantId, invoiceId, { kind: 'invoice_reminder', step: 1, daysOverdue: 3 });

    expect(sender.sent.map((m) => m.template)).toEqual(['invoice_reminder_1', 'invoice_reminder_2']);
  });

  it('says so plainly when there is nowhere to send it', async () => {
    await setup(null);
    await withTenant(db, t.tenantId, (tx) =>
      tx.query('update tenants set billing_email = null where id = $1', [t.tenantId]));

    const result = await sendBillingEmail({ db, sender }, t.tenantId, invoiceId, { kind: 'invoice_issued' });
    expect(result).toEqual({ sent: false, skipped: 'no_recipient' });
    expect(sender.sent).toHaveLength(0);
  });

  it('records what was sent, so support can answer "did they get it?"', async () => {
    await setup('billing@toko.id');
    await sendBillingEmail({ db, sender }, t.tenantId, invoiceId, { kind: 'invoice_issued' });

    const log = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ template: string; recipient: string; status: string; message_id: string | null }>(
        'select template, recipient, status, message_id from emails'));
    expect(log[0]).toMatchObject({
      template: 'invoice_issued', recipient: 'billing@toko.id', status: 'sent',
    });
    expect(log[0]!.message_id).not.toBeNull();
  });

  it('marks a failed send failed, and lets the next run try again', async () => {
    await setup('billing@toko.id');
    const broken = {
      name: 'broken',
      send: async () => { throw new Error('SMTP 421 service unavailable'); },
    };

    await expect(sendBillingEmail({ db, sender: broken }, t.tenantId, invoiceId, { kind: 'invoice_issued' }))
      .rejects.toThrow(/421/);

    const failed = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string; error: string }>('select status, error from emails'));
    expect(failed[0]!.status).toBe('failed');

    // The unique index only covers successful sends, so a retry is possible.
    const retry = await sendBillingEmail({ db, sender }, t.tenantId, invoiceId, { kind: 'invoice_issued' });
    expect(retry.sent).toBe(true);
  });

  it('mails a reminder as part of the dunning run, matching the step', async () => {
    await setup('billing@toko.id');
    await withTenant(db, t.tenantId, (tx) =>
      tx.query(`update invoices set due_at = now() - interval '8 days' where tenant_id = $1`, [t.tenantId]));

    const outcomes = await runDunning(db, db, undefined, new Date(), { db, sender });
    expect(outcomes[0]!.action).toBe('remind');
    expect(sender.sent[0]!.template).toBe('invoice_reminder_1');
    expect(sender.sent[0]!.text).toContain('8 hari');
  });
});
