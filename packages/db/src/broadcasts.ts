import type { Ctx } from './repo.ts';

export interface BroadcastSegmentArgs {
  channelId: string;
  tags: string[];
}

/** Every contact a segment (channel + tags) would actually reach, and why the rest wouldn't be. */
export async function previewBroadcastSegment(
  ctx: Ctx, args: BroadcastSegmentArgs,
): Promise<{ eligible: number; noConsent: number; noConversation: number }> {
  const rows = await ctx.tx.query<{ eligible: string; no_consent: string; no_conversation: string }>(
    `with matched as (
       select ct.id, coalesce((ct.consent->>'marketing')::boolean, false) as consents,
              exists (
                select 1 from conversations cv
                 where cv.tenant_id = ct.tenant_id and cv.contact_id = ct.id
                   and cv.channel_id = $2 and cv.status <> 'resolved'
              ) as has_conversation
         from contacts ct
        where ct.tenant_id = $1 and ct.deleted_at is null and ct.tags && $3
     )
     select
       count(*) filter (where consents and has_conversation) as eligible,
       count(*) filter (where not consents) as no_consent,
       count(*) filter (where consents and not has_conversation) as no_conversation
       from matched`,
    [ctx.tenantId, args.channelId, args.tags],
  );
  const r = rows[0]!;
  return { eligible: Number(r.eligible), noConsent: Number(r.no_consent), noConversation: Number(r.no_conversation) };
}

export interface CreateBroadcastArgs {
  name: string; templateId: string; channelId: string; tags: string[]; createdBy: string;
}

export interface BroadcastEligibleRecipient {
  recipientId: string; contactId: string; conversationId: string;
}

/**
 * Resolves the segment and records one `broadcast_recipients` row per
 * matching contact — eligible ones with `conversation_id` set and ready to be
 * queued by the caller, everyone else with a `skipped_reason` so the detail
 * view can show an honest total instead of only ever showing successes.
 */
