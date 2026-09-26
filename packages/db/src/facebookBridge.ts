import { ensureConversation, isOwnEcho, type Ctx, type InboundResult } from './repo.ts';
import { tenantKeys, sealField, openField, fieldIndex, type TenantKeys } from './keys.ts';
import { recordConversationActivity } from './metering.ts';
import { audit } from './audit.ts';
import { divisionSql } from './divisions.ts';

/**
 * Everything the Facebook side of the CRM writes, in one module.
 *
 * Deliberately not in `repo.ts`: that file is already 1100 lines and is touched
 * by every other channel's work at once, so a whole new provider landing in it
 * is a merge conflict waiting to happen. The functions here call the same
 * shared primitives `repo.ts` uses (`ensureConversation`,
 * `recordConversationActivity`, the sealing helpers) rather than reimplementing
 * them, so a Messenger DM ends up in exactly the same rows a WhatsApp or
 * Instagram one does.
 *
 * Inbound only. There is no send function here, and that is not an oversight —
 * `apps/fb-bridge` cannot send, and `apps/worker`'s `outboundSend` has no
 * `messenger_bridge` branch, so anything queued outbound on this channel would
 * fall through to the Meta Graph path the whole feature exists to avoid.
 */

/* ------------------------------------------------------------- connection */

export interface FbBridgeConnection {
  status: 'disconnected' | 'awaiting_login' | 'ready' | 'checkpoint_required' | 'error';
  pageId: string | null;
  pageName: string | null;
  /**
   * The Business Suite asset id, when this connection is a Page.
   *
   * Null means a personal-account connection, read from messenger.com. Its
   * presence is what puts the bridge on the Page inbox instead, so this single
   * value decides which of two entirely different Facebook surfaces a tenant's
   * conversations are read from. Deliberately distinct from `pageId` — see
   * migration 0051.
   */
  assetId: string | null;
  lastError: string | null;
  lastSeenAt: Date | null;
  updatedAt: Date | null;
  /**
   * What `apps/fb-bridge` files this division's Chromium profile under. Null
   * only while no row exists yet — the bridge is never addressed before one
   * does (see `setFbBridgeConnection`).
   */
  sessionKey: string | null;
}


/**
 * A mirror of whatever `apps/fb-bridge` last reported, never a queue of its
 * own — same contract as `getIgBridgeConnection`. No credential is stored
 * here: the operator logs in by hand in a real browser window and the session
 * lives only as a Chromium profile on the bridge's disk, so losing this row
 * loses the "who is connected" display and nothing else.
 */
export async function getFbBridgeConnection(ctx: Ctx): Promise<FbBridgeConnection> {
  const rows = await ctx.tx.query<{
    page_id: string | null; page_name: string | null; asset_id: string | null;
    status: FbBridgeConnection['status'];
    last_error: string | null; last_seen_at: Date | null; updated_at: Date; session_key: string;
  }>(
    `select page_id, page_name, asset_id, status, last_error, last_seen_at, updated_at, session_key
       from fb_bridge_connections
      where tenant_id = $1 and division_id = ${divisionSql(2)}`,
    [ctx.tenantId, ctx.divisionId ?? null],
  );
  const row = rows[0];
  if (!row) {
    return {
      status: 'disconnected', pageId: null, pageName: null, assetId: null,
      lastError: null, lastSeenAt: null, updatedAt: null, sessionKey: null,
    };
  }
  return {
    status: row.status, pageId: row.page_id, pageName: row.page_name, assetId: row.asset_id,
    lastError: row.last_error, lastSeenAt: row.last_seen_at, updatedAt: row.updated_at,
    sessionKey: row.session_key,
  };
}

/**
 * `pageId`/`pageName` left `undefined` keep whatever is already stored — a
 * status transition ('ready' → 'error' when a session expires, say) should not
 * blank out the Page the operator connected, which is the only thing that
 * still identifies the row afterwards.
 */
