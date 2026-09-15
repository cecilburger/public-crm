import type { Ctx } from './repo.ts';
import { tenantKeys, sealField, openField } from './keys.ts';

export interface GoogleCalendarTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  email: string | null;
}

/** Upserts on (tenant_id, user_id) — reconnecting the same account just refreshes the stored tokens. */
export async function saveGoogleCalendarConnection(
  ctx: Ctx, args: { userId: string; tokens: GoogleCalendarTokens },
): Promise<void> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const accessEnc = sealField(keys, ctx.tenantId, args.tokens.accessToken);
  const refreshEnc = sealField(keys, ctx.tenantId, args.tokens.refreshToken);
  await ctx.tx.query(
    `insert into google_calendar_connections
       (tenant_id, user_id, google_email, access_token_enc, refresh_token_enc, token_expires_at)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (tenant_id, user_id) do update set
       google_email = excluded.google_email, access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc, token_expires_at = excluded.token_expires_at,
       updated_at = now()`,
    [ctx.tenantId, args.userId, args.tokens.email, accessEnc, refreshEnc, args.tokens.expiresAt],
  );
}

/** Only the access token changes on a refresh — the refresh token itself is long-lived and reused. */
export async function updateGoogleCalendarAccessToken(
  ctx: Ctx, args: { userId: string; accessToken: string; expiresAt: Date },
): Promise<void> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const accessEnc = sealField(keys, ctx.tenantId, args.accessToken);
  await ctx.tx.query(
    `update google_calendar_connections
        set access_token_enc = $3, token_expires_at = $4, updated_at = now()
      where tenant_id = $1 and user_id = $2`,
    [ctx.tenantId, args.userId, accessEnc, args.expiresAt],
  );
}

export interface GoogleCalendarConnection {
  googleEmail: string | null; accessToken: string; refreshToken: string; expiresAt: Date;
}

export async function getGoogleCalendarConnection(
  ctx: Ctx, args: { userId: string },
): Promise<GoogleCalendarConnection | null> {
  const rows = await ctx.tx.query<{
    google_email: string | null; access_token_enc: string; refresh_token_enc: string; token_expires_at: Date;
  }>(
    `select google_email, access_token_enc, refresh_token_enc, token_expires_at
       from google_calendar_connections where tenant_id = $1 and user_id = $2`,
    [ctx.tenantId, args.userId],
  );
  const row = rows[0];
  if (!row) return null;
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  return {
    googleEmail: row.google_email,
    accessToken: openField(keys, ctx.tenantId, row.access_token_enc),
    refreshToken: openField(keys, ctx.tenantId, row.refresh_token_enc),
    expiresAt: row.token_expires_at,
  };
}

export async function deleteGoogleCalendarConnection(ctx: Ctx, args: { userId: string }): Promise<void> {
  await ctx.tx.query(
    `delete from google_calendar_connections where tenant_id = $1 and user_id = $2`,
    [ctx.tenantId, args.userId],
  );
}
