import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import {
  listQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

const quickReplyBody = z.object({
  title: z.string().min(1).max(128),
  body: z.string().min(1).max(1024),
  shortcut: z.string().max(32).optional(),
});

/**
 * Canned snippets for the composer — low-friction by design, so any agent
 * who can send a message can also add or edit one. No approval tier, unlike
 * message templates: these never leave the 24-hour free-form window.
 */
export function registerQuickReplyRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/quick-replies', async (req) => {
    ctx.guard(req, 'conversation:read');
    return ctx.asTenant(req, (tx, actor) =>
      listQuickReplies({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.post('/v1/quick-replies', async (req, reply) => {
    const actor = ctx.guard(req, 'conversation:write');
    const body = quickReplyBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the quick reply fields');

    const created = await ctx.asTenant(req, (tx) =>
      createQuickReply({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        ...body.data, createdBy: actor.userId,
      }));
    return reply.status(201).send(created);
  });

  app.patch('/v1/quick-replies/:id', async (req) => {
    const actor = ctx.guard(req, 'conversation:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = quickReplyBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the quick reply fields');

    const ok = await ctx.asTenant(req, (tx) =>
      updateQuickReply({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        ...body.data, quickReplyId: id, actorId: actor.userId,
      }));
    if (!ok) throw notFound('Quick reply');
    return { ok: true };
  });

  app.delete('/v1/quick-replies/:id', async (req) => {
    const actor = ctx.guard(req, 'conversation:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const ok = await ctx.asTenant(req, (tx) =>
      deleteQuickReply({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { quickReplyId: id, actorId: actor.userId }));
    if (!ok) throw notFound('Quick reply');
    return { ok: true };
  });
}
