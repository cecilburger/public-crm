import type { Ctx } from './repo.ts';
import { openField, tenantKeys } from './keys.ts';
import { audit } from './audit.ts';

export interface TaskRow {
  id: string; title: string; notes: string | null; dueAt: Date; status: string;
  kind: string; meetingLink: string | null; priority: string;
  repeatUnit: string | null; repeatInterval: number; repeatUntil: Date | null;
  contactId: string | null; contactName: string | null; contactPhone: string | null; contactEmail: string | null;
  brandId: string | null; brandName: string | null; brandPhone: string | null; brandEmail: string | null;
  dealId: string | null; dealTitle: string | null;
  assigneeId: string | null; createdBy: string | null; createdAt: Date; completedAt: Date | null;
  calendarEventId: string | null; calendarEventLink: string | null;
}

/** Every open-shop follow-up, newest due date first — for a Contact or (since a task no longer needs one) a Brand directly. */
export async function listTasks(ctx: Ctx, args: { limit?: number } = {}): Promise<TaskRow[]> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<{
    id: string; title: string; notes: string | null; due_at: Date; status: string;
    kind: string; meeting_link: string | null; priority: string;
    repeat_unit: string | null; repeat_interval: number; repeat_until: Date | null;
    contact_id: string | null; display_name: string | null; phone_enc: string | null; contact_email_enc: string | null;
    brand_id: string | null; brand_name: string | null; brand_phone_enc: string | null; brand_email_enc: string | null;
    deal_id: string | null; deal_title: string | null;
    assignee_id: string | null; created_by: string | null; created_at: Date; completed_at: Date | null;
    calendar_event_id: string | null; calendar_event_link: string | null;
  }>(
    `select tk.id, tk.title, tk.notes, tk.due_at, tk.status, tk.kind, tk.meeting_link, tk.priority,
            tk.repeat_unit, tk.repeat_interval, tk.repeat_until,
            tk.contact_id, ct.display_name, ct.phone_enc, ct.email_enc as contact_email_enc,
            tk.brand_id, br.name as brand_name, br.phone_enc as brand_phone_enc, br.email_enc as brand_email_enc,
            tk.deal_id, d.title as deal_title,
            tk.assignee_id, tk.created_by, tk.created_at, tk.completed_at,
            tk.calendar_event_id, tk.calendar_event_link
       from tasks tk
       left join contacts ct on ct.id = tk.contact_id and ct.tenant_id = tk.tenant_id
       left join brands br on br.id = tk.brand_id and br.tenant_id = tk.tenant_id
       left join deals d on d.id = tk.deal_id and d.tenant_id = tk.tenant_id
      where tk.tenant_id = $1
      order by (tk.status = 'open') desc, tk.due_at asc
      limit $2`,
    [ctx.tenantId, Math.min(args.limit ?? 300, 500)],
  );
  return rows.map((r) => ({
    id: r.id, title: r.title, notes: r.notes, dueAt: r.due_at, status: r.status,
    kind: r.kind, meetingLink: r.meeting_link, priority: r.priority,
    repeatUnit: r.repeat_unit, repeatInterval: r.repeat_interval, repeatUntil: r.repeat_until,
    contactId: r.contact_id, contactName: r.display_name,
    contactPhone: r.phone_enc ? openField(keys, ctx.tenantId, r.phone_enc) : null,
    contactEmail: r.contact_email_enc ? openField(keys, ctx.tenantId, r.contact_email_enc) : null,
    brandId: r.brand_id, brandName: r.brand_name,
    brandPhone: r.brand_phone_enc ? openField(keys, ctx.tenantId, r.brand_phone_enc) : null,
    brandEmail: r.brand_email_enc ? openField(keys, ctx.tenantId, r.brand_email_enc) : null,
    dealId: r.deal_id, dealTitle: r.deal_title,
    assigneeId: r.assignee_id, createdBy: r.created_by, createdAt: r.created_at, completedAt: r.completed_at,
    calendarEventId: r.calendar_event_id, calendarEventLink: r.calendar_event_link,
  }));
}

/** One task, for the send-meeting-email action and the Google Calendar
 * write hooks — same joins as `listTasks`, scoped to a single row. */
