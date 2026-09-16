import type { Ctx } from './repo.ts';
import { tenantKeys, sealField, openField } from './keys.ts';
import { audit } from './audit.ts';

export interface TenantEmailSettings {
  configured: boolean;
  emailFrom: string | null;
  updatedAt: Date | null;
}

/**
 * Never returns the decrypted SMTP URL — the settings page only needs to
 * know whether one is already on file, not to redisplay a credential once
 * it's been saved. Sending is the one path allowed to decrypt it, via
 * `getDecryptedSmtpUrl` below.
 */
export async function getTenantEmailSettings(ctx: Ctx): Promise<TenantEmailSettings> {
  const rows = await ctx.tx.query<{ smtp_url_enc: string | null; email_from: string | null; updated_at: Date }>(
    'select smtp_url_enc, email_from, updated_at from tenant_email_settings where tenant_id = $1',
    [ctx.tenantId],
  );
  const row = rows[0];
  if (!row) return { configured: false, emailFrom: null, updatedAt: null };
  return { configured: !!row.smtp_url_enc, emailFrom: row.email_from, updatedAt: row.updated_at };
}

/** The one place the real connection string comes back out — for sending, never for display. */
export async function getDecryptedSmtpUrl(ctx: Ctx): Promise<{ smtpUrl: string | null; emailFrom: string | null }> {
  const rows = await ctx.tx.query<{ smtp_url_enc: string | null; email_from: string | null }>(
    'select smtp_url_enc, email_from from tenant_email_settings where tenant_id = $1',
    [ctx.tenantId],
  );
  const row = rows[0];
  if (!row?.smtp_url_enc) return { smtpUrl: null, emailFrom: row?.email_from ?? null };
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  return { smtpUrl: openField(keys, ctx.tenantId, row.smtp_url_enc), emailFrom: row.email_from };
}

/**
 * `smtpUrl` left `undefined` keeps whatever is already stored — the form
 * only sends a new value when the agent actually typed one, exactly like
 * leaving an API key field blank means "don't change it".
 */
export async function setTenantEmailSettings(
  ctx: Ctx, args: { smtpUrl?: string | null; emailFrom?: string | null; actorId: string },
): Promise<void> {
  const smtpUrlEnc = args.smtpUrl === undefined
    ? undefined
    : args.smtpUrl
      ? sealField(await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId), ctx.tenantId, args.smtpUrl)
      : null;

  await ctx.tx.query(
    `insert into tenant_email_settings (tenant_id, smtp_url_enc, email_from, updated_by)
     values ($1, $2, $3, $4)
     on conflict (tenant_id) do update set
       smtp_url_enc = case when $5 then excluded.smtp_url_enc else tenant_email_settings.smtp_url_enc end,
       email_from = case when $6 then excluded.email_from else tenant_email_settings.email_from end,
       updated_by = $4, updated_at = now()`,
    [
      ctx.tenantId, smtpUrlEnc ?? null, args.emailFrom ?? null, args.actorId,
      smtpUrlEnc !== undefined, args.emailFrom !== undefined,
    ],
  );

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'email_settings.updated',
    resourceType: 'tenant', resourceId: ctx.tenantId,
    meta: { smtpUrlChanged: args.smtpUrl !== undefined, emailFromChanged: args.emailFrom !== undefined },
  });
}
