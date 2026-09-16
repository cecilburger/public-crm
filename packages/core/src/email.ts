import { formatInvoiceIdr } from './invoicing.ts';

/**
 * Email, as a seam.
 *
 * SMTP rather than a specific vendor's API, because every provider a shop might
 * pick — SES, Mailgun, Resend, a Gmail relay — speaks it. Choosing one is a
 * connection string, not a rewrite.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Grouping key for the log: which template produced this. */
  template: string;
  /** What it is about — an invoice id, a user id — for support to trace. */
  reference?: string | null;
}

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

/** Development and tests: writes the message instead of delivering it. */
export class LogEmailSender implements EmailSender {
  readonly name = 'log';
  readonly sent: EmailMessage[] = [];

  constructor(private write: (line: string) => void = () => {}) {}

  async send(message: EmailMessage) {
    this.sent.push(message);
    this.write(`[email:${message.template}] to=${message.to} subject=${message.subject}`);
    return { messageId: `log-${this.sent.length}` };
  }
}

/**
 * SMTP delivery.
 *
 * Deliberately not a vendor SDK: SES, Mailgun, Resend, Postmark and a plain
 * Gmail relay all speak SMTP, so switching provider is a connection string.
 * Shared by both `apps/worker` (billing emails) and `apps/api` (sent
 * synchronously, for the "send now" actions a person is waiting on) rather
 * than living in just one of them.
 */
export class SmtpEmailSender implements EmailSender {
  readonly name = 'smtp';
  private transport: { sendMail: (opts: Record<string, unknown>) => Promise<{ messageId: string }> } | null = null;

  constructor(private url: string, private from: string) {}

  private async connect() {
    if (!this.transport) {
      const nodemailer = await import('nodemailer');
      const create = (nodemailer as { createTransport?: unknown; default?: { createTransport?: unknown } });
      const createTransport = (create.default?.createTransport ?? create.createTransport) as
        (url: string) => typeof this.transport;
      this.transport = createTransport(this.url);
    }
    return this.transport!;
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const transport = await this.connect();
    const result = await transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { messageId: result.messageId };
  }
}

/** Picks the real sender when `SMTP_URL` is configured, logs instead when it isn't. */
export function resolveSender(env: { SMTP_URL: string; EMAIL_FROM: string }): EmailSender {
  if (!env.SMTP_URL) {
    console.warn('SMTP_URL is not set — email is being logged, not delivered');
    return new LogEmailSender((line) => console.log(line));
  }
  return new SmtpEmailSender(env.SMTP_URL, env.EMAIL_FROM);
}

/**
 * Same as `resolveSender`, but a tenant's own SMTP settings (from Pengaturan)
 * win when they've set one — the server-wide `SMTP_URL` stays only as the
 * default for a tenant that never configured its own.
 */
export function resolveTenantSender(
  env: { SMTP_URL: string; EMAIL_FROM: string },
  tenant: { smtpUrl: string | null; emailFrom: string | null },
): EmailSender {
  return resolveSender({
    SMTP_URL: tenant.smtpUrl || env.SMTP_URL,
    EMAIL_FROM: tenant.emailFrom || env.EMAIL_FROM,
  });
}

/* ------------------------------------------------------------- templates */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const shell = (title: string, body: string) => `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#F4F4F9;font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#16183C;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E0DFEC;border-radius:12px;padding:24px">
${body}
<p style="color:#8A8DAC;font-size:12.5px;margin-top:24px;border-top:1px solid #E0DFEC;padding-top:14px">
MCNASIA · Software untuk toko yang tumbuh di dalam chat.</p>
</div></body></html>`;

const table = (rows: [string, string][]) => rows.map(([k, v]) =>
  `<tr><td style="padding:6px 0;color:#565A80">${escapeHtml(k)}</td>
       <td style="padding:6px 0;text-align:right;white-space:nowrap"><b>${escapeHtml(v)}</b></td></tr>`).join('');

