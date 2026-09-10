import { normalisePhone } from '@kirana/core';
import type { Sql } from './sql.ts';
import { sealField, fieldIndex, tenantKeys } from './keys.ts';
import { recordConversationActivity, incrementUsage, ensureBillingPeriod } from './metering.ts';

export interface Ctx { tx: Sql; tenantId: string; kek: Buffer }

/* ---------------------------------------------------------------- contacts */

/**
 * Identity resolution. A customer is one contact per tenant regardless of how
 * many channels they use, keyed by the blind index of their normalised phone —
 * which is why "0812…" and "+62 812…" do not become two people.
 */
export async function upsertContactByPhone(
  ctx: Ctx, args: { phone: string; displayName?: string | null; now?: Date },
): Promise<{ id: string; created: boolean }> {
  const e164 = normalisePhone(args.phone);
  if (!e164) throw new Error(`Unparseable phone number: ${args.phone}`);

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const bidx = fieldIndex(keys.indexKey, e164);
  const now = args.now ?? new Date();

  // Upsert, not check-then-insert: two inbound messages from a new customer can
  // land in the same instant, and the second must find the first, not collide.
  // Erased contacts have their blind index nulled, so they fall out of the
  // partial unique index and are never resurrected by a later message.
  const rows = await ctx.tx.query<{ id: string; created: boolean }>(
    `insert into contacts (tenant_id, display_name, phone_enc, phone_bidx, first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $5)
     on conflict (tenant_id, phone_bidx) where phone_bidx is not null
     do update set last_seen_at = excluded.last_seen_at,
                   display_name = coalesce(contacts.display_name, excluded.display_name)
     returning id, (xmax = 0) as created`,
    [ctx.tenantId, args.displayName ?? null, sealField(keys, ctx.tenantId, e164), bidx, now],
  );
  return { id: rows[0]!.id, created: rows[0]!.created };
}

/** Everyone who has ever messaged in, optionally narrowed to one tag — the Pelanggan page asks for `tag: 'customer'`. */
export async function listContacts(ctx: Ctx, args: { tag?: string; limit?: number } = {}) {
  return ctx.tx.query<{
    id: string; display_name: string | null; phone_enc: string | null; tags: string[];
    first_seen_at: Date; last_seen_at: Date;
  }>(
    `select id, display_name, phone_enc, tags, first_seen_at, last_seen_at
       from contacts
      where tenant_id = $1 and deleted_at is null
        and ($3::text is null or $3 = any(tags))
      order by last_seen_at desc
      limit $2`,
    [ctx.tenantId, Math.min(args.limit ?? 200, 500), args.tag ?? null],
  );
}

/* ----------------------------------------------------------- conversations */

/** Reopens the contact's live thread on this channel, or starts one. */
export async function ensureConversation(
  ctx: Ctx, args: { contactId: string; channelId: string; now?: Date },
): Promise<{ id: string; created: boolean }> {
  const now = args.now ?? new Date();
  const rows = await ctx.tx.query<{ id: string; created: boolean }>(
    `insert into conversations (tenant_id, contact_id, channel_id, last_message_at)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, contact_id, channel_id) where status <> 'resolved'
     do update set last_message_at = greatest(conversations.last_message_at, excluded.last_message_at)
     returning id, (xmax = 0) as created`,
    [ctx.tenantId, args.contactId, args.channelId, now],
  );
  return { id: rows[0]!.id, created: rows[0]!.created };
}

/* ------------------------------------------------------------------ inbound */

export interface InboundResult {
  messageId: string;
  conversationId: string;
  contactId: string;
  duplicate: boolean;
  billed: boolean;
}

/**
 * The hot path. One transaction: resolve the contact, attach the message to a
 * thread, meter the conversation window. Idempotent on the provider's message
 * id, because every provider retries and none of them promise exactly-once.
 */
