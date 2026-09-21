import type { FastifyInstance } from 'fastify';
import { getAgentPerformance } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/** The one read behind the Performa Agen page. */
export function registerAgentPerformanceRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/agent-performance', async (req) => {
    ctx.guard(req, 'conversation:read');
    return ctx.asTenant(req, (tx, actor) => getAgentPerformance({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });
}
