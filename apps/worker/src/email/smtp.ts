import type { EmailMessage, EmailSender } from '@kirana/core';

/**
 * SMTP delivery.
 *
 * Deliberately not a vendor SDK: SES, Mailgun, Resend, Postmark and a plain
 * Gmail relay all speak SMTP, so switching provider is a connection string.
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
