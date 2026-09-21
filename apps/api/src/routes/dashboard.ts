import type { FastifyInstance } from 'fastify';
import { actorCan, maskPhone } from '@kirana/core';
import { getDashboardSummary, tenantKeys, openField } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/** The one read behind the Dashboard page — every number is a real aggregate. */
export function registerDashboardRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/dashboard/summary', async (req) => {
    const actor = ctx.guard(req, 'conversation:read');
    const canReveal = actorCan(actor, 'contact:export');

    return ctx.asTenant(req, async (tx, actor) => {
      const summary = await getDashboardSummary({ tx, tenantId: actor.tenantId, kek: ctx.kek });
      const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);

      return {
        ...summary,
        recentContacts: summary.recentContacts.map((c) => {
          const phone = c.phoneEnc ? openField(keys, actor.tenantId, c.phoneEnc) : null;
          return {
            id: c.id, displayName: c.displayName, tags: c.tags, lastSeenAt: c.lastSeenAt,
            phone: phone ? (canReveal ? phone : maskPhone(phone)) : null,
          };
        }),
      };
    });
  });
}