export async function setFbBridgeConnection(
  ctx: Ctx,
  args: {
    status: FbBridgeConnection['status']; pageId?: string | null; pageName?: string | null;
    assetId?: string | null;
    lastError?: string | null; lastSeenAt?: Date | null; actorId: string | null;
  },
): Promise<{ sessionKey: string }> {
  // Returns the key the bridge must be addressed by for this division: the
  // first call for a division mints the row, and with it the key.
  const division = divisionSql(12);
  const rows = await ctx.tx.query<{ session_key: string }>(
    `insert into fb_bridge_connections
       (tenant_id, division_id, session_key, page_id, page_name, asset_id, status, last_error, last_seen_at, updated_by)
     values ($1, ${division}, app_bridge_session_key(${division}), $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id, division_id) do update set
       page_id = case when $9 then excluded.page_id else fb_bridge_connections.page_id end,
       page_name = case when $10 then excluded.page_name else fb_bridge_connections.page_name end,
       asset_id = case when $11 then excluded.asset_id else fb_bridge_connections.asset_id end,
       status = excluded.status, last_error = excluded.last_error,
       last_seen_at = coalesce(excluded.last_seen_at, fb_bridge_connections.last_seen_at),
       updated_by = $8, updated_at = now()
     returning session_key`,
    [
      ctx.tenantId, args.pageId ?? null, args.pageName ?? null, args.assetId ?? null, args.status,
      args.lastError ?? null, args.lastSeenAt ?? null, args.actorId,
      args.pageId !== undefined, args.pageName !== undefined, args.assetId !== undefined,
      ctx.divisionId ?? null,
    ],
  );

  await audit(ctx.tx, ctx.tenantId, {
    actorType: args.actorId ? 'user' : 'system', actorId: args.actorId, action: 'fb_bridge.status_changed',
    resourceType: 'tenant', resourceId: ctx.tenantId, meta: { status: args.status },
  });
  return { sessionKey: rows[0]!.session_key };
}

export async function clearFbBridgeConnection(ctx: Ctx, args: { actorId: string | null }): Promise<void> {
  await ctx.tx.query(
    `update fb_bridge_connections
        set status = 'disconnected', page_id = null, page_name = null, last_error = null,
            updated_by = $2, updated_at = now()
      where tenant_id = $1 and division_id = ${divisionSql(3)}`,
    [ctx.tenantId, args.actorId, ctx.divisionId ?? null],
  );
  await audit(ctx.tx, ctx.tenantId, {
    actorType: args.actorId ? 'user' : 'system', actorId: args.actorId, action: 'fb_bridge.disconnected',
    resourceType: 'tenant', resourceId: ctx.tenantId,
  });
  await ctx.tx.query(
    `update channels set status = 'disabled'
      where tenant_id = $1 and kind = 'messenger_bridge' and division_id = ${divisionSql(2)}`,
    [ctx.tenantId, ctx.divisionId ?? null],
  );
}

/**
 * The routing anchor for Messenger DMs read off the real facebook.com UI. Its
 * external identity is the Page id, which is what the operator's own browser
 * session is scoped to — refreshed on every successful connect in case the
 * same tenant reconnects a different Page.
 */
