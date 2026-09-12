import type { Ctx } from './repo.ts';
import { audit } from './audit.ts';

export type TemplateCategory = 'marketing' | 'utility' | 'authentication';
export type TemplateStatus = 'draft' | 'pending' | 'approved' | 'rejected';

export interface MessageTemplateRow {
  id: string; name: string; category: TemplateCategory; language: string; body: string;
  status: TemplateStatus; notes: string | null;
  createdBy: string | null; createdAt: Date; updatedAt: Date;
}

interface TemplateDbRow {
  id: string; name: string; category: TemplateCategory; language: string; body: string;
  status: TemplateStatus; notes: string | null;
  created_by: string | null; created_at: Date; updated_at: Date;
}

function mapRow(r: TemplateDbRow): MessageTemplateRow {
  return {
    id: r.id, name: r.name, category: r.category, language: r.language, body: r.body,
    status: r.status, notes: r.notes,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const COLUMNS = 'id, name, category, language, body, status, notes, created_by, created_at, updated_at';

/** Every template the team has on file, newest first — the settings page's one query. */
export async function listMessageTemplates(ctx: Ctx): Promise<MessageTemplateRow[]> {
  const rows = await ctx.tx.query<TemplateDbRow>(
    `select ${COLUMNS} from message_templates where tenant_id = $1 order by created_at desc`,
    [ctx.tenantId],
  );
  return rows.map(mapRow);
}

export async function createMessageTemplate(
  ctx: Ctx,
  args: {
    name: string; category: TemplateCategory; language?: string; body: string;
    status?: TemplateStatus; notes?: string | null; createdBy: string;
  },
): Promise<{ id: string }> {
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into message_templates (tenant_id, name, category, language, body, status, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning id`,
    [ctx.tenantId, args.name, args.category, args.language ?? 'id', args.body,
     args.status ?? 'draft', args.notes ?? null, args.createdBy],
  );
  const id = rows[0]!.id;
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.createdBy, action: 'message_template.created',
    resourceType: 'message_template', resourceId: id, meta: { name: args.name },
  });
  return { id };
}

export async function updateMessageTemplate(
  ctx: Ctx,
  args: {
    templateId: string; name: string; category: TemplateCategory; language?: string; body: string;
    status?: TemplateStatus; notes?: string | null; actorId: string;
  },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update message_templates set
        name = $3, category = $4, language = $5, body = $6, status = $7, notes = $8, updated_at = now()
      where tenant_id = $1 and id = $2
      returning id`,
    [ctx.tenantId, args.templateId, args.name, args.category, args.language ?? 'id', args.body,
     args.status ?? 'draft', args.notes ?? null],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'message_template.updated',
    resourceType: 'message_template', resourceId: args.templateId, meta: { name: args.name },
  });
  return true;
}

export async function deleteMessageTemplate(
  ctx: Ctx, args: { templateId: string; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `delete from message_templates where tenant_id = $1 and id = $2 returning id`,
    [ctx.tenantId, args.templateId],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'message_template.deleted',
    resourceType: 'message_template', resourceId: args.templateId,
  });
  return true;
}
