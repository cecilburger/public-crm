import type { Ctx } from './repo.ts';
import { tenantKeys, sealField, openField } from './keys.ts';
import { audit } from './audit.ts';

export interface IgMetaConnection {
  status: 'disconnected' | 'connected' | 'error';
  igUsername: string | null;
  lastError: string | null;
  updatedAt: Date | null;
}

/** The access token is never returned here — only `getDecryptedIgToken` (for sending) ever decrypts it. */
export async function getIgMetaConnection(ctx: Ctx): Promise<IgMetaConnection> {
  const rows = await ctx.tx.query<{
    ig_username: string | null; status: IgMetaConnection['status']; last_error: string | null; updated_at: Date;
  }>(
    `select ig_username, status, last_error, updated_at from ig_meta_connections where tenant_id = $1`,
    [ctx.tenantId],
  );
  const row = rows[0];
  if (!row) return { status: 'disconnected', igUsername: null, lastError: null, updatedAt: null };
  return { status: row.status, igUsername: row.ig_username, lastError: row.last_error, updatedAt: row.updated_at };
}

/** The one place the real access token comes back out — for calling the Graph API, never for display. */
export async function getDecryptedIgToken(ctx: Ctx): Promise<{ accessToken: string; igUserId: string } | null> {
  const rows = await ctx.tx.query<{ access_token_enc: string | null; ig_user_id: string | null }>(
    `select access_token_enc, ig_user_id from ig_meta_connections where tenant_id = $1 and status = 'connected'`,
    [ctx.tenantId],
  );
  const row = rows[0];
  if (!row?.access_token_enc || !row.ig_user_id) return null;
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  return { accessToken: openField(keys, ctx.tenantId, row.access_token_enc), igUserId: row.ig_user_id };
}

export async function setIgMetaConnection(
  ctx: Ctx, args: { accessToken: string; igUserId: string; igUsername: string; actorId: string },
): Promise<void> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const tokenEnc = sealField(keys, ctx.tenantId, args.accessToken);

  await ctx.tx.query(
    `insert into ig_meta_connections (tenant_id, access_token_enc, ig_user_id, ig_username, status, last_error, updated_by)
     values ($1, $2, $3, $4, 'connected', null, $5)
     on conflict (tenant_id) do update set
       access_token_enc = excluded.access_token_enc, ig_user_id = excluded.ig_user_id,
       ig_username = excluded.ig_username, status = 'connected', last_error = null,
       updated_by = $5, updated_at = now()`,
    [ctx.tenantId, tokenEnc, args.igUserId, args.igUsername, args.actorId],
  );

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'ig_meta.connected',
    resourceType: 'tenant', resourceId: ctx.tenantId, meta: { igUsername: args.igUsername },
  });
}

export async function setIgMetaError(ctx: Ctx, args: { error: string; actorId: string }): Promise<void> {
  await ctx.tx.query(
    `insert into ig_meta_connections (tenant_id, status, last_error, updated_by)
     values ($1, 'error', $2, $3)
     on conflict (tenant_id) do update set status = 'error', last_error = $2, updated_by = $3, updated_at = now()`,
    [ctx.tenantId, args.error, args.actorId],
  );
}

export async function clearIgMetaConnection(ctx: Ctx, args: { actorId: string }): Promise<void> {
  await ctx.tx.query(
    `update ig_meta_connections
        set status = 'disconnected', access_token_enc = null, ig_user_id = null, ig_username = null,
            last_error = null, updated_by = $2, updated_at = now()
      where tenant_id = $1`,
    [ctx.tenantId, args.actorId],
  );
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'ig_meta.disconnected',
    resourceType: 'tenant', resourceId: ctx.tenantId,
  });
  await ctx.tx.query(
    `update channels set status = 'disabled' where tenant_id = $1 and kind = 'instagram'`,
    [ctx.tenantId],
  );
}

/**
 * The routing anchor for Chat IG — conversations/messages hang off this row,
 * not off `ig_meta_connections` directly, same as every other channel. The
 * token itself still only ever lives in `ig_meta_connections`; this row
 * carries no credential of its own.
 */
export async function ensureInstagramChannel(
  ctx: Ctx, args: { igUserId: string; igUsername: string },
): Promise<{ channelId: string }> {
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into channels (tenant_id, kind, display_name, external_id, status)
     values ($1, 'instagram', $2, $3, 'connected')
     on conflict (kind, external_id) where external_id is not null
     do update set display_name = excluded.display_name, status = 'connected', tenant_id = excluded.tenant_id
     returning id`,
    [ctx.tenantId, `@${args.igUsername}`, args.igUserId],
  );
  return { channelId: rows[0]!.id };
}