export async function ensureMessengerBridgeChannel(
  ctx: Ctx, args: { pageId: string; pageName: string; status?: 'connecting' | 'connected' | 'error' },
): Promise<{ channelId: string }> {
  // Created while the operator is still logging in, deliberately: the channel
  // has to exist before the first event arrives, or the worker would have
  // nothing to attach a conversation to and would fail the very first message
  // of a freshly connected Page. 'connecting' is the honest status until the
  // bridge confirms a session.
  const status = args.status ?? 'connecting';
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into channels (tenant_id, kind, display_name, external_id, status)
     values ($1, 'messenger_bridge', $2, $3, $4)
     on conflict (kind, external_id) where external_id is not null
     do update set display_name = excluded.display_name, status = excluded.status, tenant_id = excluded.tenant_id
     returning id`,
    [ctx.tenantId, args.pageName, args.pageId, status],
  );
  return { channelId: rows[0]!.id };
}

/**
 * Whichever `messenger_bridge` channel this division has, or null — the
 * ingest path refuses to invent one, so a message arriving before anyone
 * connected a Page fails loudly instead of creating a channel nobody
 * configured. Oldest live one first, so a reconnect that left a disabled row
 * behind does not hide the working channel.
 */
export async function findMessengerBridgeChannel(ctx: Ctx): Promise<{ channelId: string } | null> {
  const rows = await ctx.tx.query<{ id: string }>(
    `select id from channels
      where tenant_id = $1 and kind = 'messenger_bridge'
        and division_id = ${divisionSql(2)}
      order by (status = 'disabled'), created_at
      limit 1`,
    [ctx.tenantId, ctx.divisionId ?? null],
  );
  return rows[0] ? { channelId: rows[0].id } : null;
}

/* --------------------------------------------------------------- contacts */

/**
 * Same idea as `upsertContactByIgUsername`, keyed on the numeric user id
 * Facebook puts in a Messenger thread URL rather than a handle. An id survives
 * a display-name change, which a name-based key would not — and a name is
 * nowhere near unique enough to be an identity in the first place.
 *
 * `display_name` is only ever filled in, never overwritten: whatever a human
 * typed on the contact in the CRM outranks whatever Facebook is currently
 * rendering, exactly as the phone and Instagram upserts already behave.
 */
export async function upsertContactByFbUserId(
  ctx: Ctx, args: { fbUserId: string; displayName?: string | null; now?: Date },
): Promise<{ id: string; created: boolean }> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const normalised = args.fbUserId.trim();
  const bidx = fieldIndex(keys.indexKey, normalised);
  const now = args.now ?? new Date();

  const rows = await ctx.tx.query<{ id: string; created: boolean }>(
    `insert into contacts (tenant_id, display_name, fb_user_id_enc, fb_user_id_bidx, first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $5)
     on conflict (tenant_id, division_id, fb_user_id_bidx) where fb_user_id_bidx is not null
     do update set last_seen_at = excluded.last_seen_at,
                   display_name = coalesce(contacts.display_name, excluded.display_name)
     returning id, (xmax = 0) as created`,
    [ctx.tenantId, args.displayName ?? null, sealField(keys, ctx.tenantId, normalised), bidx, now],
  );
  return { id: rows[0]!.id, created: rows[0]!.created };
}

/* ---------------------------------------------------------------- inbound */

/**
 * A Messenger DM from `apps/fb-bridge`, landing in the same
 * contact/conversation/message rows every other channel uses.
 *
 * `providerMessageId` is the idempotency barrier and is chosen by the caller,
 * not here: `apps/fb-bridge` prefers Facebook's own `mid.*` when the DOM
 * exposes one and falls back to a composite key when it does not. Either way it
 * must be the *same* string the webhook route already spooled under, or the two
 * dedupe layers would disagree and a redelivery would insert twice.
 *
 * Inbound only — `direction` is not a parameter because there is no outbound
 * case to tell apart. A reply the operator types in the real Facebook app is
 * deliberately not ingested either: recording it would need a send path to
 * dedupe against, and there is none yet.
 */
export async function ingestInboundMessengerMessage(
  ctx: Ctx,
  args: {
    channelId: string; fbUserId: string; threadId: string; body: string; providerMessageId: string;
    displayName?: string | null; providerTs?: Date; now?: Date;
  },
): Promise<InboundResult> {
  const now = args.now ?? new Date();

  const dup = await ctx.tx.query<{ id: string; conversation_id: string }>(
    `select id, conversation_id from messages
      where tenant_id = $1 and channel_id = $2 and provider_message_id = $3`,
    [ctx.tenantId, args.channelId, args.providerMessageId],
  );
  if (dup[0]) {
    const c = await ctx.tx.query<{ contact_id: string }>(
      'select contact_id from conversations where tenant_id = $1 and id = $2',
      [ctx.tenantId, dup[0].conversation_id],
    );
    return {
      messageId: dup[0].id, conversationId: dup[0].conversation_id,
      contactId: c[0]?.contact_id ?? '', duplicate: true, billed: false,
    };
  }

  // Same two clocks as `ingestInboundMessage`: the conversation is stamped with
  // when Facebook says the message was sent, while metering below runs off
  // arrival so a redelivery carrying an old timestamp cannot rewrite billing.
  const inboundAt = args.providerTs ?? now;
  const contact = await upsertContactByFbUserId(ctx, {
    fbUserId: args.fbUserId, displayName: args.displayName, now,
  });

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  await ctx.tx.query(
    `update contacts set fb_thread_id_enc = $3 where tenant_id = $1 and id = $2`,
    [ctx.tenantId, contact.id, sealField(keys, ctx.tenantId, args.threadId)],
  );

  const conversation = await ensureConversation(ctx, {
    contactId: contact.id, channelId: args.channelId, now: inboundAt,
  });

  const inserted = await ctx.tx.query<{ id: string }>(
    `insert into messages
       (tenant_id, conversation_id, channel_id, direction, sender_type, sender_id,
        body_enc, media, provider_message_id, status, provider_ts)
     values ($1,$2,$3,'inbound','contact',$4,$5,$6,$7,'received',$8)
     returning id`,
    [ctx.tenantId, conversation.id, args.channelId, contact.id,
     sealField(keys, ctx.tenantId, args.body), JSON.stringify([]),
     args.providerMessageId, inboundAt],
  );

  await ctx.tx.query(
    `update conversations
        set last_inbound_at = $3, last_message_at = greatest(last_message_at, $3),
            status = case when status = 'resolved' then 'open' else status end
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, conversation.id, inboundAt],
  );

  const metered = await recordConversationActivity(ctx.tx, {
    tenantId: ctx.tenantId, contactId: contact.id, channelId: args.channelId,
    messageId: inserted[0]!.id, now,
  });

  return {
    messageId: inserted[0]!.id, conversationId: conversation.id, contactId: contact.id,
    duplicate: false, billed: metered.billed,
  };
}

/**
 * A reply the Page already sent, found while reading a thread's history.
 *
 * The counterpart to `ingestInboundMessengerMessage` for the other direction,
 * and it exists for one reason: a conversation that predates the bridge is half
 * ours. Importing only the customer's side would leave the CRM showing somebody
 * talking to nobody, and an agent reading that would have no idea the question
 * had already been answered.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: create an outbox row. These messages were
 * sent on Facebook long ago; queueing them would send them a second time to a
 * real person. They are written straight in as `sent`.
 *
 * It does not meter either. `recordConversationActivity` opens a billable
 * conversation window, and importing old history is not new activity — the same
 * reasoning `recordIgBridgeAgentReply` already follows.
 */
