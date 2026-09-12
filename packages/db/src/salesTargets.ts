import type { Ctx } from './repo.ts';
import { audit } from './audit.ts';

export interface SalesTargetRow {
  id: string; periodStart: string; periodEnd: string; ownerId: string | null;
  amountIdr: number; notes: string | null;
  createdBy: string | null; createdAt: Date; updatedAt: Date;
}

interface SalesTargetDbRow {
  id: string; period_start: Date; period_end: Date; owner_id: string | null;
  amount_idr: string; notes: string | null;
  created_by: string | null; created_at: Date; updated_at: Date;
}

function mapRow(r: SalesTargetDbRow): SalesTargetRow {
  return {
    id: r.id, periodStart: r.period_start.toISOString().slice(0, 10),
    periodEnd: r.period_end.toISOString().slice(0, 10), ownerId: r.owner_id,
    amountIdr: Number(r.amount_idr), notes: r.notes,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const COLUMNS = 'id, period_start, period_end, owner_id, amount_idr, notes, created_by, created_at, updated_at';

/** Every target on file, most recent period first — achievement is computed by the caller from deals. */
export async function listSalesTargets(ctx: Ctx): Promise<SalesTargetRow[]> {
  const rows = await ctx.tx.query<SalesTargetDbRow>(
    `select ${COLUMNS} from sales_targets where tenant_id = $1 order by period_start desc`,
    [ctx.tenantId],
  );
  return rows.map(mapRow);
}

export async function createSalesTarget(
  ctx: Ctx,
  args: {
    periodStart: string; periodEnd: string; ownerId?: string | null; amountIdr: number;
    notes?: string | null; createdBy: string;
  },
): Promise<{ id: string }> {
  const rows = await ctx.tx.query<{ id: string }>(
    `insert into sales_targets (tenant_id, period_start, period_end, owner_id, amount_idr, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id`,
    [ctx.tenantId, args.periodStart, args.periodEnd, args.ownerId ?? null, args.amountIdr,
     args.notes ?? null, args.createdBy],
  );
  const id = rows[0]!.id;
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.createdBy, action: 'sales_target.created',
    resourceType: 'sales_target', resourceId: id,
    meta: { periodStart: args.periodStart, periodEnd: args.periodEnd, amountIdr: args.amountIdr },
  });
  return { id };
}

export async function updateSalesTarget(
  ctx: Ctx,
  args: {
    targetId: string; periodStart: string; periodEnd: string; ownerId?: string | null; amountIdr: number;
    notes?: string | null; actorId: string;
  },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update sales_targets set
        period_start = $3, period_end = $4, owner_id = $5, amount_idr = $6, notes = $7, updated_at = now()
      where tenant_id = $1 and id = $2
      returning id`,
    [ctx.tenantId, args.targetId, args.periodStart, args.periodEnd, args.ownerId ?? null, args.amountIdr,
     args.notes ?? null],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'sales_target.updated',
    resourceType: 'sales_target', resourceId: args.targetId,
    meta: { periodStart: args.periodStart, periodEnd: args.periodEnd, amountIdr: args.amountIdr },
  });
  return true;
}

export async function deleteSalesTarget(
  ctx: Ctx, args: { targetId: string; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `delete from sales_targets where tenant_id = $1 and id = $2 returning id`,
    [ctx.tenantId, args.targetId],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'sales_target.deleted',
    resourceType: 'sales_target', resourceId: args.targetId,
  });
  return true;
}