export interface InvoiceEmailInput {
  shopName: string;
  number: string;
  totalIdr: number;
  dueAt: Date;
  lines: { label: string; amountIdr: number }[];
  bankDetails?: string | null;
  to: string;
}

const idDate = (d: Date) =>
  d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The invoice itself. Written the way a bill to an Indonesian small business
 * should read: what, how much, by when, and how to pay — in that order, with no
 * marketing.
 */
export function invoiceIssuedEmail(input: InvoiceEmailInput): EmailMessage {
  const lines = input.lines.map((l) => `  ${l.label}: ${formatInvoiceIdr(l.amountIdr)}`).join('\n');
  const bank = input.bankDetails ? `\n\nCara bayar:\n${input.bankDetails}` : '';

  const text = `Halo ${input.shopName},

Tagihan ${input.number} sudah terbit.

${lines}

Total: ${formatInvoiceIdr(input.totalIdr)} (sudah termasuk PPN)
Jatuh tempo: ${idDate(input.dueAt)}${bank}

Sebutkan nomor tagihan ${input.number} saat transfer supaya kami mudah mencocokkan.

Terima kasih,
MCNASIA`;

  const html = shell(`Tagihan ${input.number}`, `
    <h1 style="font-size:19px;margin:0 0 6px">Tagihan ${escapeHtml(input.number)}</h1>
    <p style="color:#565A80;margin:0">Halo ${escapeHtml(input.shopName)}, tagihan Anda sudah terbit.</p>
    <table style="width:100%;border-collapse:collapse;margin-top:18px;font-size:14px">
      ${table(input.lines.map((l) => [l.label, formatInvoiceIdr(l.amountIdr)] as [string, string]))}
      <tr><td style="padding:12px 0 0;border-top:2px solid #E0DFEC"><b>Total</b></td>
          <td style="padding:12px 0 0;border-top:2px solid #E0DFEC;text-align:right"><b>${escapeHtml(formatInvoiceIdr(input.totalIdr))}</b></td></tr>
    </table>
    <p style="margin-top:14px;color:#565A80">Jatuh tempo <b>${escapeHtml(idDate(input.dueAt))}</b> · sudah termasuk PPN</p>
    ${input.bankDetails ? `<div style="margin-top:16px;background:#F4F4F9;border-radius:8px;padding:12px;white-space:pre-wrap">${escapeHtml(input.bankDetails)}</div>` : ''}
    <p style="margin-top:14px;color:#565A80;font-size:13px">Sebutkan nomor tagihan <b>${escapeHtml(input.number)}</b> saat transfer supaya kami mudah mencocokkan.</p>`);

  return { to: input.to, subject: `Tagihan ${input.number} — ${formatInvoiceIdr(input.totalIdr)}`,
           text, html, template: 'invoice_issued' };
}

export interface ReminderEmailInput extends InvoiceEmailInput {
  daysOverdue: number;
  step: number;
}

/**
 * Reminders get firmer with each step, and none of them threaten. A shop that is
 * eleven days late has usually forgotten, not refused.
 */