export async function recordMessengerAgentReply(
  ctx: Ctx,
  args: {
    channelId: string; fbUserId: string; threadId: string; body: string; providerMessageId: string;
    displayName?: string | null; providerTs?: Date; now?: Date;
  },
): Promise<{ messageId: string; conversationId: string; contactId: string; duplicate: boolean }> {
  const now = args.now ?? new Date();

  const dup = await ctx.tx.query<{ id: string; conversation_id: string }>(
    `select id, conversation_id from messages
      where tenant_id = $1 and channel_id = $2 and provider_message_id = $3`,
    [ctx.tenantId, args.channelId, args.providerMessageId],
  );
  if (dup[0]) {
    const c = await ctx.tx.query<{ contact_id: string }>(
      'select contact_id from conversations where tenant_id = $1 and id = $2',
      [ctx.tenantId, dup[0].conversation_id],
    );
    return {
      messageId: dup[0].id, conversationId: dup[0].conversation_id,
      contactId: c[0]?.contact_id ?? '', duplicate: true,
    };
  }

  const at = args.providerTs ?? now;
  const contact = await upsertContactByFbUserId(ctx, {
    fbUserId: args.fbUserId, displayName: args.displayName, now,
  });

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  await ctx.tx.query(
    `update contacts set fb_thread_id_enc = $3 where tenant_id = $1 and id = $2`,
    [ctx.tenantId, contact.id, sealField(keys, ctx.tenantId, args.threadId)],
  );

  const conversation = await ensureConversation(ctx, {
    contactId: contact.id, channelId: args.channelId, now: at,
  });

  const inserted = await ctx.tx.query<{ id: string }>(
    `insert into messages
       (tenant_id, conversation_id, channel_id, direction, sender_type,
        body_enc, provider_message_id, status, provider_ts)
     values ($1,$2,$3,'outbound','agent',$4,$5,'sent',$6)
     returning id`,
    [ctx.tenantId, conversation.id, args.channelId,
     sealField(keys, ctx.tenantId, args.body), args.providerMessageId, at],
  );

  // `last_message_at` only ever moves forward, so importing old history cannot
  // drag a live conversation backwards in the inbox ordering.
  await ctx.tx.query(
    `update conversations
        set last_message_at = greatest(last_message_at, $3),
            first_response_at = coalesce(first_response_at, $3)
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, conversation.id, at],
  );

  return { messageId: inserted[0]!.id, conversationId: conversation.id, contactId: contact.id, duplicate: false };
}

/** How far back a reply the CRM sent can still be recognised in the Page's history. */
const MESSENGER_ECHO_WINDOW_MS = 24 * 60 * 60_000;

/**
 * A message the CRM itself sent — an agent's reply or the bot's — read back
 * off the Page while reconciling a thread.
 *
 * Such a message was stored without a provider id: Business Suite reveals a
 * message's id only by clicking it, so the send cannot learn it. Left to
 * `recordMessengerAgentReply`, which knows messages only by that id, the
 * reconcile's copy became a second message in the thread. This finds the row
 * the CRM sent, by its words over a day's window, and gives it the id instead —
 * which also makes the next reconcile stop there. A reply the bridge could not
 * confirm, found here, did go out, so it is marked sent.
 *
 * Null when nothing matches: the message was said on Facebook itself, and is
 * history for `recordMessengerAgentReply` to import.
 */
export async function claimMessengerEcho(
  ctx: Ctx,
  args: { channelId: string; fbUserId: string; body: string; providerMessageId: string; now?: Date },
): Promise<{ messageId: string; conversationId: string; contactId: string; duplicate: true } | null> {
  const known = await ctx.tx.query<{ id: string }>(
    `select id from messages where tenant_id = $1 and channel_id = $2 and provider_message_id = $3`,
    [ctx.tenantId, args.channelId, args.providerMessageId],
  );
  if (known[0]) return null;

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const since = new Date((args.now ?? new Date()).getTime() - MESSENGER_ECHO_WINDOW_MS);
  const candidates = await ctx.tx.query<{ id: string; conversation_id: string; contact_id: string; body_enc: string | null }>(
    `select m.id, m.conversation_id, c.contact_id, m.body_enc
       from messages m
       join conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
       join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id
      where m.tenant_id = $1 and m.channel_id = $2 and ct.fb_user_id_bidx = $3
        and m.direction = 'outbound' and m.provider_message_id is null and m.created_at > $4
        -- Not a bot reply a takeover cancelled: it never reached the bridge.
        -- Null-safe on purpose: most failures store their error as a JSON
        -- string, which has no 'reason' key to read.
        and (m.status <> 'failed' or m.error->>'reason' is distinct from 'bot_cancelled_by_takeover')
      order by m.created_at, m.id
      limit 50`,
    [ctx.tenantId, args.channelId, fieldIndex(keys.indexKey, args.fbUserId.trim()), since],
  );
  const match = candidates.find((r) =>
    r.body_enc !== null && isOwnEcho(openField(keys, ctx.tenantId, r.body_enc), args.body));
  if (!match) return null;

  await ctx.tx.query(
    `update messages
        set provider_message_id = $3,
            status = case when status = 'failed' then 'sent' else status end,
            error = case when status = 'failed' then null else error end
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, match.id, args.providerMessageId],
  );
  return { messageId: match.id, conversationId: match.conversation_id, contactId: match.contact_id, duplicate: true };
}

