import type { Ctx } from './repo.ts';
import { tenantKeys, sealField, openField } from './keys.ts';
import { audit } from './audit.ts';
import { divisionSql } from './divisions.ts';

export interface IgBridgeConnection {
  /**
   * `awaiting_login` is the browser-login flow only: a real Chromium window is
   * open on the bridge's machine and a person is part-way through Instagram's
   * own login. Unlike `challenge_required`, the CRM is not in that loop and has
   * nothing to collect — it only waits and polls.
   */
  status: 'disconnected' | 'awaiting_login' | 'challenge_required' | 'ready' | 'error';
  username: string | null;
  challengeType: 'two_factor' | 'checkpoint' | 'unknown' | null;
  lastError: string | null;
  updatedAt: Date | null;
  /**
   * What `apps/ig-bridge` files this division's Chromium profile under. Null
   * only while no row exists yet — the bridge is never addressed before one
   * does (see `setIgBridgeConnection`).
   */
  sessionKey: string | null;
}


/** Username is only ever kept for display — the password itself never reaches this table. */
export async function getIgBridgeConnection(ctx: Ctx): Promise<IgBridgeConnection> {
  const rows = await ctx.tx.query<{
    username_enc: string | null; status: IgBridgeConnection['status'];
    challenge_type: IgBridgeConnection['challengeType']; last_error: string | null; updated_at: Date;
    session_key: string;
  }>(
    `select username_enc, status, challenge_type, last_error, updated_at, session_key
       from ig_bridge_connections
      where tenant_id = $1 and division_id = ${divisionSql(2)}`,
    [ctx.tenantId, ctx.divisionId ?? null],
  );
  const row = rows[0];
  if (!row) {
    return { status: 'disconnected', username: null, challengeType: null, lastError: null, updatedAt: null, sessionKey: null };
  }

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  return {
    status: row.status,
    username: row.username_enc ? openField(keys, ctx.tenantId, row.username_enc) : null,
    challengeType: row.challenge_type,
    lastError: row.last_error,
    updatedAt: row.updated_at,
    sessionKey: row.session_key,
  };
}

/**
 * One upsert per step of the login flow (attempt started, challenge posed,
 * ready, or failed) — `apps/api`'s route calls this right after each
 * synchronous round trip to `apps/ig-bridge`, so this table is always a
 * mirror of whatever the bridge just reported, never a queue of its own.
 *
 * Returns the session key the bridge must be addressed by for this division;
 * the first call for a division mints the row and therefore the key.
 */
export async function setIgBridgeConnection(
  ctx: Ctx,
  args: {
    status: IgBridgeConnection['status']; username?: string | null;
    challengeType?: IgBridgeConnection['challengeType']; lastError?: string | null; actorId: string;
  },
): Promise<{ sessionKey: string }> {
  const usernameEnc = args.username === undefined
    ? undefined
    : args.username
      ? sealField(await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId), ctx.tenantId, args.username)
      : null;

  const division = divisionSql(8);
  const rows = await ctx.tx.query<{ session_key: string }>(
    `insert into ig_bridge_connections
       (tenant_id, division_id, session_key, username_enc, status, challenge_type, last_error, updated_by)
     values ($1, ${division}, app_bridge_session_key(${division}), $2, $3, $4, $5, $6)
     on conflict (tenant_id, division_id) do update set
       username_enc = case when $7 then excluded.username_enc else ig_bridge_connections.username_enc end,
       status = excluded.status, challenge_type = excluded.challenge_type, last_error = excluded.last_error,
       updated_by = $6, updated_at = now()
     returning session_key`,
    [
      ctx.tenantId, usernameEnc ?? null, args.status, args.challengeType ?? null, args.lastError ?? null,
      args.actorId, usernameEnc !== undefined, ctx.divisionId ?? null,
    ],
  );

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'ig_bridge.status_changed',
    resourceType: 'tenant', resourceId: ctx.tenantId, meta: { status: args.status },
  });
  return { sessionKey: rows[0]!.session_key };
}

/**
 * The routing anchor for Chat IG's bridge-sourced messages — same idea as
 * `ensureInstagramChannel` for the official API, but its own `kind` so a
 * tenant can run both connections side by side without their conversations
 * colliding on the same channel row. External identity is the @username
 * (the private API's IGSID-equivalent is per-app, not something this
 * account-level connection has), refreshed on every successful login in
 * case the same account is reconnected under a changed handle.
 *
 * The channel lands in the transaction's division. A handle already owned by
 * another division must be refused before this runs (`channelHome`): the
 * upsert cannot see that row under row-level security, let alone move it.
 */
export async function ensureInstagramBridgeChannel(
  ctx: Ctx, args: { username: string },
): Promise<{ channelId: string }> {
  // A blank handle is not an identity, and `external_id` is what this row is
  // keyed on. Confirmed live: one login whose username could not be read
  // inserted a second `instagram_bridge` channel with `external_id = ''`,
  // displayed as "@". Because a conversation is unique per (contact, channel),
  // the same person's thread then split in two — new messages landed in a
  // conversation nobody was looking at, which reads exactly like inbound
  // Instagram having stopped working.
  const username = args.username.trim();
  if (!username) {
    throw new Error('Tidak bisa membuat channel Instagram tanpa username — sesi harus punya identitas akun');
  }

  const rows = await ctx.tx.query<{ id: string }>(
    `insert into channels (tenant_id, kind, display_name, external_id, status)
     values ($1, 'instagram_bridge', $2, $3, 'connected')
     on conflict (kind, external_id) where external_id is not null
     do update set display_name = excluded.display_name, status = 'connected', tenant_id = excluded.tenant_id
     returning id`,
    [ctx.tenantId, `@${username}`, username],
  );
  return { channelId: rows[0]!.id };
}

/**
 * The bridge channel this division reads Instagram DMs on, or null. Oldest
 * live one first, so a reconnect that left a disabled row behind does not
 * hide the working channel.
 */
export async function findInstagramBridgeChannel(ctx: Ctx): Promise<{ channelId: string } | null> {
  const rows = await ctx.tx.query<{ id: string }>(
    `select id from channels
      where tenant_id = $1 and kind = 'instagram_bridge'
        and division_id = ${divisionSql(2)}
      order by (status = 'disabled'), created_at
      limit 1`,
    [ctx.tenantId, ctx.divisionId ?? null],
  );
  return rows[0] ? { channelId: rows[0].id } : null;
}

export async function clearIgBridgeConnection(ctx: Ctx, args: { actorId: string }): Promise<void> {
  const division = divisionSql(3);
  await ctx.tx.query(
    `update ig_bridge_connections
        set status = 'disconnected', username_enc = null, challenge_type = null, last_error = null,
            updated_by = $2, updated_at = now()
      where tenant_id = $1 and division_id = ${division}`,
    [ctx.tenantId, args.actorId, ctx.divisionId ?? null],
  );
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'ig_bridge.disconnected',
    resourceType: 'tenant', resourceId: ctx.tenantId,
  });
  await ctx.tx.query(
    `update channels set status = 'disabled'
      where tenant_id = $1 and kind = 'instagram_bridge' and division_id = ${divisionSql(2)}`,
    [ctx.tenantId, ctx.divisionId ?? null],
  );
}
