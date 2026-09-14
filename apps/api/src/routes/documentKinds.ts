import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid } from '@kirana/core';
import { listDocumentKinds, createDocumentKind } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * The custom "Jenis" list a tenant builds up from the Dokumen form's own
 * "+ Tambah Jenis" option — same permission tier as documents themselves,
 * since this only ever exists in service of creating/editing one.
 */
export function registerDocumentKindRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/document-kinds', async (req) => {
    ctx.guard(req, 'autopilot:manage');
    return ctx.asTenant(req, (tx, actor) => listDocumentKinds({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.post('/v1/document-kinds', async (req, reply) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const body = z.object({ name: z.string().min(1).max(60) }).safeParse(req.body);
    if (!body.success) throw invalid('Nama jenis wajib diisi');

    const created = await ctx.asTenant(req, (tx) =>
      createDocumentKind({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        name: body.data.name.trim(), createdBy: actor.userId,
      }));
    return reply.status(201).send(created);
  });
}
