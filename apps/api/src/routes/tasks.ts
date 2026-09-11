import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorCan, maskPhone, invalid, notFound } from '@kirana/core';
import { listTasks, createTask, setTaskStatus } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * The Tugas page: follow-ups and reminders against a customer. Reuses
 * `contact:read`/`contact:write` — a task is fundamentally about a contact
 * (the deal or conversation it grew out of is optional context), so whoever
 * can already read and edit a customer can manage their follow-ups too.
 */
export function registerTaskRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/tasks', async (req) => {
    ctx.guard(req, 'contact:read');

    return ctx.asTenant(req, async (tx, actor) => {
      const canReveal = actorCan(actor, 'contact:export');
      const rows = await listTasks({ tx, tenantId: actor.tenantId, kek: ctx.kek });
      return rows.map((row) => ({
        ...row,
        contactPhone: row.contactPhone ? (canReveal ? row.contactPhone : maskPhone(row.contactPhone)) : null,
      }));
    });
  });

  app.post('/v1/tasks', async (req, reply) => {
    const actor = ctx.guard(req, 'contact:write');
    const body = z.object({
      contactId: z.string().uuid(),
      title: z.string().min(1).max(200),
      dueAt: z.string().min(1),
      notes: z.string().max(2000).optional(),
      dealId: z.string().uuid().optional(),
      assigneeId: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the task fields');

    const dueAt = new Date(body.data.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw invalid('Check the due date');

    const task = await ctx.asTenant(req, (tx) =>
      createTask({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        contactId: body.data.contactId, title: body.data.title, dueAt,
        notes: body.data.notes ?? null, dealId: body.data.dealId ?? null,
        assigneeId: body.data.assigneeId ?? null, createdBy: actor.userId,
      }));
    return reply.status(201).send(task);
  });

  app.post('/v1/tasks/:id/done', async (req) => {
    const actor = ctx.guard(req, 'contact:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const ok = await ctx.asTenant(req, (tx) =>
      setTaskStatus({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { taskId: id, status: 'done', actorId: actor.userId }));
    if (!ok) throw notFound('Task');
    return { ok: true };
  });

  app.post('/v1/tasks/:id/cancel', async (req) => {
    const actor = ctx.guard(req, 'contact:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const ok = await ctx.asTenant(req, (tx) =>
      setTaskStatus({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { taskId: id, status: 'cancelled', actorId: actor.userId }));
    if (!ok) throw notFound('Task');
    return { ok: true };
  });
}
