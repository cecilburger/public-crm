import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import {
  listSalesTargets, createSalesTarget, updateSalesTarget, deleteSalesTarget,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const targetBody = z.object({
  periodStart: dateStr,
  periodEnd: dateStr,
  ownerId: z.string().uuid().optional(),
  amountIdr: z.coerce.number().positive(),
  notes: z.string().max(2000).optional(),
}).refine((v) => v.periodEnd >= v.periodStart, { message: 'Periode akhir harus setelah periode awal' });

/**
 * Sales quotas — team-wide (no ownerId) or per agent. Reading them is part of
 * everyday sales visibility (`deal:read`); only a supervisor tier sets them,
 * the same bar as the message template registry.
 */
export function registerSalesTargetRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/sales-targets', async (req) => {
    ctx.guard(req, 'deal:read');
    return ctx.asTenant(req, (tx, actor) =>
      listSalesTargets({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.post('/v1/sales-targets', async (req, reply) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const body = targetBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the target fields');

    const created = await ctx.asTenant(req, (tx) =>
      createSalesTarget({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        ...body.data, ownerId: body.data.ownerId ?? null, createdBy: actor.userId,
      }));
    return reply.status(201).send(created);
  });

  app.patch('/v1/sales-targets/:id', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = targetBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the target fields');

    const ok = await ctx.asTenant(req, (tx) =>
      updateSalesTarget({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        ...body.data, ownerId: body.data.ownerId ?? null, targetId: id, actorId: actor.userId,
      }));
    if (!ok) throw notFound('Sales target');
    return { ok: true };
  });

  app.delete('/v1/sales-targets/:id', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const ok = await ctx.asTenant(req, (tx) =>
      deleteSalesTarget({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { targetId: id, actorId: actor.userId }));
    if (!ok) throw notFound('Sales target');
    return { ok: true };
  });
}
