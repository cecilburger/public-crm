import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import { listIgComments, setIgCommentOutcome } from '@kirana/db';
import type { AppCtx } from '../app.ts';

const outcomeBody = z.object({
  publicStatus: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
  dmStatus: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
  publicReply: z.string().max(2000).nullable().optional(),
  lastError: z.string().max(500).nullable().optional(),
});

/**
 * Comments on our own posts, and what was done about each one.
 *
 * Read with `conversation:read` — seeing what people said in public on a
 * post is the same tier of visibility as seeing the inbox. Recording an
 * outcome needs `conversation:write`, because it says a reply was posted
 * under the workspace's own name.
 */
export function registerIgCommentRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/ig-comments', async (req) => {
    ctx.guard(req, 'conversation:read');
    const q = z.object({ pending: z.enum(['true', 'false']).optional() }).parse(req.query);

    return ctx.asTenant(req, (tx, actor) =>
      listIgComments({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { pendingOnly: q.pending === 'true' }));
  });

  app.patch('/v1/ig-comments/:id', async (req) => {
    ctx.guard(req, 'conversation:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = outcomeBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the comment outcome fields');

    const ok = await ctx.asTenant(req, (tx, actor) =>
      setIgCommentOutcome({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { commentId: id, ...body.data }));
    if (!ok) throw notFound('Comment');
    return { ok: true };
  });
}