export async function ingestInboundMessage(
  ctx: Ctx,
  args: {
    channelId: string; from: string; body: string; providerMessageId: string;
    displayName?: string | null; providerTs?: Date; media?: unknown[]; now?: Date;
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

  const contact = await upsertContactByPhone(ctx, { phone: args.from, displayName: args.displayName, now });
  const conversation = await ensureConversation(ctx, { contactId: contact.id, channelId: args.channelId, now });

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const inserted = await ctx.tx.query<{ id: string }>(
    `insert into messages
       (tenant_id, conversation_id, channel_id, direction, sender_type, sender_id,
        body_enc, media, provider_message_id, status, provider_ts)
     values ($1,$2,$3,'inbound','contact',$4,$5,$6,$7,'received',$8)
     returning id`,
    [ctx.tenantId, conversation.id, args.channelId, contact.id,
     sealField(keys, ctx.tenantId, args.body), JSON.stringify(args.media ?? []),
     args.providerMessageId, args.providerTs ?? now],
  );

  // Two clocks, deliberately.
  //
  // The 24-hour *reply* window belongs to Meta, so it is measured from the
  // provider's timestamp — taking our own arrival time would let a queue delay
  // convince us a window is open after Meta has already closed it.
  //
  // The 24-hour *billing* window below is measured from arrival, which keeps
  // metering monotonic and immune to a redelivery carrying an old timestamp.
  const inboundAt = args.providerTs ?? now;
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

/* ----------------------------------------------------------------- outbound */

/**
 * Writes the message and its outbox row in the same transaction as the
 * conversation update. The relay worker is the only thing that talks to Meta,
 * so a crash between "saved" and "sent" resolves to "sent", never to silence.
 */
export async function queueOutboundMessage(
  ctx: Ctx,
  args: {
    conversationId: string; body: string; senderType: 'agent' | 'autopilot' | 'system';
    senderId?: string | null; templateName?: string | null; now?: Date;
  },
): Promise<{ messageId: string }> {
  const now = args.now ?? new Date();
  const conv = await ctx.tx.query<{ channel_id: string }>(
    'select channel_id from conversations where tenant_id = $1 and id = $2',
    [ctx.tenantId, args.conversationId],
  );
  if (!conv[0]) throw new Error('Conversation not found');

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const msg = await ctx.tx.query<{ id: string }>(
    `insert into messages
       (tenant_id, conversation_id, channel_id, direction, sender_type, sender_id,
        body_enc, template_name, status)
     values ($1,$2,$3,'outbound',$4,$5,$6,$7,'queued') returning id`,
    [ctx.tenantId, args.conversationId, conv[0].channel_id, args.senderType,
     args.senderId ?? null, sealField(keys, ctx.tenantId, args.body), args.templateName ?? null],
  );

  await ctx.tx.query(
    'insert into message_outbox (tenant_id, message_id) values ($1, $2)',
    [ctx.tenantId, msg[0]!.id],
  );

  await ctx.tx.query(
    `update conversations
        set last_message_at = $3,
            first_response_at = coalesce(first_response_at, $3)
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, args.conversationId, now],
  );

  const period = await ensureBillingPeriod(ctx.tx, ctx.tenantId, now);
  await incrementUsage(ctx.tx, ctx.tenantId, period.id, 'messages_out', 1);
  // `ai_replies` is metered once per generation in the Autopilot processor, not
  // here: a draft that the guardrails block still cost a model call, and a draft
  // an agent edits before sending should not count twice.

  return { messageId: msg[0]!.id };
}

export interface PhoneReplyResult {
  messageId: string; conversationId: string; contactId: string; duplicate: boolean;
}

/**
 * A reply typed on the linked phone itself, outside the console — WhatsApp
 * echoes it back to the bridge the same way it does a customer's message,
 * just flagged `fromMe`. Recorded as an outbound message on the same
 * conversation so the transcript stays complete regardless of which device
 * replied; deduped on the provider's message id like inbound is, since a
 * message the console itself queued echoes back here too and must not
 * appear a second time.
 */
export async function recordPhoneReply(
  ctx: Ctx,
  args: {
    channelId: string; to: string; body: string; providerMessageId: string;
    displayName?: string | null; providerTs?: Date; now?: Date;
  },
): Promise<PhoneReplyResult> {
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

  const contact = await upsertContactByPhone(ctx, { phone: args.to, displayName: args.displayName, now });
  const conversation = await ensureConversation(ctx, { contactId: contact.id, channelId: args.channelId, now });

  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const inserted = await ctx.tx.query<{ id: string }>(
    `insert into messages
       (tenant_id, conversation_id, channel_id, direction, sender_type,
        body_enc, provider_message_id, status, provider_ts)
     values ($1,$2,$3,'outbound','agent',$4,$5,'sent',$6)
     returning id`,
    [ctx.tenantId, conversation.id, args.channelId,
     sealField(keys, ctx.tenantId, args.body), args.providerMessageId, args.providerTs ?? now],
  );

  const at = args.providerTs ?? now;
  await ctx.tx.query(
    `update conversations
        set last_message_at = greatest(last_message_at, $3),
            first_response_at = coalesce(first_response_at, $3)
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, conversation.id, at],
  );

  return { messageId: inserted[0]!.id, conversationId: conversation.id, contactId: contact.id, duplicate: false };
}

/* -------------------------------------------------------------------- reads */

export async function listInbox(
  ctx: Ctx, args: { status?: string; assigneeId?: string; limit?: number; channelKind?: string } = {},
) {
  return ctx.tx.query<{
    id: string; status: string; priority: string; assignee_id: string | null;
    last_message_at: Date | null; last_inbound_at: Date | null; sla_due_at: Date | null;
    display_name: string | null; phone_enc: string | null; channel_kind: string; channel_id: string;
  }>(
    `select c.id, c.status, c.priority, c.assignee_id, c.last_message_at, c.last_inbound_at,
            c.sla_due_at, ct.display_name, ct.phone_enc, ch.kind as channel_kind, ch.id as channel_id
       from conversations c
       join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id
       join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
      where c.tenant_id = $1
        and ($2::text is null or c.status = $2)
        and ($3::uuid is null or c.assignee_id = $3)
        and ($5::text is null or ch.kind = $5)
      order by c.last_message_at desc nulls last
      limit $4`,
    [ctx.tenantId, args.status ?? null, args.assigneeId ?? null, Math.min(args.limit ?? 50, 200),
     args.channelKind ?? null],
  );
}

/* ------------------------------------------------------------- wa-bridge */

/**
 * A whatsapp_web channel plus its pairing session, created together: a
 * channel with no session row would have nowhere to put the QR code, and a
 * session with no channel has no conversations to attach messages to.
 */
export async function createWaBridgeChannel(
  ctx: Ctx, args: { displayName: string },
): Promise<{ channelId: string }> {
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into channels (tenant_id, kind, display_name, status)
     values ($1, 'whatsapp_web', $2, 'connecting') returning id`,
    [ctx.tenantId, args.displayName],
  );
  const channelId = rows[0]!.id;
  await ctx.tx.query(
    `insert into wa_bridge_sessions (channel_id, tenant_id, status) values ($1, $2, 'starting')`,
    [channelId, ctx.tenantId],
  );
  return { channelId };
}

export async function listWaBridgeChannels(ctx: Ctx) {
  return ctx.tx.query<{
    id: string; display_name: string; status: string; phone_e164: string | null;
    session_status: string; qr_data: string | null; qr_expires_at: Date | null;
    last_seen_at: Date | null; last_error: string | null;
  }>(
    `select ch.id, ch.display_name, ch.status, ch.phone_e164,
            s.status as session_status, s.qr_data, s.qr_expires_at, s.last_seen_at, s.last_error
       from channels ch
       join wa_bridge_sessions s on s.channel_id = ch.id and s.tenant_id = ch.tenant_id
      where ch.tenant_id = $1 and ch.kind = 'whatsapp_web'
      order by ch.created_at desc`,
    [ctx.tenantId],
  );
}

export async function disableWaBridgeChannel(ctx: Ctx, args: { channelId: string }): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update channels set status = 'disabled'
      where tenant_id = $1 and id = $2 and kind = 'whatsapp_web' returning id`,
    [ctx.tenantId, args.channelId],
  );
  if (!rows[0]) return false;
  await ctx.tx.query(
    `update wa_bridge_sessions set status = 'logged_out', updated_at = now()
      where tenant_id = $1 and channel_id = $2`,
    [ctx.tenantId, args.channelId],
  );
  return true;
}

