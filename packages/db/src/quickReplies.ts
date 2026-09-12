import type { Ctx } from './repo.ts';
import { audit } from './audit.ts';

export interface QuickReplyRow {
  id: string; title: string; body: string; shortcut: string | null;
  createdBy: string | null; createdAt: Date; updatedAt: Date;
}

interface QuickReplyDbRow {
  id: string; title: string; body: string; shortcut: string | null;
  created_by: string | null; created_at: Date; updated_at: Date;
}

function mapRow(r: QuickReplyDbRow): QuickReplyRow {
  return {
    id: r.id, title: r.title, body: r.body, shortcut: r.shortcut,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const COLUMNS = 'id, title, body, shortcut, created_by, created_at, updated_at';

/** Every saved snippet, newest first — both the settings editor and the composer picker use this. */
export async function listQuickReplies(ctx: Ctx): Promise<QuickReplyRow[]> {
  const rows = await ctx.tx.query<QuickReplyDbRow>(
    `select ${COLUMNS} from quick_replies where tenant_id = $1 order by created_at desc`,
    [ctx.tenantId],
  );
  return rows.map(mapRow);
}

export async function createQuickReply(
  ctx: Ctx,
  args: { title: string; body: string; shortcut?: string | null; createdBy: string },
): Promise<{ id: string }> {
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into quick_replies (tenant_id, title, body, shortcut, created_by)
     values ($1,$2,$3,$4,$5)
     returning id`,
    [ctx.tenantId, args.title, args.body, args.shortcut ?? null, args.createdBy],
  );
  const id = rows[0]!.id;
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.createdBy, action: 'quick_reply.created',
    resourceType: 'quick_reply', resourceId: id, meta: { title: args.title },
  });
  return { id };
}

export async function updateQuickReply(
  ctx: Ctx,
  args: { quickReplyId: string; title: string; body: string; shortcut?: string | null; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update quick_replies set title = $3, body = $4, shortcut = $5, updated_at = now()
      where tenant_id = $1 and id = $2
      returning id`,
    [ctx.tenantId, args.quickReplyId, args.title, args.body, args.shortcut ?? null],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'quick_reply.updated',
    resourceType: 'quick_reply', resourceId: args.quickReplyId, meta: { title: args.title },
  });
  return true;
}

export async function deleteQuickReply(
  ctx: Ctx, args: { quickReplyId: string; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `delete from quick_replies where tenant_id = $1 and id = $2 returning id`,
    [ctx.tenantId, args.quickReplyId],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'quick_reply.deleted',
    resourceType: 'quick_reply', resourceId: args.quickReplyId,
  });
  return true;
}