/**
 * Which of these provider message ids the CRM already holds for a thread.
 *
 * This is what makes Postgres the source of truth for reconciliation rather
 * than a file on the bridge's disk. A backfill walks a thread newest-first and
 * stops at the first id named here: everything older is already stored, so
 * there is nothing behind it worth reading.
 */
export async function knownMessengerMessageIds(
  ctx: Ctx, args: { channelId: string; providerMessageIds: string[] },
): Promise<Set<string>> {
  if (args.providerMessageIds.length === 0) return new Set();
  const rows = await ctx.tx.query<{ provider_message_id: string }>(
    `select provider_message_id from messages
      where tenant_id = $1 and channel_id = $2 and provider_message_id = any($3::text[])`,
    [ctx.tenantId, args.channelId, args.providerMessageIds],
  );
  return new Set(rows.map((r) => r.provider_message_id));
}

/**
 * Which of these Facebook comment ids the CRM already stores.
 *
 * The comment sweep's only memory of what it has delivered: it offers every
 * comment not named here and nothing else, so a comment is ingested once, a
 * restart re-sends nothing, and a CRM rebuilt from scratch gets every comment
 * still on the Page — which a file of "seen" ids on the bridge could not do.
 *
 * When the bridge names the post it read a comment under, the comment counts
 * as known only if it is stored under that same post. Facebook re-issues a
 * post's `pfbid…` slug — confirmed live, the same post served under a new slug
 * overnight — and a comment known by id alone was never offered again, so its
 * row kept a post id Facebook no longer uses. Not known here is what lets the
 * sweep offer it once more and `recordFacebookComment` move it.
 */
export async function knownFacebookCommentIds(
  ctx: Ctx, args: { commentIds: string[]; postIdByComment?: ReadonlyMap<string, string> },
): Promise<Set<string>> {
  const stored = await storedFacebookCommentPosts(ctx, args);
  const known = [...stored].filter(([commentId, postId]) => {
    const offered = args.postIdByComment?.get(commentId);
    return !offered || offered === postId;
  });
  return new Set(known.map(([commentId]) => commentId));
}

/** The post each of these comments is stored under, for the ones that are stored at all. */
export async function storedFacebookCommentPosts(
  ctx: Ctx, args: { commentIds: string[] },
): Promise<Map<string, string>> {
  if (args.commentIds.length === 0) return new Map();
  const rows = await ctx.tx.query<{ comment_id: string; post_id: string }>(
    `select comment_id, post_id from facebook_comments where tenant_id = $1 and comment_id = any($2::text[])`,
    [ctx.tenantId, args.commentIds],
  );
  return new Map(rows.map((r) => [r.comment_id, r.post_id]));
}

/* --------------------------------------------------------------- comments */

export interface CommentResult {
  id: string;
  duplicate: boolean;
  /** Set when a stored comment was re-read under a post slug Facebook has since re-issued. */
  previousPostId?: string;
  /** How many stored comments on that post moved to the new slug with it, itself included. */
  rowsMoved?: number;
}

/**
 * A public Page comment, stored as its own thing rather than squeezed into a
 * conversation — see `0054_facebook_bridge.sql` for the four reasons why.
 *
 * Nothing downstream reads this to reply. It creates no contact, opens no
 * conversation and meters nothing; routing a commenter into a DM or WhatsApp is
 * a separate feature that does not exist yet, and this deliberately stops short
 * of laying track for it beyond keeping the author's id matchable.
 *
 * Idempotent on Facebook's own comment id. `do nothing` rather than `do update`
 * is the point: a comment the watcher re-reads on a later reconciliation pass
 * is the *same* comment, and the first reading of it is the one to keep — an
 * edited comment overwriting the original would quietly erase what the customer
 * actually said first. The post id is the one exception: it is Facebook's
 * address for the post rather than anything the customer wrote, and it moves
 * to the slug the post is served under now.
 */