/**
 * Unlike disconnecting, this removes the channel row itself — `wa_bridge_sessions`
 * cascades with it. Conversations and messages do not: both reference
 * `channels` with `on delete restrict`, so a number that already has chat
 * history is deleted here on purpose, in the one order that satisfies every
 * constraint — the caller is the one that should have already confirmed this
 * with whoever clicked delete, since the history does not come back.
 */
export async function deleteWaBridgeChannel(ctx: Ctx, args: { channelId: string }): Promise<boolean> {
  const owned = await ctx.tx.query<{ id: string }>(
    `select id from channels where tenant_id = $1 and id = $2 and kind = 'whatsapp_web'`,
    [ctx.tenantId, args.channelId],
  );
  if (!owned[0]) return false;

  // Metering rows reference the channel directly, not through a conversation,
  // so they need their own delete before the channel can go.
  await ctx.tx.query(`delete from meta_cost_events where tenant_id = $1 and channel_id = $2`,
    [ctx.tenantId, args.channelId]);
  await ctx.tx.query(`delete from billable_conversations where tenant_id = $1 and channel_id = $2`,
    [ctx.tenantId, args.channelId]);
  // Cascades away every message (and each message's outbox row) on this channel.
  await ctx.tx.query(`delete from conversations where tenant_id = $1 and channel_id = $2`,
    [ctx.tenantId, args.channelId]);

  await ctx.tx.query(`delete from channels where tenant_id = $1 and id = $2`, [ctx.tenantId, args.channelId]);
  return true;
}

