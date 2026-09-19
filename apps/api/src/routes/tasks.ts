import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorCan, maskPhone, invalid, notFound, meetingInviteEmail, resolveTenantSender } from '@kirana/core';
import {
  listTasks, createTask, updateTask, setTaskStatus, getTask, setTaskCalendarEvent,
  getDecryptedSmtpUrl, getGoogleCalendarConnection, audit, type TaskRow,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';
import { getValidAccessToken } from './googleCalendar.ts';
import {
  insertGoogleEvent, updateGoogleEvent, deleteGoogleEvent, GoogleInsufficientScopeError, GoogleAuthError,
} from '../googleCalendarClient.ts';

/** A meeting task's due date carries no explicit end time anywhere in the
 * UI — every drawer that creates one asks for a single "Kapan" moment, not
 * a range. An hour is the same assumption `meetingInviteEmail` already
 * makes implicitly (it never states a duration at all), just made
 * explicit here since Google Calendar's event model requires one. */
const DEFAULT_MEETING_DURATION_MS = 60 * 60_000;

export type CalendarStatus = 'created' | 'not_connected' | 'reconnect_required' | 'failed';

/**
 * Best-effort: a meeting task is a real, saved CRM record whether or not
 * this succeeds, so every failure here is caught and turned into a status
 * string rather than allowed to fail the request that created/edited it.
 * Reused by create and (for a task that already has a linked event) update.
 */
async function syncMeetingCalendarEvent(
  ctx: AppCtx, req: FastifyRequest, actor: { tenantId: string; userId: string },
  task: TaskRow, mode: 'create' | 'update',
): Promise<{ status: CalendarStatus; eventLink: string | null }> {
  try {
    const connection = await ctx.asTenant(req, (tx) =>
      getGoogleCalendarConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { userId: actor.userId }));
    if (!connection) return { status: 'not_connected', eventLink: null };

    const accessToken = await ctx.asTenant(req, (tx) => getValidAccessToken(ctx, tx, actor, connection));
    const attendeeEmail = task.contactEmail ?? task.brandEmail;
    const endsAt = new Date(task.dueAt.getTime() + DEFAULT_MEETING_DURATION_MS);

    if (mode === 'update' && task.calendarEventId) {
      const updated = await updateGoogleEvent({
        accessToken, eventId: task.calendarEventId, title: task.title, startsAt: task.dueAt, endsAt,
        meetingLink: task.meetingLink,
      });
      if (updated.meetingLink && !task.meetingLink) {
        await ctx.asTenant(req, (tx) =>
          setTaskCalendarEvent({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
            taskId: task.id, calendarEventId: task.calendarEventId, calendarEventLink: task.calendarEventLink,
            meetingLink: updated.meetingLink,
          }));
      }
      return { status: 'created', eventLink: task.calendarEventLink };
    }

    const event = await insertGoogleEvent({
      accessToken, title: task.title, description: task.notes, startsAt: task.dueAt, endsAt, attendeeEmail,
      meetingLink: task.meetingLink,
    });
    await ctx.asTenant(req, (tx) =>
      setTaskCalendarEvent({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        taskId: task.id, calendarEventId: event.id, calendarEventLink: event.htmlLink,
        meetingLink: task.meetingLink ? null : event.meetingLink,
      }));
    return { status: 'created', eventLink: event.htmlLink };
  } catch (err) {
    if (err instanceof GoogleInsufficientScopeError) return { status: 'reconnect_required', eventLink: null };
    if (err instanceof GoogleAuthError) return { status: 'failed', eventLink: null };
    throw err;
  }
}

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

    let calendarStatus: CalendarStatus | null = null;
    let calendarEventLink: string | null = null;
    if (body.data.kind === 'meeting') {
      const full = await ctx.asTenant(req, (tx) => getTask({ tx, tenantId: actor.tenantId, kek: ctx.kek }, task.id));
      if (full) {
        const result = await syncMeetingCalendarEvent(ctx, req, actor, full, 'create');
        calendarStatus = result.status;
        calendarEventLink = result.eventLink;
      }
    }
    return reply.status(201).send({ ...task, calendarStatus, calendarEventLink });
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

    const before = await ctx.asTenant(req, (tx) => getTask({ tx, tenantId: actor.tenantId, kek: ctx.kek }, id));

    const ok = await ctx.asTenant(req, (tx) =>
      updateTask({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        taskId: id, title: body.data.title, dueAt, notes: body.data.notes ?? null,
        dealId: body.data.dealId ?? null, assigneeId: body.data.assigneeId ?? null,
        kind: body.data.kind, meetingLink: body.data.meetingLink ?? null,
        priority: body.data.priority, repeatUnit: body.data.repeatUnit,
        repeatInterval: body.data.repeatInterval, repeatUntil, actorId: actor.userId,
      }));
    if (!ok) throw notFound('Task');

    // `syncMeetingCalendarEvent` itself decides create-vs-update from
    // whether `after.calendarEventId` is already set — covers both "this
    // meeting never had an event yet" (not connected at creation time, say)
    // and "it already does, just move it" with the one call, best-effort
    // either way like every other Calendar write here.
    let calendarStatus: CalendarStatus | null = null;
    let calendarEventLink: string | null = null;
    if (body.data.kind === 'meeting') {
      const after = await ctx.asTenant(req, (tx) => getTask({ tx, tenantId: actor.tenantId, kek: ctx.kek }, id));
      if (after) {
        const result = await syncMeetingCalendarEvent(ctx, req, actor, after, before?.calendarEventId ? 'update' : 'create');
        calendarStatus = result.status;
        calendarEventLink = result.eventLink;
      }
    }
    return { ok: true, calendarStatus, calendarEventLink };
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

    const before = await ctx.asTenant(req, (tx) => getTask({ tx, tenantId: actor.tenantId, kek: ctx.kek }, id));

    const ok = await ctx.asTenant(req, (tx) =>
      setTaskStatus({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { taskId: id, status: 'cancelled', actorId: actor.userId }));
    if (!ok) throw notFound('Task');

    if (before?.calendarEventId) {
      try {
        const connection = await ctx.asTenant(req, (tx) =>
          getGoogleCalendarConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { userId: actor.userId }));
        if (connection) {
          const accessToken = await ctx.asTenant(req, (tx) => getValidAccessToken(ctx, tx, actor, connection));
          await deleteGoogleEvent({ accessToken, eventId: before.calendarEventId });
        }
      } catch (err) {
        // Cancelling the task itself already succeeded above — a Calendar
        // cleanup failure here is logged-and-moved-on, not a reason to
        // report the cancel itself as failed.
        if (!(err instanceof GoogleAuthError)) throw err;
      }
    }
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
