import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorCan, maskPhone, invalid, notFound, meetingInviteEmail, resolveTenantSender } from '@kirana/core';
import { listTasks, createTask, updateTask, setTaskStatus, getTask, getDecryptedSmtpUrl, audit } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * The Tugas page: follow-ups and reminders against a Contact or, now that
 * the table no longer requires one, a Brand prospect directly — no Contact
 * gets manufactured just to hang a task off of it. Reuses
 * `contact:read`/`contact:write`: whoever can already manage a customer's
 * follow-ups manages a brand's the same way.
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
        brandPhone: row.brandPhone ? (canReveal ? row.brandPhone : maskPhone(row.brandPhone)) : null,
      }));
    });
  });

  app.post('/v1/tasks', async (req, reply) => {
    const actor = ctx.guard(req, 'contact:write');
    const body = z.object({
      contactId: z.string().uuid().optional(),
      brandId: z.string().uuid().optional(),
      title: z.string().min(1).max(200),
      dueAt: z.string().min(1),
      notes: z.string().max(2000).optional(),
      dealId: z.string().uuid().optional(),
      assigneeId: z.string().uuid().optional(),
      kind: z.string().min(1).max(60).optional(),
      meetingLink: z.string().max(500).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      repeatUnit: z.enum(['day', 'week', 'month', 'year']).optional(),
      repeatInterval: z.number().int().positive().max(365).optional(),
      repeatUntil: z.string().optional(),
    }).refine((b) => b.contactId || b.brandId, { message: 'A contactId or brandId is required' })
      .safeParse(req.body);
    if (!body.success) throw invalid('Check the task fields');

    const dueAt = new Date(body.data.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw invalid('Check the due date');
    let repeatUntil: Date | undefined;
    if (body.data.repeatUntil) {
      repeatUntil = new Date(body.data.repeatUntil);
      if (Number.isNaN(repeatUntil.getTime())) throw invalid('Check the repeat-until date');
    }

    const task = await ctx.asTenant(req, (tx) =>
      createTask({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        contactId: body.data.contactId ?? null, brandId: body.data.brandId ?? null,
        title: body.data.title, dueAt,
        notes: body.data.notes ?? null, dealId: body.data.dealId ?? null,
        assigneeId: body.data.assigneeId ?? null, createdBy: actor.userId,
        kind: body.data.kind, meetingLink: body.data.meetingLink ?? null, priority: body.data.priority,
        repeatUnit: body.data.repeatUnit, repeatInterval: body.data.repeatInterval, repeatUntil,
      }));
    return reply.status(201).send(task);
  });

  app.patch('/v1/tasks/:id', async (req) => {
    const actor = ctx.guard(req, 'contact:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      title: z.string().min(1).max(200),
      dueAt: z.string().min(1),
      notes: z.string().max(2000).optional(),
      dealId: z.string().uuid().optional(),
      assigneeId: z.string().uuid().optional(),
      kind: z.string().min(1).max(60),
      meetingLink: z.string().max(500).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']),
      repeatUnit: z.enum(['day', 'week', 'month', 'year']).nullable(),
      repeatInterval: z.number().int().positive().max(365),
      repeatUntil: z.string().nullable(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the task fields');

    const dueAt = new Date(body.data.dueAt);
    if (Number.isNaN(dueAt.getTime())) throw invalid('Check the due date');
    let repeatUntil: Date | null = null;
    if (body.data.repeatUntil) {
      repeatUntil = new Date(body.data.repeatUntil);
      if (Number.isNaN(repeatUntil.getTime())) throw invalid('Check the repeat-until date');
    }

    const ok = await ctx.asTenant(req, (tx) =>
      updateTask({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        taskId: id, title: body.data.title, dueAt, notes: body.data.notes ?? null,
        dealId: body.data.dealId ?? null, assigneeId: body.data.assigneeId ?? null,
        kind: body.data.kind, meetingLink: body.data.meetingLink ?? null,
        priority: body.data.priority, repeatUnit: body.data.repeatUnit,
        repeatInterval: body.data.repeatInterval, repeatUntil, actorId: actor.userId,
      }));
    if (!ok) throw notFound('Task');
    return { ok: true };
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

  /**
   * The "Kirim Email" button on a Meeting task — sends the invite now,
   * synchronously, since an agent clicking it is waiting to see it land, not
   * scheduling something for later the way a billing reminder is. Recorded
   * into the same `emails` table billing uses, so support has one place to
   * check "did this actually go out" regardless of which feature sent it.
   */
  app.post('/v1/tasks/:id/send-email', async (req) => {
    const actor = ctx.guard(req, 'contact:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ to: z.string().email() }).safeParse(req.body);
    if (!body.success) throw invalid('Alamat email tidak valid');

    const task = await ctx.asTenant(req, (tx, a) => getTask({ tx, tenantId: a.tenantId, kek: ctx.kek }, id));
    if (!task) throw notFound('Task');
    if (task.kind !== 'meeting') throw invalid('Cuma tugas Meeting yang bisa dikirim lewat email');

    const message = meetingInviteEmail({
      partyName: task.brandName ?? task.contactName ?? 'Anda',
      title: task.title, dueAt: task.dueAt, meetingLink: task.meetingLink, notes: task.notes,
      to: body.data.to,
    });

    // A tenant's own SMTP settings (Pengaturan → Email) win over the
    // server-wide default when they've configured one.
    const tenantEmail = await ctx.asTenant(req, (tx, a) => getDecryptedSmtpUrl({ tx, tenantId: a.tenantId, kek: ctx.kek }));
    const sender = resolveTenantSender(ctx.env, tenantEmail);
    let status: 'sent' | 'failed' = 'sent';
    let messageId: string | null = null;
    let sendError: string | null = null;
    try {
      messageId = (await sender.send(message)).messageId;
    } catch (err) {
      status = 'failed';
      sendError = err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
    }

    await ctx.asTenant(req, async (tx) => {
      await tx.query(
        `insert into emails (tenant_id, template, recipient, subject, reference, status, message_id, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [actor.tenantId, message.template, message.to, message.subject, id, status, messageId, sendError],
      );
      if (status === 'sent') {
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'task.email_sent',
          resourceType: 'task', resourceId: id, meta: { to: body.data.to },
        });
      }
    });

    if (status === 'failed') throw invalid(`Gagal mengirim email: ${sendError}`);
    return { ok: true };
  });
}
