import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  invalid, notFound, forbidden, conflict, canTouchConversation, guardOutbound, maskPhone,
  serviceWindowOpen, actorCan,
} from '@kirana/core';
import { audit, listInbox, queueOutboundMessage, tenantKeys, openField, createDeal } from '@kirana/db';
import type { AppCtx } from '../app.ts';

export function registerConversationRoutes(app: FastifyInstance, ctx: AppCtx): void {

  app.get('/v1/conversations', async (req) => {
    ctx.guard(req, 'conversation:read');
    const q = z.object({
      status: z.enum(['open', 'pending', 'snoozed', 'resolved']).optional(),
      assignee: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      channelKind: z.string().optional(),
    }).safeParse(req.query);
    if (!q.success) throw invalid('Check the filter parameters');

    return ctx.asTenant(req, async (tx, actor) => {
      const canReveal = actorCan(actor, 'contact:export');
      const rows = await listInbox({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        status: q.data.status, assigneeId: q.data.assignee, limit: q.data.limit,
        channelKind: q.data.channelKind,
      });
      const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);

      return rows.map(({ phone_enc, ...r }) => {
        const phone = phone_enc ? openField(keys, actor.tenantId, phone_enc) : null;
        return { ...r, phone: phone ? (canReveal ? phone : maskPhone(phone)) : null };
      });
    });
  });

  app.get('/v1/conversations/:id', async (req) => {
    ctx.guard(req, 'conversation:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx, actor) => {
      // `channel_kind` comes along because the console has to know what it is
      // looking at: a channel with no way to send must not be offered a reply
      // box. The inbox list has always carried it; the detail read had not,
      // which is why the composer was shown for every channel alike.
      const conv = await tx.query<{
        id: string; status: string; assignee_id: string | null; contact_id: string;
        channel_id: string; last_inbound_at: Date | null; autopilot_mode: string; channel_kind: string;
      }>(`select c.id, c.status, c.assignee_id, c.contact_id, c.channel_id, c.last_inbound_at,
                 c.autopilot_mode, ch.kind as channel_kind
            from conversations c
            join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
           where c.tenant_id = $1 and c.id = $2`, [actor.tenantId, id]);
      if (!conv[0]) throw notFound('Conversation');

      const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);

      const contact = await tx.query<{
        display_name: string | null; phone_enc: string | null; tags: string[]; deleted_at: Date | null;
      }>(
        'select display_name, phone_enc, tags, deleted_at from contacts where tenant_id = $1 and id = $2',
        [actor.tenantId, conv[0].contact_id],
      );

      const messages = await tx.query<{
        id: string; direction: string; sender_type: string; body_enc: string | null;
        status: string; at: Date;
      }>(
        // When the customer sent it, not when we happened to receive it. For live
        // traffic those are seconds apart; for a redelivery or an import they are
        // not, and showing our clock would misdate the conversation.
        `select id, direction, sender_type, body_enc, status,
                coalesce(provider_ts, created_at) as at
           from messages where tenant_id = $1 and conversation_id = $2
           order by at asc limit 200`, [actor.tenantId, id]);

      const orders = await tx.query<{
        code: string; status: string; total_micros: string; ship_area: string | null; created_at: Date;
      }>(
        `select code, status, total_micros, ship_area, created_at from orders
          where tenant_id = $1 and contact_id = $2 order by created_at desc limit 5`,
        [actor.tenantId, conv[0].contact_id],
      );

      const drafts = await tx.query<{
        id: string; body_enc: string; confidence: string; intent: string | null; reasons: unknown; model: string | null;
      }>(
        `select id, body_enc, confidence, intent, reasons, model
           from message_drafts
          where tenant_id = $1 and conversation_id = $2 and status = 'pending'
          order by created_at desc limit 1`,
        [actor.tenantId, id],
      );

      // Full phone numbers are a separate entitlement from reading the thread.
      const canReveal = actorCan({ ...actor }, 'contact:export');
      const phone = contact[0]?.phone_enc ? openField(keys, actor.tenantId, contact[0].phone_enc) : null;

      return {
        conversation: {
          ...conv[0],
          serviceWindowOpen: serviceWindowOpen(
            conv[0].last_inbound_at ? new Date(conv[0].last_inbound_at) : null, new Date()),
        },
        contact: {
          displayName: contact[0]?.display_name ?? null,
          phone: phone ? (canReveal ? phone : maskPhone(phone)) : null,
          // A contact removed from Pelanggan (soft-deleted) keeps its old tags
          // in the database, but the thread must not keep showing "Customer"
          // for someone the Pelanggan page no longer lists — that page and
          // this chip are supposed to agree on who counts as a customer.
          tags: contact[0]?.deleted_at ? [] : (contact[0]?.tags ?? []),
        },
        orders: orders.map((o) => ({
          code: o.code, status: o.status, shipArea: o.ship_area,
          totalIdr: Math.round(Number(o.total_micros) / 1_000_000),
          createdAt: o.created_at,
        })),
        draft: drafts[0]
          ? {
              id: drafts[0].id,
              body: openField(keys, actor.tenantId, drafts[0].body_enc),
              confidence: Number(drafts[0].confidence),
              intent: drafts[0].intent,
              model: drafts[0].model,
            }
          : null,
        messages: messages.map((m) => ({
          id: m.id, direction: m.direction, senderType: m.sender_type, status: m.status,
          at: m.at,
          body: m.body_enc ? openField(keys, actor.tenantId, m.body_enc) : null,
        })),
      };
    });
  });

  app.post('/v1/conversations/:id/messages', async (req, reply) => {
    const actor = ctx.guard(req, 'conversation:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      body: z.string().min(1).max(4096),
      templateName: z.string().max(128).optional(),
      senderType: z.enum(['agent', 'autopilot']).default('agent'),
    }).safeParse(req.body);
    if (!body.success) throw invalid('A message body is required');

    const result = await ctx.asTenant(req, async (tx, actor) => {
      const conv = await tx.query<{ assignee_id: string | null; last_inbound_at: Date | null; channel_id: string }>(
        'select assignee_id, last_inbound_at, channel_id from conversations where tenant_id = $1 and id = $2',
        [actor.tenantId, id],
      );
      if (!conv[0]) throw notFound('Conversation');

      if (!canTouchConversation(actor, { assigneeId: conv[0].assignee_id })) {
        throw forbidden('This conversation is assigned to someone else');
      }

      const channel = await tx.query<{ kind: string; quality: string }>(
        'select kind, quality from channels where tenant_id = $1 and id = $2', [actor.tenantId, conv[0].channel_id]);

      // The same gate the worker applies — and the same exception: a
      // WA-bridge (whatsapp_web) or IG-bridge (instagram_bridge) session has
      // no Meta 24-hour/template rule, so both skip the guard entirely
      // rather than failing here before the message ever reaches the queue.
      // Failing here for a real Meta channel gives the agent an explanation
      // now instead of a silent rejection later.
      if (channel[0]?.kind !== 'whatsapp_web' && channel[0]?.kind !== 'instagram_bridge') {
        const guard = guardOutbound({
          lastInboundAt: conv[0].last_inbound_at ? new Date(conv[0].last_inbound_at) : null,
          now: new Date(),
          hasApprovedTemplate: Boolean(body.data.templateName),
          channelQuality: (channel[0]?.quality ?? 'green') as 'green' | 'yellow' | 'red' | 'flagged',
          contactOptedOut: false,
          isTemplateSend: Boolean(body.data.templateName),
        });
        if (!guard.ok) {
          throw invalid(
            guard.reason === 'template_required'
              ? 'The 24-hour reply window has closed — send an approved template instead'
              : `Message blocked: ${guard.reason}`,
            { reason: guard.reason },
          );
        }
      }

      const queued = await queueOutboundMessage({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        conversationId: id, body: body.data.body,
        senderType: body.data.senderType, senderId: actor.userId,
        templateName: body.data.templateName ?? null,
      });

      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'message.sent',
        resourceType: 'conversation', resourceId: id,
        meta: { messageId: queued.messageId, template: body.data.templateName ?? null },
      });
      return queued;
    });

    await ctx.dispatch({ queue: 'outbound.send', payload: { tenantId: actor.tenantId, messageId: result.messageId } });
    return reply.status(202).send(result);
  });

  /**
   * Accept an Autopilot draft. The agent may edit it first; either way it goes
   * through the identical send path a typed reply does, so the 24-hour window
   * rule and every other check still apply.
   */
  app.post('/v1/conversations/:id/drafts/:draftId', async (req, reply) => {
    const actor = ctx.guard(req, 'conversation:write');
    const params = z.object({ id: z.string().uuid(), draftId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      action: z.enum(['use', 'discard']),
      body: z.string().min(1).max(4096).optional(),
      templateName: z.string().max(128).optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('action must be use or discard');

    const result = await ctx.asTenant(req, async (tx, actor) => {
      const rows = await tx.query<{ id: string; body_enc: string; status: string }>(
        `select id, body_enc, status from message_drafts
          where tenant_id = $1 and id = $2 and conversation_id = $3`,
        [actor.tenantId, params.draftId, params.id],
      );
      const draft = rows[0];
      if (!draft) throw notFound('Draft');
      if (draft.status !== 'pending') throw conflict('That draft has already been dealt with');

      if (body.data.action === 'discard') {
        await tx.query(
          `update message_drafts set status = 'discarded', decided_at = now(), decided_by = $3
            where tenant_id = $1 and id = $2`,
          [actor.tenantId, draft.id, actor.userId],
        );
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'autopilot.draft_discarded',
          resourceType: 'conversation', resourceId: params.id, meta: { draftId: draft.id },
        });
        return null;
      }

      const conv = await tx.query<{ assignee_id: string | null; last_inbound_at: Date | null; channel_id: string }>(
        'select assignee_id, last_inbound_at, channel_id from conversations where tenant_id = $1 and id = $2',
        [actor.tenantId, params.id],
      );
      if (!conv[0]) throw notFound('Conversation');
      if (!canTouchConversation(actor, { assigneeId: conv[0].assignee_id })) {
        throw forbidden('This conversation is assigned to someone else');
      }

      const channel = await tx.query<{ kind: string; quality: string }>(
        'select kind, quality from channels where tenant_id = $1 and id = $2', [actor.tenantId, conv[0].channel_id]);

      // Same whatsapp_web/instagram_bridge exception as the plain-reply route above.
      if (channel[0]?.kind !== 'whatsapp_web' && channel[0]?.kind !== 'instagram_bridge') {
        const guard = guardOutbound({
          lastInboundAt: conv[0].last_inbound_at ? new Date(conv[0].last_inbound_at) : null,
          now: new Date(),
          hasApprovedTemplate: Boolean(body.data.templateName),
          channelQuality: (channel[0]?.quality ?? 'green') as 'green' | 'yellow' | 'red' | 'flagged',
          contactOptedOut: false,
          isTemplateSend: Boolean(body.data.templateName),
        });
        if (!guard.ok) throw invalid('The 24-hour reply window has closed — send an approved template instead',
          { reason: guard.reason });
      }

      const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);
      const draftBody = openField(keys, actor.tenantId, draft.body_enc);
      const edited = body.data.body !== undefined && body.data.body !== draftBody;
      const queued = await queueOutboundMessage({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        conversationId: params.id,
        body: body.data.body ?? draftBody,
        // The words are the model's even when a person approved them; the
        // approver is recorded on the draft.
        senderType: 'autopilot',
        senderId: actor.userId,
        templateName: body.data.templateName ?? null,
      });

      await tx.query(
        `update message_drafts set status = $4, decided_at = now(), decided_by = $3
          where tenant_id = $1 and id = $2`,
        [actor.tenantId, draft.id, actor.userId, edited ? 'edited' : 'used'],
      );
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId,
        action: edited ? 'autopilot.draft_edited' : 'autopilot.draft_used',
        resourceType: 'conversation', resourceId: params.id,
        meta: { draftId: draft.id, messageId: queued.messageId },
      });
      return queued;
    });

    if (result) await ctx.dispatch({ queue: 'outbound.send', payload: { tenantId: actor.tenantId, messageId: result.messageId } });
    return reply.status(result ? 202 : 200).send(result ?? { ok: true });
  });

  /**
   * Flags the person behind this thread as a customer — a tag on the contact,
   * not the conversation, so it follows them across every channel they write
   * in on and is what the Pelanggan page filters by. Also opens a deal for
   * them in the default pipeline's first stage ("Baru") — becoming a customer
   * from a chat is itself the sales opportunity Penjualan exists to track,
   * so there is one less manual step between the two pages.
   */
  app.post('/v1/conversations/:id/mark-customer', async (req) => {
    ctx.guard(req, 'contact:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx, actor) => {
      const conv = await tx.query<{ contact_id: string }>(
        'select contact_id from conversations where tenant_id = $1 and id = $2', [actor.tenantId, id]);
      if (!conv[0]) throw notFound('Conversation');

      // A contact removed from Pelanggan earlier (soft-deleted) still carries
      // the `customer` tag from before — that must not count as "already a
      // customer" here, or re-marking them would silently leave them missing
      // from Pelanggan (still deleted) while claiming to have already run.
      const before = await tx.query<{ was_customer: boolean }>(
        `select ('customer' = any(tags) and deleted_at is null) as was_customer
           from contacts where tenant_id = $1 and id = $2`,
        [actor.tenantId, conv[0].contact_id],
      );
      if (!before[0]) throw notFound('Contact');
      const wasCustomer = before[0].was_customer;

      const rows = await tx.query<{ id: string; display_name: string | null; phone_enc: string | null }>(
        `update contacts
            set tags = case when 'customer' = any(tags) then tags else array_append(tags, 'customer') end,
                deleted_at = null
          where tenant_id = $1 and id = $2
          returning id, display_name, phone_enc`,
        [actor.tenantId, conv[0].contact_id],
      );
      if (!rows[0]) throw notFound('Contact');

      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'contact.marked_customer',
        resourceType: 'contact', resourceId: conv[0].contact_id,
      });

      // Only the first time — re-marking an existing customer (a resubmitted
      // form, a stale tab) must not spawn another deal each time.
      let dealId: string | null = null;
      if (!wasCustomer) {
        const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);
        const phone = rows[0].phone_enc ? openField(keys, actor.tenantId, rows[0].phone_enc) : null;
        const deal = await createDeal({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          contactId: conv[0].contact_id, title: `Peluang baru — ${rows[0].display_name ?? phone ?? 'Pelanggan'}`,
          amountIdr: 0, ownerId: actor.userId, sourceConversationId: id,
        });
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'deal.created',
          resourceType: 'deal', resourceId: deal.id, meta: { source: 'mark_customer' },
        });
        dealId = deal.id;
      }

      return { ok: true, dealId };
    });
  });

  app.post('/v1/conversations/:id/assign', async (req) => {
    ctx.guard(req, 'conversation:assign');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ assigneeId: z.string().uuid().nullable() }).safeParse(req.body);
    if (!body.success) throw invalid('assigneeId must be a user id or null');

    return ctx.asTenant(req, async (tx, actor) => {
      const rows = await tx.query<{ id: string }>(
        'update conversations set assignee_id = $3 where tenant_id = $1 and id = $2 returning id',
        [actor.tenantId, id, body.data.assigneeId],
      );
      if (!rows[0]) throw notFound('Conversation');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'conversation.assigned',
        resourceType: 'conversation', resourceId: id, meta: { assigneeId: body.data.assigneeId },
      });
      return { ok: true };
    });
  });

  app.post('/v1/conversations/:id/resolve', async (req) => {
    ctx.guard(req, 'conversation:close');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx, actor) => {
      const rows = await tx.query<{ id: string }>(
        `update conversations set status = 'resolved', resolved_at = now()
          where tenant_id = $1 and id = $2 returning id`,
        [actor.tenantId, id],
      );
      if (!rows[0]) throw notFound('Conversation');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'conversation.resolved',
        resourceType: 'conversation', resourceId: id,
      });
      return { ok: true };
    });
  });

  app.post('/v1/deals', async (req, reply) => {
    ctx.guard(req, 'deal:write');
    const body = z.object({
      contactId: z.string().uuid().optional(),
      title: z.string().min(1).max(200),
      amountIdr: z.number().int().min(0).max(1_000_000_000_000),
      conversationId: z.string().uuid().optional(),
      brandId: z.string().uuid().nullable().optional(),
      stageId: z.string().uuid().optional(),
    }).refine((b) => b.contactId || b.brandId, { message: 'A contactId or brandId is required' })
      .safeParse(req.body);
    if (!body.success) throw invalid('Check the deal fields');

    const deal = await ctx.asTenant(req, async (tx, actor) => {
      const created = await createDeal({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        contactId: body.data.contactId ?? null, title: body.data.title, amountIdr: body.data.amountIdr,
        ownerId: actor.userId, sourceConversationId: body.data.conversationId ?? null,
        brandId: body.data.brandId ?? null, stageId: body.data.stageId ?? null,
      });
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'deal.created',
        resourceType: 'deal', resourceId: created.id, meta: { amountIdr: body.data.amountIdr },
      });
      return created;
    });
    return reply.status(201).send(deal);
  });

  app.get('/v1/pipelines', async (req) => {
    ctx.guard(req, 'deal:read');
    return ctx.asTenant(req, async (tx, actor) => {
      const stages = await tx.query<{
        id: string; pipeline_id: string; pipeline: string; name: string;
        position: number; is_won: boolean; is_lost: boolean;
      }>(
        `select s.id, s.pipeline_id, p.name as pipeline, s.name, s.position, s.is_won, s.is_lost
           from pipeline_stages s
           join pipelines p on p.id = s.pipeline_id and p.tenant_id = s.tenant_id
          where s.tenant_id = $1 order by p.is_default desc, s.position asc`,
        [actor.tenantId],
      );
      return { stages };
    });
  });

  /** Moving a deal. The stage must belong to the deal's own pipeline. */
  app.patch('/v1/deals/:id', async (req) => {
    ctx.guard(req, 'deal:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      stageId: z.string().uuid().optional(),
      lostReason: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!body.success || !body.data.stageId) throw invalid('A target stageId is required');

    return ctx.asTenant(req, async (tx, actor) => {
      const stage = await tx.query<{ id: string; pipeline_id: string; is_won: boolean; is_lost: boolean }>(
        'select id, pipeline_id, is_won, is_lost from pipeline_stages where tenant_id = $1 and id = $2',
        [actor.tenantId, body.data.stageId],
      );
      if (!stage[0]) throw notFound('Stage');

      const moved = await tx.query<{ id: string; status: string }>(
        `update deals
            set stage_id = $3,
                status = case when $4 then 'won' when $5 then 'lost' else 'open' end,
                lost_reason = case when $5 then $6 else null end,
                closed_at = case when $4 or $5 then now() else null end,
                rots_at = now() + interval '7 days',
                updated_at = now()
          where tenant_id = $1 and id = $2 and pipeline_id = $7
          returning id, status`,
        [actor.tenantId, id, stage[0].id, stage[0].is_won, stage[0].is_lost,
         body.data.lostReason ?? null, stage[0].pipeline_id],
      );
      if (!moved[0]) throw notFound('Deal in that pipeline');

      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'deal.moved',
        resourceType: 'deal', resourceId: id, meta: { stageId: stage[0].id, status: moved[0].status },
      });
      return moved[0];
    });
  });

  app.get('/v1/deals', async (req) => {
    ctx.guard(req, 'deal:read');
    return ctx.asTenant(req, (tx, actor) =>
      tx.query(
        `select d.id, d.title, d.amount_micros / 1000000 as amount_idr, d.status,
                d.stage_id, s.name as stage, s.position, d.rots_at, d.owner_id, d.closed_at,
                d.expected_close_on,
                d.contact_id, ct.display_name as contact_name, d.brand_id, br.name as brand_name, br.category as brand_category
           from deals d
           join pipeline_stages s on s.id = d.stage_id and s.tenant_id = d.tenant_id
           left join contacts ct on ct.id = d.contact_id and ct.tenant_id = d.tenant_id
           left join brands br on br.id = d.brand_id and br.tenant_id = d.tenant_id
          where d.tenant_id = $1
          order by d.created_at desc limit 200`,
        [actor.tenantId],
      ));
  });
}
