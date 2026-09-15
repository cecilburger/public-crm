import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound, sendRatePerSecond } from '@kirana/core';
import {
  previewBroadcastSegment, createBroadcast, attachBroadcastMessage, listBroadcasts, getBroadcast,
  listBroadcastChannels, queueOutboundMessage,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

const broadcastBody = z.object({
  name: z.string().min(1).max(128),
  templateId: z.string().uuid(),
  channelId: z.string().uuid(),
  tags: z.array(z.string().min(1).max(60)).min(1).max(20),
});

/**
 * Send one approved WhatsApp template to every contact a tag filter matches
 * (and consents to marketing, and already has a conversation on the chosen
 * channel) — reusing the exact same `outbound.send` path a single templated
 * reply already goes through (`queueOutboundMessage`,
 * `apps/worker/src/processors/outboundSend.ts`), just once per recipient
 * instead of once. Gated on `broadcast:send`, its own dedicated permission
 * (supervisor tier and up) rather than reusing `autopilot:manage`.
 */
export function registerBroadcastRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/broadcasts', async (req) => {
    ctx.guard(req, 'broadcast:send');
    return ctx.asTenant(req, (tx, actor) => listBroadcasts({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  // Only `channel:manage` (admin) can pair/administer a number, but any
  // supervisor with `broadcast:send` still needs to pick one to send from.
  app.get('/v1/broadcasts/channels', async (req) => {
    ctx.guard(req, 'broadcast:send');
    return ctx.asTenant(req, (tx, actor) => listBroadcastChannels({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.get('/v1/broadcasts/preview', async (req) => {
    ctx.guard(req, 'broadcast:send');
    const query = z.object({
      channelId: z.string().uuid(),
      tags: z.string().min(1),
    }).safeParse(req.query);
    if (!query.success) throw invalid('Check the channel and tags');
    const tags = query.data.tags.split(',').map((t) => t.trim()).filter(Boolean);

    return ctx.asTenant(req, (tx, actor) =>
      previewBroadcastSegment({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { channelId: query.data.channelId, tags }));
  });

  app.get('/v1/broadcasts/:id', async (req) => {
    ctx.guard(req, 'broadcast:send');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const broadcast = await ctx.asTenant(req, (tx, actor) =>
      getBroadcast({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { broadcastId: id }));
    if (!broadcast) throw notFound('Broadcast');
    return broadcast;
  });

  app.post('/v1/broadcasts', async (req, reply) => {
    const actor = ctx.guard(req, 'broadcast:send');
    const body = broadcastBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the broadcast fields');

    const result = await ctx.asTenant(req, async (tx) => {
      const templates = await tx.query<{ name: string; body: string; status: string }>(
        'select name, body, status from message_templates where tenant_id = $1 and id = $2',
        [actor.tenantId, body.data.templateId],
      );
      if (!templates[0]) throw notFound('Template');
      if (templates[0].status !== 'approved') {
        throw invalid('Hanya template yang sudah disetujui (approved) yang bisa dipakai untuk broadcast');
      }

      const channels = await tx.query<{ quality: string }>(
        'select quality from channels where tenant_id = $1 and id = $2', [actor.tenantId, body.data.channelId],
      );
      if (!channels[0]) throw notFound('Channel');

      const { id, recipients } = await createBroadcast({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        name: body.data.name, templateId: body.data.templateId, channelId: body.data.channelId,
        tags: body.data.tags, createdBy: actor.userId,
      });

      const rate = sendRatePerSecond(channels[0].quality as 'green' | 'yellow' | 'red' | 'flagged');
      const templateName = templates[0].name;
      const templateBodyText = templates[0].body;
      const jobs: { tenantId: string; messageId: string; delayMs: number }[] = [];

      for (let i = 0; i < recipients.length; i += 1) {
        const recipient = recipients[i]!;
        const queued = await queueOutboundMessage({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          conversationId: recipient.conversationId, body: templateBodyText, senderType: 'agent',
          senderId: actor.userId, templateName,
        });
        await attachBroadcastMessage({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          recipientId: recipient.recipientId, messageId: queued.messageId,
        });
        const delayMs = rate > 0 ? Math.floor(i / rate) * 1000 : 0;
        jobs.push({ tenantId: actor.tenantId, messageId: queued.messageId, delayMs });
      }

      return { id, jobs };
    });

    for (const job of result.jobs) {
      await ctx.dispatch({ queue: 'outbound.send', payload: { tenantId: job.tenantId, messageId: job.messageId }, delayMs: job.delayMs });
    }

    return reply.status(201).send({ id: result.id, queued: result.jobs.length });
  });
}