export function invoiceReminderEmail(input: ReminderEmailInput): EmailMessage {
  const opener = input.step === 1
    ? `Sekadar mengingatkan, tagihan ${input.number} sudah lewat jatuh tempo ${input.daysOverdue} hari.`
    : input.step === 2
      ? `Tagihan ${input.number} masih belum kami terima, sudah ${input.daysOverdue} hari lewat jatuh tempo.`
      : `Tagihan ${input.number} sudah ${input.daysOverdue} hari lewat jatuh tempo. Mohon segera diselesaikan agar layanan tetap berjalan normal.`;

  const bank = input.bankDetails ? `\n\nCara bayar:\n${input.bankDetails}` : '';
  const text = `Halo ${input.shopName},

${opener}

Total: ${formatInvoiceIdr(input.totalIdr)}
Jatuh tempo: ${idDate(input.dueAt)}${bank}

Kalau sudah ditransfer, abaikan pesan ini — mungkin kami belum sempat mencocokkan.

Terima kasih,
MCNASIA`;

  const html = shell(`Pengingat tagihan ${input.number}`, `
    <h1 style="font-size:19px;margin:0 0 6px">Pengingat tagihan</h1>
    <p style="color:#565A80;margin:0">${escapeHtml(opener)}</p>
    <table style="width:100%;border-collapse:collapse;margin-top:18px;font-size:14px">
      ${table([['Total', formatInvoiceIdr(input.totalIdr)], ['Jatuh tempo', idDate(input.dueAt)]])}
    </table>
    ${input.bankDetails ? `<div style="margin-top:16px;background:#F4F4F9;border-radius:8px;padding:12px;white-space:pre-wrap">${escapeHtml(input.bankDetails)}</div>` : ''}
    <p style="margin-top:14px;color:#8A8DAC;font-size:13px">Kalau sudah ditransfer, abaikan pesan ini — mungkin kami belum sempat mencocokkan.</p>`);

  return { to: input.to, subject: `Pengingat: tagihan ${input.number} jatuh tempo ${idDate(input.dueAt)}`,
           text, html, template: `invoice_reminder_${input.step}` };
}

export function paymentReceivedEmail(input: {
  shopName: string; number: string; totalIdr: number; reference: string; to: string;
}): EmailMessage {
  const text = `Halo ${input.shopName},

Pembayaran untuk tagihan ${input.number} sebesar ${formatInvoiceIdr(input.totalIdr)} sudah kami terima.
Referensi: ${input.reference}

Terima kasih,
MCNASIA`;

  const html = shell(`Pembayaran diterima — ${input.number}`, `
    <h1 style="font-size:19px;margin:0 0 6px">Pembayaran diterima</h1>
    <p style="color:#565A80;margin:0">Terima kasih, tagihan ${escapeHtml(input.number)} sudah lunas.</p>
    <table style="width:100%;border-collapse:collapse;margin-top:18px;font-size:14px">
      ${table([['Jumlah', formatInvoiceIdr(input.totalIdr)], ['Referensi', input.reference]])}
    </table>`);

  return { to: input.to, subject: `Pembayaran diterima — ${input.number}`, text, html,
           template: 'payment_received' };
}

export interface MeetingInviteEmailInput {
  /** Who the meeting is with — the task's brand or contact name. */
  partyName: string;
  title: string;
  dueAt: Date;
  meetingLink?: string | null;
  notes?: string | null;
  to: string;
}

const idDateTime = (d: Date) =>
  `${d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} WIB`;

/** A meeting task, sent as a plain invite — when, who it's about, and the link if there is one. */
export function meetingInviteEmail(input: MeetingInviteEmailInput): EmailMessage {
  const when = idDateTime(input.dueAt);
  const link = input.meetingLink ? `\n\nLink meeting: ${input.meetingLink}` : '';
  const notes = input.notes ? `\n\nCatatan:\n${input.notes}` : '';

  const text = `Undangan meeting: ${input.title}

Dengan: ${input.partyName}
Waktu: ${when}${link}${notes}

Sampai jumpa,
MCNASIA`;

  const html = shell(input.title, `
    <h1 style="font-size:19px;margin:0 0 6px">${escapeHtml(input.title)}</h1>
    <p style="color:#565A80;margin:0">Undangan meeting dengan ${escapeHtml(input.partyName)}</p>
    <table style="width:100%;border-collapse:collapse;margin-top:18px;font-size:14px">
      ${table([
        ['Waktu', when],
        ...(input.meetingLink ? [['Link meeting', input.meetingLink] as [string, string]] : []),
      ])}
    </table>
    ${input.notes ? `<div style="margin-top:16px;background:#F4F4F9;border-radius:8px;padding:12px;white-space:pre-wrap">${escapeHtml(input.notes)}</div>` : ''}`);

  return { to: input.to, subject: `Undangan meeting: ${input.title} — ${when}`, text, html, template: 'meeting_invite' };
}