export async function getTask(ctx: Ctx, taskId: string): Promise<TaskRow | null> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<{
    id: string; title: string; notes: string | null; due_at: Date; status: string;
    kind: string; meeting_link: string | null; priority: string;
    repeat_unit: string | null; repeat_interval: number; repeat_until: Date | null;
    contact_id: string | null; display_name: string | null; phone_enc: string | null; contact_email_enc: string | null;
    brand_id: string | null; brand_name: string | null; brand_phone_enc: string | null; brand_email_enc: string | null;
    deal_id: string | null; deal_title: string | null;
    assignee_id: string | null; created_by: string | null; created_at: Date; completed_at: Date | null;
    calendar_event_id: string | null; calendar_event_link: string | null;
  }>(
    `select tk.id, tk.title, tk.notes, tk.due_at, tk.status, tk.kind, tk.meeting_link, tk.priority,
            tk.repeat_unit, tk.repeat_interval, tk.repeat_until,
            tk.contact_id, ct.display_name, ct.phone_enc, ct.email_enc as contact_email_enc,
            tk.brand_id, br.name as brand_name, br.phone_enc as brand_phone_enc, br.email_enc as brand_email_enc,
            tk.deal_id, d.title as deal_title,
            tk.assignee_id, tk.created_by, tk.created_at, tk.completed_at,
            tk.calendar_event_id, tk.calendar_event_link
       from tasks tk
       left join contacts ct on ct.id = tk.contact_id and ct.tenant_id = tk.tenant_id
       left join brands br on br.id = tk.brand_id and br.tenant_id = tk.tenant_id
       left join deals d on d.id = tk.deal_id and d.tenant_id = tk.tenant_id
      where tk.tenant_id = $1 and tk.id = $2`,
    [ctx.tenantId, taskId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, title: r.title, notes: r.notes, dueAt: r.due_at, status: r.status,
    kind: r.kind, meetingLink: r.meeting_link, priority: r.priority,
    repeatUnit: r.repeat_unit, repeatInterval: r.repeat_interval, repeatUntil: r.repeat_until,
    contactId: r.contact_id, contactName: r.display_name,
    contactPhone: r.phone_enc ? openField(keys, ctx.tenantId, r.phone_enc) : null,
    contactEmail: r.contact_email_enc ? openField(keys, ctx.tenantId, r.contact_email_enc) : null,
    brandId: r.brand_id, brandName: r.brand_name,
    brandPhone: r.brand_phone_enc ? openField(keys, ctx.tenantId, r.brand_phone_enc) : null,
    brandEmail: r.brand_email_enc ? openField(keys, ctx.tenantId, r.brand_email_enc) : null,
    dealId: r.deal_id, dealTitle: r.deal_title,
    assigneeId: r.assignee_id, createdBy: r.created_by, createdAt: r.created_at, completedAt: r.completed_at,
    calendarEventId: r.calendar_event_id, calendarEventLink: r.calendar_event_link,
  };
}

export async function createTask(
  ctx: Ctx,
  args: {
    contactId?: string | null; brandId?: string | null; title: string; dueAt: Date; notes?: string | null;
    dealId?: string | null; conversationId?: string | null; assigneeId?: string | null; createdBy: string;
    kind?: string; meetingLink?: string | null; priority?: string;
    repeatUnit?: string | null; repeatInterval?: number; repeatUntil?: Date | null;
  },
): Promise<{ id: string }> {
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into tasks (tenant_id, contact_id, brand_id, deal_id, conversation_id, title, notes, due_at,
                         assignee_id, created_by, kind, meeting_link, priority, repeat_unit, repeat_interval, repeat_until)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [ctx.tenantId, args.contactId ?? null, args.brandId ?? null, args.dealId ?? null, args.conversationId ?? null,
     args.title, args.notes ?? null, args.dueAt, args.assigneeId ?? null, args.createdBy,
     args.kind ?? 'follow_up', args.meetingLink ?? null, args.priority ?? 'medium',
     args.repeatUnit ?? null, args.repeatInterval ?? 1, args.repeatUntil ?? null],
  );
  const id = rows[0]!.id;
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.createdBy, action: 'task.created',
    resourceType: 'task', resourceId: id,
    meta: { contactId: args.contactId ?? null, brandId: args.brandId ?? null, dueAt: args.dueAt.toISOString() },
  });
  return { id };
}

/**
 * Records which Google Calendar event a meeting task's write landed on (or
 * clears it, on delete) — a narrow follow-up write after the Calendar API
 * call succeeds, not part of `createTask`/`updateTask` itself, since those
 * run before the Calendar write is even attempted. `meetingLink` is the
 * Google Meet URL Calendar generated when the task didn't already have one
 * of its own — `null`/omitted leaves the existing value alone (`coalesce`)
 * rather than blanking out a link someone typed in by hand.
 */