export async function recordFacebookComment(
  ctx: Ctx,
  args: {
    pageId: string; pageName?: string | null; postId: string; commentId: string;
    /** The comment this one answers, when it is a reply. */
    parentCommentId?: string | null;
    authorExternalId?: string | null; authorName?: string | null; body: string;
    commentedAt?: Date | null;
  },
): Promise<CommentResult> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const authorId = args.authorExternalId?.trim() || null;

  const inserted = await ctx.tx.query<{ id: string }>(
    `insert into facebook_comments
       (tenant_id, page_id, page_name, post_id, comment_id, parent_comment_id,
        author_external_id_enc, author_external_id_bidx, author_name_enc, body_enc, commented_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (tenant_id, comment_id) do nothing
     returning id`,
    [
      ctx.tenantId, args.pageId, args.pageName ?? null, args.postId, args.commentId,
      args.parentCommentId?.trim() || null,
      authorId ? sealField(keys, ctx.tenantId, authorId) : null,
      authorId ? fieldIndex(keys.indexKey, authorId) : null,
      args.authorName ? sealField(keys, ctx.tenantId, args.authorName) : null,
      sealField(keys, ctx.tenantId, args.body),
      args.commentedAt ?? null,
    ],
  );
  if (inserted[0]) return { id: inserted[0].id, duplicate: false };

  const existing = await ctx.tx.query<{ id: string; post_id: string; page_id: string }>(
    `select id, post_id, page_id from facebook_comments where tenant_id = $1 and comment_id = $2`,
    [ctx.tenantId, args.commentId],
  );
  const row = existing[0]!;
  if (row.post_id === args.postId) return { id: row.id, duplicate: true };

  // The one field a re-reading may change: which slug Facebook serves the post
  // under. A comment id belongs to one post for good, so a different slug is
  // the same post renamed — see `knownFacebookCommentIds`. The old slug names
  // that one post, so every comment filed under it moves together: a sweep
  // re-reads only what is rendered, and a reply left collapsed would otherwise
  // stay behind as a second group for the same post.
  const moved = await ctx.tx.query<{ id: string }>(
    `update facebook_comments set post_id = $4
      where tenant_id = $1 and page_id = $2 and post_id = $3
      returning id`,
    [ctx.tenantId, row.page_id, row.post_id, args.postId],
  );
  return moved.some((m) => m.id === row.id)
    ? { id: row.id, duplicate: true, previousPostId: row.post_id, rowsMoved: moved.length }
    : { id: row.id, duplicate: true };
}

/* ------------------------------------------------- comment processing state */

export type CommentStatus =
  | 'new' | 'public_reply_pending' | 'public_replied' | 'dm_pending' | 'dm_sent' | 'failed';

export interface PendingComment {
  id: string;
  /** The division whose Page this was left on — which bridge session answers it. */
  divisionId: string;
  commentId: string;
  postId: string;
  pageId: string;
  authorExternalId: string | null;
  authorName: string | null;
  body: string;
  status: CommentStatus;
  attempts: number;
}

/**
 * Comments with work left to do, oldest first.
 *
 * `cooldownMs` is what keeps automated replies paced: a comment whose last
 * attempt is inside the cooldown is not offered again yet. Measuring it from a
 * column rather than an in-process timer is deliberate — a bridge that restarts
 * every few minutes would otherwise reset its own pacing to zero and burst.
 *
 * Two exclusions carry real meaning:
 *   - `dm_at is null and dm_error is null` — a comment whose private message
 *     already landed, or already came back as unavailable, is finished. Facebook
 *     offers a private reply to a commenter once; retrying it is either a
 *     double-send or a guaranteed failure.
 *   - `attempts < $3` — a comment that keeps failing stops being picked up
 *     instead of consuming the cooldown budget forever.
 */
export async function listPendingComments(
  ctx: Ctx,
  args: { limit?: number; cooldownMs?: number; maxAttempts?: number; now?: Date },
): Promise<PendingComment[]> {
  const now = args.now ?? new Date();
  const cooldownCutoff = new Date(now.getTime() - (args.cooldownMs ?? 0));

  const rows = await ctx.tx.query<{
    id: string; division_id: string; comment_id: string; post_id: string; page_id: string;
    author_external_id_enc: string | null; author_name_enc: string | null; body_enc: string | null;
    status: CommentStatus; attempts: number;
  }>(
    `select id, division_id, comment_id, post_id, page_id,
            author_external_id_enc, author_name_enc, body_enc, status, attempts
       from facebook_comments
      where tenant_id = $1
        and status in ('new','public_reply_pending','public_replied','dm_pending')
        and dm_at is null and dm_error is null
        and attempts < $3
        and (last_attempt_at is null or last_attempt_at <= $4)
      order by coalesce(commented_at, created_at)
      limit $2`,
    [ctx.tenantId, Math.min(args.limit ?? 10, 100), args.maxAttempts ?? 3, cooldownCutoff],
  );

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  return rows.map((r) => ({
    id: r.id, divisionId: r.division_id, commentId: r.comment_id, postId: r.post_id, pageId: r.page_id,
    authorExternalId: r.author_external_id_enc ? openField(keys, ctx.tenantId, r.author_external_id_enc) : null,
    authorName: r.author_name_enc ? openField(keys, ctx.tenantId, r.author_name_enc) : null,
    body: r.body_enc ? openField(keys, ctx.tenantId, r.body_enc) : '',
    status: r.status, attempts: r.attempts,
  }));
}

