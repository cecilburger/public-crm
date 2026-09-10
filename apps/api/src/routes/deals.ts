import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import { audit, getDeal, updateDeal, dealActivity, ordersForDeal } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * The deal detail page: everything a kanban card has no room for — notes, a
 * target close date, the order(s) it turned into, and its own slice of the
 * audit chain. Stage movement stays where it already lived, on
 * `PATCH /v1/deals/:id` in conversations.ts; this only adds what that route
 * never touched.
 */
export function registerDealRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/deals/:id', async (req) => {
    ctx.guard(req, 'deal:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx, actor) => {
      const deal = await getDeal({ tx, tenantId: actor.tenantId, kek: ctx.kek }, id);
      if (!deal) throw notFound('Deal');

      const [orders, activity] = await Promise.all([
        ordersForDeal({ tx, tenantId: actor.tenantId, kek: ctx.kek }, id),
        dealActivity({ tx, tenantId: actor.tenantId, kek: ctx.kek }, id),
      ]);
      return { deal, orders, activity };
    });
  });

  app.patch('/v1/deals/:id/details', async (req) => {
    const actor = ctx.guard(req, 'deal:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      notes: z.string().max(4000).nullable().optional(),
      expectedCloseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the deal fields');
    if (body.data.notes === undefined && body.data.expectedCloseOn === undefined) {
      throw invalid('Nothing to update');
    }

    const ok = await ctx.asTenant(req, async (tx) => {
      const updated = await updateDeal({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        dealId: id, notes: body.data.notes, expectedCloseOn: body.data.expectedCloseOn,
      });
      if (updated) {
        // The note's own text stays out of the audit trail — it's free text
        // about the deal, not an event worth duplicating; the date is not
        // sensitive and is worth keeping as context.
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'deal.updated',
          resourceType: 'deal', resourceId: id,
          meta: {
            ...(body.data.notes !== undefined ? { notes: true } : {}),
            ...(body.data.expectedCloseOn !== undefined ? { expectedCloseOn: body.data.expectedCloseOn } : {}),
          },
        });
      }
      return updated;
    });
    if (!ok) throw notFound('Deal');
    return { ok: true };
  });
}
