import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import {
  listMessageTemplates, createMessageTemplate, updateMessageTemplate, deleteMessageTemplate,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

const templateBody = z.object({
  name: z.string().min(1).max(128),
  category: z.enum(['marketing', 'utility', 'authentication']),
  language: z.string().min(2).max(10).optional(),
  body: z.string().min(1).max(1024),
  status: z.enum(['draft', 'pending', 'approved', 'rejected']).optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * A reference list of Meta-approved WhatsApp templates — not a submission
 * flow. Anyone who can read conversations can browse it while composing a
 * reply; editing it needs `autopilot:manage`, the same tier that already
 * owns the product catalogue Autopilot reads from.
 */
export function registerMessageTemplateRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/message-templates', async (req) => {
    ctx.guard(req, 'conversation:read');
    return ctx.asTenant(req, (tx, actor) =>
      listMessageTemplates({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.post('/v1/message-templates', async (req, reply) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const body = templateBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the template fields');

    try {
      const created = await ctx.asTenant(req, (tx) =>
        createMessageTemplate({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          ...body.data, createdBy: actor.userId,
        }));
      return reply.status(201).send(created);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw invalid('Sudah ada template dengan nama ini');
      }
      throw err;
    }
  });

  app.patch('/v1/message-templates/:id', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = templateBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the template fields');

    try {
      const ok = await ctx.asTenant(req, (tx) =>
        updateMessageTemplate({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          ...body.data, templateId: id, actorId: actor.userId,
        }));
      if (!ok) throw notFound('Template');
      return { ok: true };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw invalid('Sudah ada template dengan nama ini');
      }
      throw err;
    }
  });

  app.delete('/v1/message-templates/:id', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const ok = await ctx.asTenant(req, (tx) =>
      deleteMessageTemplate({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { templateId: id, actorId: actor.userId }));
    if (!ok) throw notFound('Template');
    return { ok: true };
  });
}
