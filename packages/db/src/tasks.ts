import type { Ctx } from './repo.ts';
import { openField, tenantKeys } from './keys.ts';
import { audit } from './audit.ts';

export interface TaskRow {
  id: string; title: string; notes: string | null; dueAt: Date; status: string;
  contactId: string; contactName: string | null; contactPhone: string | null;
  dealId: string | null; dealTitle: string | null;
  assigneeId: string | null; createdBy: string | null; createdAt: Date; completedAt: Date | null;
}

/** Every open-shop follow-up, newest due date first. */
export async function listTasks(ctx: Ctx, args: { limit?: number } = {}): Promise<TaskRow[]> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<{
    id: string; title: string; notes: string | null; due_at: Date; status: string;
    contact_id: string; display_name: string | null; phone_enc: string | null;
    deal_id: string | null; deal_title: string | null;
    assignee_id: string | null; created_by: string | null; created_at: Date; completed_at: Date | null;
  }>(
    `select tk.id, tk.title, tk.notes, tk.due_at, tk.status,
            tk.contact_id, ct.display_name, ct.phone_enc,
            tk.deal_id, d.title as deal_title,
            tk.assignee_id, tk.created_by, tk.created_at, tk.completed_at
       from tasks tk
       join contacts ct on ct.id = tk.contact_id and ct.tenant_id = tk.tenant_id
       left join deals d on d.id = tk.deal_id and d.tenant_id = tk.tenant_id
      where tk.tenant_id = $1
      order by (tk.status = 'open') desc, tk.due_at asc
      limit $2`,
    [ctx.tenantId, Math.min(args.limit ?? 300, 500)],
  );
  return rows.map((r) => ({
    id: r.id, title: r.title, notes: r.notes, dueAt: r.due_at, status: r.status,
    contactId: r.contact_id, contactName: r.display_name,
    contactPhone: r.phone_enc ? openField(keys, ctx.tenantId, r.phone_enc) : null,
    dealId: r.deal_id, dealTitle: r.deal_title,
    assigneeId: r.assignee_id, createdBy: r.created_by, createdAt: r.created_at, completedAt: r.completed_at,
  }));
}

export async function createTask(
  ctx: Ctx,
  args: {
    contactId: string; title: string; dueAt: Date; notes?: string | null;
    dealId?: string | null; conversationId?: string | null; assigneeId?: string | null; createdBy: string;
  },
): Promise<{ id: string }> {
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into tasks (tenant_id, contact_id, deal_id, conversation_id, title, notes, due_at, assignee_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, args.contactId, args.dealId ?? null, args.conversationId ?? null, args.title,
     args.notes ?? null, args.dueAt, args.assigneeId ?? null, args.createdBy],
  );
  const id = rows[0]!.id;
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.createdBy, action: 'task.created',
    resourceType: 'task', resourceId: id, meta: { contactId: args.contactId, dueAt: args.dueAt.toISOString() },
  });
  return { id };
}

/** Marking a task done or letting it go — the only two ways a follow-up ends. */
export async function setTaskStatus(
  ctx: Ctx, args: { taskId: string; status: 'done' | 'cancelled'; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update tasks set status = $3, completed_at = case when $3 = 'done' then now() else completed_at end
      where tenant_id = $1 and id = $2 and status = 'open'
      returning id`,
    [ctx.tenantId, args.taskId, args.status],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId,
    action: args.status === 'done' ? 'task.completed' : 'task.cancelled',
    resourceType: 'task', resourceId: args.taskId,
  });
  return true;
}
