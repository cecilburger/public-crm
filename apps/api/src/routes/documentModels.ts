import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid } from '@kirana/core';
import { listDocumentModels, createDocumentModel } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * The custom "Model" list a tenant builds up from the Dokumen form's own
 * "+ Tambah Model" option, on top of the one built in ("Standar").
 */
export function registerDocumentModelRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/document-models', async (req) => {
    ctx.guard(req, 'autopilot:manage');
    return ctx.asTenant(req, (tx, actor) => listDocumentModels({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.post('/v1/document-models', async (req, reply) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const body = z.object({ name: z.string().min(1).max(60) }).safeParse(req.body);
    if (!body.success) throw invalid('Nama model wajib diisi');

    const created = await ctx.asTenant(req, (tx) =>
      createDocumentModel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        name: body.data.name.trim(), createdBy: actor.userId,
      }));
    return reply.status(201).send(created);
  });
}