/**
 * Re-arms a number that was disconnected — same row, same id, so `apps/wa-bridge`
 * can be told to start a session for it again. Whether that means WhatsApp
 * resumes silently or asks for a fresh QR is up to whatsapp-web.js's own saved
 * session state, not something this call knows.
 */
export async function reconnectWaBridgeChannel(ctx: Ctx, args: { channelId: string }): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update channels set status = 'connecting'
      where tenant_id = $1 and id = $2 and kind = 'whatsapp_web' and status = 'disabled' returning id`,
    [ctx.tenantId, args.channelId],
  );
  if (!rows[0]) return false;
  await ctx.tx.query(
    `update wa_bridge_sessions set status = 'starting', qr_data = null, qr_expires_at = null, last_error = null, updated_at = now()
      where tenant_id = $1 and channel_id = $2`,
    [ctx.tenantId, args.channelId],
  );
  return true;
}

/* -------------------------------------------------------------------- deals */

export async function createDeal(
  ctx: Ctx,
  args: { contactId: string; title: string; amountIdr: number; ownerId?: string | null; sourceConversationId?: string | null },
) {
  const stage = await ctx.tx.query<{ id: string; pipeline_id: string }>(
    `select s.id, s.pipeline_id from pipeline_stages s
       join pipelines p on p.id = s.pipeline_id and p.tenant_id = s.tenant_id
      where s.tenant_id = $1 and p.is_default order by s.position asc limit 1`,
    [ctx.tenantId],
  );
  if (!stage[0]) throw new Error('No default pipeline configured');

  const rows = await ctx.tx.query<{ id: string }>(
    `insert into deals (tenant_id, contact_id, pipeline_id, stage_id, title, amount_micros,
                        owner_id, source_conversation_id, rots_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() + interval '7 days') returning id`,
    [ctx.tenantId, args.contactId, stage[0].pipeline_id, stage[0].id, args.title,
     Math.round(args.amountIdr * 1_000_000), args.ownerId ?? null, args.sourceConversationId ?? null],
  );
  return { id: rows[0]!.id };
}

/**
 * Event-driven stage movement: a payment webhook advances the deal without
 * anyone touching the board. Returns the deals that moved, for the timeline.
 */
export async function advanceDealsOnEvent(
  ctx: Ctx, args: { contactId: string; event: string },
): Promise<{ dealId: string; stageId: string }[]> {
  const targets = await ctx.tx.query<{ id: string; pipeline_id: string; position: number; is_won: boolean }>(
    `select id, pipeline_id, position, is_won from pipeline_stages
      where tenant_id = $1 and auto_advance_on ->> 'event' = $2`,
    [ctx.tenantId, args.event],
  );
  const moved: { dealId: string; stageId: string }[] = [];

  for (const stage of targets) {
    const rows = await ctx.tx.query<{ id: string }>(
      `update deals d
          set stage_id = $3,
              status = case when $4 then 'won' else d.status end,
              closed_at = case when $4 then now() else d.closed_at end,
              rots_at = now() + interval '7 days',
              updated_at = now()
        from pipeline_stages cur
       where d.tenant_id = $1 and d.contact_id = $2 and d.status = 'open'
         and d.pipeline_id = $5
         and cur.id = d.stage_id and cur.position < $6
       returning d.id`,
      [ctx.tenantId, args.contactId, stage.id, stage.is_won, stage.pipeline_id, stage.position],
    );
    for (const r of rows) moved.push({ dealId: r.id, stageId: stage.id });
  }
  return moved;
}