/**
 * Takes a comment from one state to the next, and says whether it got it.
 *
 * Every transition is guarded on the state it is coming *from*, so the update
 * either moves exactly one row or moves nothing. That is what makes a retry
 * safe: a second worker, a restarted bridge or a re-read of the same comment
 * finds the row already past that point and is told `false` rather than
 * repeating a side effect someone else already performed on a real customer's
 * timeline.
 */
async function transition(
  ctx: Ctx,
  args: { id: string; from: CommentStatus[]; to: CommentStatus; set?: string; values?: unknown[]; now: Date },
): Promise<boolean> {
  const extra = args.set ? `, ${args.set}` : '';
  const rows = await ctx.tx.query<{ id: string }>(
    `update facebook_comments
        set status = $3, last_attempt_at = $4${extra}
      where tenant_id = $1 and id = $2 and status = any($5::text[])
      returning id`,
    [ctx.tenantId, args.id, args.to, args.now, args.from, ...(args.values ?? [])],
  );
  return rows.length > 0;
}

/** Claims a comment for a public reply. False means somebody already has it. */
export async function claimCommentForPublicReply(
  ctx: Ctx, args: { id: string; now?: Date },
): Promise<boolean> {
  const now = args.now ?? new Date();
  const rows = await ctx.tx.query<{ id: string }>(
    `update facebook_comments
        set status = 'public_reply_pending', attempts = attempts + 1, last_attempt_at = $3
      where tenant_id = $1 and id = $2 and status = 'new'
      returning id`,
    [ctx.tenantId, args.id, now],
  );
  return rows.length > 0;
}

export async function markCommentPublicReplied(ctx: Ctx, args: { id: string; now?: Date }): Promise<boolean> {
  const now = args.now ?? new Date();
  return transition(ctx, {
    id: args.id, from: ['public_reply_pending'], to: 'public_replied',
    set: 'public_reply_at = $6, public_reply_error = null', values: [now], now,
  });
}

/** The public reply itself failed, so there is nothing to follow up privately. */
export async function markCommentPublicReplyFailed(
  ctx: Ctx, args: { id: string; reason: string; now?: Date },
): Promise<boolean> {
  const now = args.now ?? new Date();
  return transition(ctx, {
    id: args.id, from: ['new', 'public_reply_pending'], to: 'failed',
    set: 'public_reply_error = $6', values: [args.reason.slice(0, 500)], now,
  });
}

/** Claims a comment for the private message that follows a public reply. */
export async function claimCommentForDm(ctx: Ctx, args: { id: string; now?: Date }): Promise<boolean> {
  const now = args.now ?? new Date();
  const rows = await ctx.tx.query<{ id: string }>(
    `update facebook_comments
        set status = 'dm_pending', attempts = attempts + 1, last_attempt_at = $3
      where tenant_id = $1 and id = $2 and status = 'public_replied'
        and dm_at is null and dm_error is null
      returning id`,
    [ctx.tenantId, args.id, now],
  );
  return rows.length > 0;
}

/**
 * Clears a recorded DM failure so a person may try again.
 *
 * `claimCommentForDm` refuses while `dm_error` is set, and that is right for
 * the automated sweep: a private message that failed once must not be retried
 * on a loop against a real customer. It is wrong for an agent, who can open
 * Facebook, see for themselves whether anything was sent, and decide. Without
 * this the comment was stuck forever behind an enabled button that could never
 * do anything — confirmed live, after an environmental failure that had since
 * been fixed.
 *
 * Deliberately narrow. Only a comment sitting at `public_replied` with an
 * error recorded and nothing delivered can be reset: once `dm_at` is set the
 * message really went, and clearing that would invite a duplicate. Returns
 * whether anything changed, so a caller can tell a real reset from a no-op.
 */