export async function setTaskCalendarEvent(
  ctx: Ctx,
  args: { taskId: string; calendarEventId: string | null; calendarEventLink: string | null; meetingLink?: string | null },
): Promise<void> {
  await ctx.tx.query(
    `update tasks set calendar_event_id = $3, calendar_event_link = $4, meeting_link = coalesce($5, meeting_link)
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, args.taskId, args.calendarEventId, args.calendarEventLink, args.meetingLink ?? null],
  );
}

/**
 * A full re-save of the editable fields — the detail drawer submits the whole
 * form every time, not a sparse patch, so every field here is written
 * directly rather than coalesced against the existing row. Status and
 * contact are deliberately absent: those change through `setTaskStatus` and
 * are not something this edit view offers to move.
 */
export async function updateTask(
  ctx: Ctx,
  args: {
    taskId: string; title: string; dueAt: Date; notes: string | null;
    dealId: string | null; assigneeId: string | null; kind: string; meetingLink: string | null;
    priority: string; repeatUnit: string | null; repeatInterval: number; repeatUntil: Date | null;
    actorId: string;
  },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update tasks set title = $3, due_at = $4, notes = $5, deal_id = $6,
            assignee_id = $7, kind = $8, meeting_link = $9, priority = $10,
            repeat_unit = $11, repeat_interval = $12, repeat_until = $13
      where tenant_id = $1 and id = $2
      returning id`,
    [ctx.tenantId, args.taskId, args.title, args.dueAt, args.notes, args.dealId,
     args.assigneeId, args.kind, args.meetingLink, args.priority,
     args.repeatUnit, args.repeatInterval, args.repeatUntil],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'task.updated',
    resourceType: 'task', resourceId: args.taskId,
  });
  return true;
}

export interface TaskKindRow {
  id: string; name: string; createdAt: Date;
}

/** Every custom "Jenis" a tenant has added, for the task form's dropdown. */
export async function listTaskKinds(ctx: Ctx): Promise<TaskKindRow[]> {
  const rows = await ctx.tx.query<{ id: string; name: string; created_at: Date }>(
    `select id, name, created_at from task_kinds where tenant_id = $1 order by lower(name) asc`,
    [ctx.tenantId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

/**
 * Adding the same name twice (racing tabs, or someone re-adding one that's
 * already there) just hands back the existing row instead of erroring — this
 * is a casual tag list, not a uniquely-named business record.
 */
export async function createTaskKind(
  ctx: Ctx, args: { name: string; createdBy: string },
): Promise<TaskKindRow> {
  const rows = await ctx.tx.query<{ id: string; name: string; created_at: Date }>(
    `insert into task_kinds (tenant_id, name, created_by) values ($1,$2,$3)
     on conflict (tenant_id, lower(name)) do update set name = task_kinds.name
     returning id, name, created_at`,
    [ctx.tenantId, args.name, args.createdBy],
  );
  return { id: rows[0]!.id, name: rows[0]!.name, createdAt: rows[0]!.created_at };
}

function advanceDueDate(from: Date, unit: string, interval: number): Date {
  const d = new Date(from);
  if (unit === 'day') d.setDate(d.getDate() + interval);
  else if (unit === 'week') d.setDate(d.getDate() + interval * 7);
  else if (unit === 'month') d.setMonth(d.getMonth() + interval);
  else if (unit === 'year') d.setFullYear(d.getFullYear() + interval);
  return d;
}

/**
 * Marking a task done or letting it go — the only two ways a follow-up ends.
 * Completing a repeating task (`repeat_unit` set) also spawns its successor,
 * cloned from the row that was just closed with `due_at` advanced by the
 * repeat rule — the series stops on its own once that date passes
 * `repeat_until`, or immediately if someone cancels instead of completing.
 */
export async function setTaskStatus(
  ctx: Ctx, args: { taskId: string; status: 'done' | 'cancelled'; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{
    id: string; contact_id: string | null; brand_id: string | null;
    deal_id: string | null; conversation_id: string | null;
    title: string; notes: string | null; due_at: Date; assignee_id: string | null;
    kind: string; meeting_link: string | null; priority: string;
    repeat_unit: string | null; repeat_interval: number; repeat_until: Date | null;
  }>(
    `update tasks set status = $3, completed_at = case when $3 = 'done' then now() else completed_at end
      where tenant_id = $1 and id = $2 and status = 'open'
      returning id, contact_id, brand_id, deal_id, conversation_id, title, notes, due_at, assignee_id,
                kind, meeting_link, priority, repeat_unit, repeat_interval, repeat_until`,
    [ctx.tenantId, args.taskId, args.status],
  );
  const task = rows[0];
  if (!task) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId,
    action: args.status === 'done' ? 'task.completed' : 'task.cancelled',
    resourceType: 'task', resourceId: args.taskId,
  });

  if (args.status === 'done' && task.repeat_unit) {
    const nextDue = advanceDueDate(task.due_at, task.repeat_unit, task.repeat_interval);
    if (!task.repeat_until || nextDue <= task.repeat_until) {
      await createTask(ctx, {
        contactId: task.contact_id, brandId: task.brand_id, dealId: task.deal_id,
        conversationId: task.conversation_id,
        title: task.title, notes: task.notes, dueAt: nextDue, assigneeId: task.assignee_id,
        createdBy: args.actorId, kind: task.kind, meetingLink: task.meeting_link, priority: task.priority,
        repeatUnit: task.repeat_unit, repeatInterval: task.repeat_interval, repeatUntil: task.repeat_until,
      });
    }
  }

  return true;
}