export async function createBroadcast(
  ctx: Ctx, args: CreateBroadcastArgs,
): Promise<{ id: string; recipients: BroadcastEligibleRecipient[] }> {
  const created = await ctx.tx.query<{ id: string }>(
    `insert into broadcasts (tenant_id, name, template_id, channel_id, tags, created_by)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [ctx.tenantId, args.name, args.templateId, args.channelId, args.tags, args.createdBy],
  );
  const broadcastId = created[0]!.id;

  const matched = await ctx.tx.query<{
    id: string; consents: boolean; conversation_id: string | null;
  }>(
    `select ct.id, coalesce((ct.consent->>'marketing')::boolean, false) as consents,
            (select cv.id from conversations cv
              where cv.tenant_id = ct.tenant_id and cv.contact_id = ct.id
                and cv.channel_id = $2 and cv.status <> 'resolved'
              limit 1) as conversation_id
       from contacts ct
      where ct.tenant_id = $1 and ct.deleted_at is null and ct.tags && $3`,
    [ctx.tenantId, args.channelId, args.tags],
  );

  const recipients: BroadcastEligibleRecipient[] = [];
  for (const m of matched) {
    const skippedReason = !m.consents ? 'no_consent' : !m.conversation_id ? 'no_conversation' : null;
    const inserted = await ctx.tx.query<{ id: string }>(
      `insert into broadcast_recipients (tenant_id, broadcast_id, contact_id, conversation_id, skipped_reason)
       values ($1,$2,$3,$4,$5) returning id`,
      [ctx.tenantId, broadcastId, m.id, m.conversation_id, skippedReason],
    );
    if (!skippedReason && m.conversation_id) {
      recipients.push({ recipientId: inserted[0]!.id, contactId: m.id, conversationId: m.conversation_id });
    }
  }

  return { id: broadcastId, recipients };
}

/** Links the `messages` row `queueOutboundMessage` created back onto its recipient row. */
export async function attachBroadcastMessage(
  ctx: Ctx, args: { recipientId: string; messageId: string },
): Promise<void> {
  await ctx.tx.query(
    `update broadcast_recipients set message_id = $3 where tenant_id = $1 and id = $2`,
    [ctx.tenantId, args.recipientId, args.messageId],
  );
}

export interface BroadcastRow {
  id: string; name: string; templateName: string; channelName: string; tags: string[];
  total: number; sent: number; failed: number; pending: number; createdAt: Date;
}

/** Every broadcast on file, with counts computed live from `messages.status` — nothing cached to go stale. */
export async function listBroadcasts(ctx: Ctx): Promise<BroadcastRow[]> {
  const rows = await ctx.tx.query<{
    id: string; name: string; template_name: string; channel_name: string; tags: string[]; created_at: Date;
    total: string; sent: string; failed: string; pending: string;
  }>(
    `select b.id, b.name, mt.name as template_name, ch.display_name as channel_name, b.tags, b.created_at,
            count(br.id) as total,
            count(*) filter (where m.status in ('sent', 'delivered', 'read')) as sent,
            count(*) filter (where m.status = 'failed') as failed,
            count(*) filter (where br.skipped_reason is null and m.id is not null and m.status = 'queued') as pending
       from broadcasts b
       join message_templates mt on mt.id = b.template_id and mt.tenant_id = b.tenant_id
       join channels ch on ch.id = b.channel_id and ch.tenant_id = b.tenant_id
       left join broadcast_recipients br on br.broadcast_id = b.id and br.tenant_id = b.tenant_id
       left join messages m on m.id = br.message_id and m.tenant_id = b.tenant_id
      where b.tenant_id = $1
      group by b.id, mt.name, ch.display_name
      order by b.created_at desc`,
    [ctx.tenantId],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, templateName: r.template_name, channelName: r.channel_name ?? '—', tags: r.tags,
    total: Number(r.total), sent: Number(r.sent), failed: Number(r.failed), pending: Number(r.pending),
    createdAt: r.created_at,
  }));
}

export interface BroadcastRecipientRow {
  contactId: string; contactName: string | null; status: string; skippedReason: string | null;
}

export interface BroadcastDetail extends BroadcastRow {
  recipients: BroadcastRecipientRow[];
}

export async function getBroadcast(ctx: Ctx, args: { broadcastId: string }): Promise<BroadcastDetail | null> {
  const list = await listBroadcasts(ctx);
  const summary = list.find((b) => b.id === args.broadcastId);
  if (!summary) return null;

  const recipients = await ctx.tx.query<{ contact_id: string; display_name: string | null; status: string | null; skipped_reason: string | null }>(
    `select br.contact_id, ct.display_name, m.status, br.skipped_reason
       from broadcast_recipients br
       join contacts ct on ct.id = br.contact_id and ct.tenant_id = br.tenant_id
       left join messages m on m.id = br.message_id and m.tenant_id = br.tenant_id
      where br.tenant_id = $1 and br.broadcast_id = $2
      order by ct.display_name asc nulls last`,
    [ctx.tenantId, args.broadcastId],
  );

  return {
    ...summary,
    recipients: recipients.map((r) => ({
      contactId: r.contact_id, contactName: r.display_name,
      status: r.status ?? (r.skipped_reason ? 'skipped' : 'queued'), skippedReason: r.skipped_reason,
    })),
  };
}

export interface BroadcastChannelRow {
  id: string; displayName: string; phoneE164: string | null; quality: 'green' | 'yellow' | 'red' | 'flagged';
}

/** Connected WhatsApp Web numbers a broadcast can actually send from. */
export async function listBroadcastChannels(ctx: Ctx): Promise<BroadcastChannelRow[]> {
  const rows = await ctx.tx.query<{ id: string; display_name: string; phone_e164: string | null; quality: string }>(
    `select id, display_name, phone_e164, quality
       from channels
      where tenant_id = $1 and kind = 'whatsapp_web' and status = 'connected'
      order by created_at desc`,
    [ctx.tenantId],
  );
  return rows.map((r) => ({
    id: r.id, displayName: r.display_name, phoneE164: r.phone_e164,
    quality: r.quality as 'green' | 'yellow' | 'red' | 'flagged',
  }));
}