export async function clearCommentDmError(ctx: Ctx, args: { id: string }): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update facebook_comments
        set dm_error = null
      where tenant_id = $1 and id = $2 and status = 'public_replied'
        and dm_at is null and dm_error is not null
      returning id`,
    [ctx.tenantId, args.id],
  );
  return rows.length > 0;
}

/** Only ever called after a real Messenger delivery has been confirmed. */
export async function markCommentDmSent(ctx: Ctx, args: { id: string; now?: Date }): Promise<boolean> {
  const now = args.now ?? new Date();
  return transition(ctx, {
    id: args.id, from: ['dm_pending'], to: 'dm_sent',
    set: 'dm_at = $6, dm_error = null', values: [now], now,
  });
}

/**
 * The private message could not be sent.
 *
 * The comment goes back to `public_replied`, not to `failed`: the public reply
 * did happen and saying otherwise would be a lie about what the customer can
 * see. `dm_error` records why, and because `listPendingComments` skips any
 * comment with a `dm_error`, this is terminal — Facebook offers a private reply
 * to a commenter once, so retrying is either a double-send or a guaranteed
 * second failure.
 */
export async function markCommentDmFailed(
  ctx: Ctx, args: { id: string; reason: string; now?: Date },
): Promise<boolean> {
  const now = args.now ?? new Date();
  return transition(ctx, {
    id: args.id, from: ['dm_pending'], to: 'public_replied',
    set: 'dm_error = $6', values: [args.reason.slice(0, 500)], now,
  });
}

export interface FacebookCommentRow {
  id: string;
  /** The division whose Page this was left on — which bridge session answers it. */
  divisionId: string;
  pageId: string;
  pageName: string | null;
  postId: string;
  commentId: string;
  /** The comment this one answers, when it is a reply; null for a top-level comment. */
  parentCommentId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  body: string;
  commentedAt: Date | null;
  createdAt: Date;
  /** Where this comment is in the reply-then-DM sequence, and why either step
   * did not happen. The console shows all of it: an agent needs to know a
   * public reply landed even when the private message did not. */
  status: CommentStatus;
  publicReplyAt: Date | null;
  publicReplyError: string | null;
  dmAt: Date | null;
  dmError: string | null;
  attempts: number;
}

/** A comment row as stored, before its sealed columns are opened. */
interface StoredCommentRow {
  id: string; division_id: string; page_id: string; page_name: string | null; post_id: string; comment_id: string;
  parent_comment_id: string | null;
  author_external_id_enc: string | null; author_name_enc: string | null; body_enc: string | null;
  commented_at: Date | null; created_at: Date; status: CommentStatus;
  public_reply_at: Date | null; public_reply_error: string | null;
  dm_at: Date | null; dm_error: string | null; attempts: number;
}

const COMMENT_COLUMNS = `id, division_id, page_id, page_name, post_id, comment_id, parent_comment_id,
            author_external_id_enc, author_name_enc, body_enc, commented_at, created_at,
            status, public_reply_at, public_reply_error, dm_at, dm_error, attempts`;

function openCommentRow(keys: TenantKeys, tenantId: string, r: StoredCommentRow): FacebookCommentRow {
  return {
    id: r.id, divisionId: r.division_id, pageId: r.page_id, pageName: r.page_name, postId: r.post_id, commentId: r.comment_id,
    parentCommentId: r.parent_comment_id,
    authorExternalId: r.author_external_id_enc ? openField(keys, tenantId, r.author_external_id_enc) : null,
    authorName: r.author_name_enc ? openField(keys, tenantId, r.author_name_enc) : null,
    body: r.body_enc ? openField(keys, tenantId, r.body_enc) : '',
    commentedAt: r.commented_at, createdAt: r.created_at,
    status: r.status,
    publicReplyAt: r.public_reply_at, publicReplyError: r.public_reply_error,
    dmAt: r.dm_at, dmError: r.dm_error, attempts: r.attempts,
  };
}

/**
 * Newest first. The read path for the console and the API route, and what
 * tests assert against rather than trusting the write.
 */
export async function listFacebookComments(
  ctx: Ctx, args: { limit?: number; postId?: string } = {},
): Promise<FacebookCommentRow[]> {
  const rows = await ctx.tx.query<StoredCommentRow>(
    `select ${COMMENT_COLUMNS}
       from facebook_comments
      where tenant_id = $1 and ($3::text is null or post_id = $3)
      order by coalesce(commented_at, created_at) desc
      limit $2`,
    [ctx.tenantId, Math.min(args.limit ?? 50, 200), args.postId ?? null],
  );

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  return rows.map((r) => openCommentRow(keys, ctx.tenantId, r));
}

/**
 * One comment by its row id, or null.
 *
 * What a queued job starts from: it names a comment by row id and needs the
 * Facebook ids, the author and the Page before it can talk to the bridge, and
 * the current state for the log line when a claim is refused. The same shape as
 * the listing, so a job and the console never disagree about what a comment is.
 */
export async function getFacebookComment(ctx: Ctx, args: { id: string }): Promise<FacebookCommentRow | null> {
  // A job id that is not a uuid is "no such comment", not a database error that
  // the queue would retry eight times to the same answer.
  if (!/^[0-9a-f-]{36}$/i.test(args.id)) return null;
  const rows = await ctx.tx.query<StoredCommentRow>(
    `select ${COMMENT_COLUMNS} from facebook_comments where tenant_id = $1 and id = $2`,
    [ctx.tenantId, args.id],
  );
  if (!rows[0]) return null;
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  return openCommentRow(keys, ctx.tenantId, rows[0]);
}
