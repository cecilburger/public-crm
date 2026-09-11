import type { Ctx } from './repo.ts';
import { sealPhone, sealEmail } from './repo.ts';
import { openField, tenantKeys, type TenantKeys } from './keys.ts';
import { audit } from './audit.ts';

export type BrandSource = 'scrape' | 'manual' | 'referral' | 'other';
export type BrandStatus = 'not_contacted' | 'contacted' | 'replied' | 'interested' | 'rejected';

export interface BrandRow {
  id: string; name: string; picName: string | null; phone: string | null; email: string | null;
  instagram: string | null; website: string | null; category: string | null; city: string | null;
  source: BrandSource; status: BrandStatus; assigneeId: string | null; notes: string | null;
  lastContactedAt: Date | null; createdBy: string | null; createdAt: Date; updatedAt: Date;
}

interface BrandInput {
  name: string; picName?: string | null; phone?: string | null; email?: string | null;
  instagram?: string | null; website?: string | null; category?: string | null; city?: string | null;
  source?: BrandSource; assigneeId?: string | null; notes?: string | null;
}

interface BrandDbRow {
  id: string; name: string; pic_name: string | null; phone_enc: string | null; email_enc: string | null;
  instagram: string | null; website: string | null; category: string | null; city: string | null;
  source: BrandSource; status: BrandStatus; assignee_id: string | null; notes: string | null;
  last_contacted_at: Date | null; created_by: string | null; created_at: Date; updated_at: Date;
}

function mapBrandRow(r: BrandDbRow, keys: TenantKeys, tenantId: string): BrandRow {
  return {
    id: r.id, name: r.name, picName: r.pic_name,
    phone: r.phone_enc ? openField(keys, tenantId, r.phone_enc) : null,
    email: r.email_enc ? openField(keys, tenantId, r.email_enc) : null,
    instagram: r.instagram, website: r.website, category: r.category, city: r.city,
    source: r.source, status: r.status, assigneeId: r.assignee_id, notes: r.notes,
    lastContactedAt: r.last_contacted_at, createdBy: r.created_by,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const BRAND_COLUMNS = `id, name, pic_name, phone_enc, email_enc, instagram, website, category, city,
            source, status, assignee_id, notes, last_contacted_at, created_by, created_at, updated_at`;

/** Every brand in the outreach list, newest first — the Brand page's one query. */
export async function listBrands(ctx: Ctx, args: { limit?: number } = {}): Promise<BrandRow[]> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<BrandDbRow>(
    `select ${BRAND_COLUMNS} from brands where tenant_id = $1
      order by created_at desc
      limit $2`,
    [ctx.tenantId, Math.min(args.limit ?? 500, 1000)],
  );
  return rows.map((r) => mapBrandRow(r, keys, ctx.tenantId));
}

export async function getBrand(ctx: Ctx, brandId: string): Promise<BrandRow | null> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<BrandDbRow>(
    `select ${BRAND_COLUMNS} from brands where tenant_id = $1 and id = $2`,
    [ctx.tenantId, brandId],
  );
  return rows[0] ? mapBrandRow(rows[0], keys, ctx.tenantId) : null;
}

/** Added by hand from the Brand page, or by an import script — either way, `source` says which. */
export async function createBrand(
  ctx: Ctx, args: BrandInput & { createdBy: string },
): Promise<{ id: string }> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const phone = sealPhone(keys, ctx.tenantId, args.phone ?? null);
  const email = sealEmail(keys, ctx.tenantId, args.email ?? null);

  const rows = await ctx.tx.query<{ id: string }>(
    `insert into brands
       (tenant_id, name, pic_name, phone_enc, phone_bidx, email_enc, email_bidx, instagram, website,
        category, city, source, assignee_id, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning id`,
    [ctx.tenantId, args.name, args.picName ?? null, phone.enc, phone.bidx, email.enc, email.bidx,
     args.instagram ?? null, args.website ?? null, args.category ?? null, args.city ?? null,
     args.source ?? 'manual', args.assigneeId ?? null, args.notes ?? null, args.createdBy],
  );
  return { id: rows[0]!.id };
}

/** A form save — always writes the whole record, the way the edit page submits it. */
export async function updateBrand(
  ctx: Ctx, args: BrandInput & { brandId: string },
): Promise<boolean> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const phone = sealPhone(keys, ctx.tenantId, args.phone ?? null);
  const email = sealEmail(keys, ctx.tenantId, args.email ?? null);

  const rows = await ctx.tx.query<{ id: string }>(
    `update brands set
        name = $3, pic_name = $4, phone_enc = $5, phone_bidx = $6, email_enc = $7, email_bidx = $8,
        instagram = $9, website = $10, category = $11, city = $12, assignee_id = $13, notes = $14,
        updated_at = now()
      where tenant_id = $1 and id = $2
      returning id`,
    [ctx.tenantId, args.brandId, args.name, args.picName ?? null, phone.enc, phone.bidx, email.enc, email.bidx,
     args.instagram ?? null, args.website ?? null, args.category ?? null, args.city ?? null,
     args.assigneeId ?? null, args.notes ?? null],
  );
  return !!rows[0];
}

/**
 * The outreach funnel move — belum dihubungi → sudah dihubungi → sudah
 * reply → minat/nolak. `last_contacted_at` only moves forward with a real
 * touch, so "belum dihubungi" never picks up a timestamp.
 */
export async function setBrandStatus(
  ctx: Ctx, args: { brandId: string; status: BrandStatus; actorId: string },
): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `update brands set
        status = $3, updated_at = now(),
        last_contacted_at = case when $3 <> 'not_contacted' then now() else last_contacted_at end
      where tenant_id = $1 and id = $2
      returning id`,
    [ctx.tenantId, args.brandId, args.status],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'brand.status_changed',
    resourceType: 'brand', resourceId: args.brandId, meta: { status: args.status },
  });
  return true;
}

export async function deleteBrand(ctx: Ctx, args: { brandId: string }): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string }>(
    `delete from brands where tenant_id = $1 and id = $2 returning id`,
    [ctx.tenantId, args.brandId],
  );
  return !!rows[0];
}
