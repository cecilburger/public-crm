import type { Ctx } from './repo.ts';
import { tenantKeys, sealField, openField } from './keys.ts';
import { audit } from './audit.ts';

export interface IgBridgeConnection {
  status: 'disconnected' | 'challenge_required' | 'ready' | 'error';
  username: string | null;
  challengeType: 'two_factor' | 'checkpoint' | 'unknown' | null;
  lastError: string | null;
  updatedAt: Date | null;
}

/** Username is only ever kept for display — the password itself never reaches this table. */
export async function getIgBridgeConnection(ctx: Ctx): Promise<IgBridgeConnection> {
  const rows = await ctx.tx.query<{
    username_enc: string | null; status: IgBridgeConnection['status'];
    challenge_type: IgBridgeConnection['challengeType']; last_error: string | null; updated_at: Date;
  }>(
    `select username_enc, status, challenge_type, last_error, updated_at
       from ig_bridge_connections where tenant_id = $1`,
    [ctx.tenantId],
  );
  const row = rows[0];
  if (!row) return { status: 'disconnected', username: null, challengeType: null, lastError: null, updatedAt: null };

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  return {
    status: row.status,
    username: row.username_enc ? openField(keys, ctx.tenantId, row.username_enc) : null,
    challengeType: row.challenge_type,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

/**
 * One upsert per step of the login flow (attempt started, challenge posed,
 * ready, or failed) — `apps/api`'s route calls this right after each
 * synchronous round trip to `apps/ig-bridge`, so this table is always a
 * mirror of whatever the bridge just reported, never a queue of its own.
 */
export async function setIgBridgeConnection(
  ctx: Ctx,
  args: {
    status: IgBridgeConnection['status']; username?: string | null;
    challengeType?: IgBridgeConnection['challengeType']; lastError?: string | null; actorId: string;
  },
): Promise<void> {
  const usernameEnc = args.username === undefined
    ? undefined
    : args.username
      ? sealField(await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId), ctx.tenantId, args.username)
      : null;

  await ctx.tx.query(
    `insert into ig_bridge_connections (tenant_id, username_enc, status, challenge_type, last_error, updated_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id) do update set
       username_enc = case when $7 then excluded.username_enc else ig_bridge_connections.username_enc end,
       status = excluded.status, challenge_type = excluded.challenge_type, last_error = excluded.last_error,
       updated_by = $6, updated_at = now()`,
    [
      ctx.tenantId, usernameEnc ?? null, args.status, args.challengeType ?? null, args.lastError ?? null,
      args.actorId, usernameEnc !== undefined,
    ],
  );

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'ig_bridge.status_changed',
    resourceType: 'tenant', resourceId: ctx.tenantId, meta: { status: args.status },
  });
}

/**
 * The routing anchor for Chat IG's bridge-sourced messages — same idea as
 * `ensureInstagramChannel` for the official API, but its own `kind` so a
 * tenant can run both connections side by side without their conversations
 * colliding on the same channel row. External identity is the @username
 * (the private API's IGSID-equivalent is per-app, not something this
 * account-level connection has), refreshed on every successful login in
 * case the same account is reconnected under a changed handle.
 */
export async function ensureInstagramBridgeChannel(
  ctx: Ctx, args: { username: string },
): Promise<{ channelId: string }> {
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into channels (tenant_id, kind, display_name, external_id, status)
     values ($1, 'instagram_bridge', $2, $3, 'connected')
     on conflict (kind, external_id) where external_id is not null
     do update set display_name = excluded.display_name, status = 'connected', tenant_id = excluded.tenant_id
     returning id`,
    [ctx.tenantId, `@${args.username}`, args.username],
  );
  return { channelId: rows[0]!.id };
}

export async function clearIgBridgeConnection(ctx: Ctx, args: { actorId: string }): Promise<void> {
  await ctx.tx.query(
    `update ig_bridge_connections
        set status = 'disconnected', username_enc = null, challenge_type = null, last_error = null,
            updated_by = $2, updated_at = now()
      where tenant_id = $1`,
    [ctx.tenantId, args.actorId],
  );
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'ig_bridge.disconnected',
    resourceType: 'tenant', resourceId: ctx.tenantId,
  });
  await ctx.tx.query(
    `update channels set status = 'disabled' where tenant_id = $1 and kind = 'instagram_bridge'`,
    [ctx.tenantId],
  );
}
