import type { Ctx } from './repo.ts';
import { sealPhone, sealEmail, createContact, upsertContactByPhone, ensureConversation, listWaBridgeChannels } from './repo.ts';
import { openField, tenantKeys, type TenantKeys } from './keys.ts';
import { audit } from './audit.ts';

export type BrandSource = 'scrape' | 'manual' | 'referral' | 'other';
export type BrandStatus = 'not_contacted' | 'contacted' | 'replied' | 'interested' | 'rejected';

export interface BrandRow {
  id: string; name: string; picName: string | null; phone: string | null; email: string | null;
  instagram: string | null; website: string | null; category: string | null; city: string | null;
  source: BrandSource; status: BrandStatus; assigneeId: string | null; notes: string | null;
  contactId: string | null;
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
  contact_id: string | null;
  last_contacted_at: Date | null; created_by: string | null; created_at: Date; updated_at: Date;
}

function mapBrandRow(r: BrandDbRow, keys: TenantKeys, tenantId: string): BrandRow {
  return {
    id: r.id, name: r.name, picName: r.pic_name,
    phone: r.phone_enc ? openField(keys, tenantId, r.phone_enc) : null,
    email: r.email_enc ? openField(keys, tenantId, r.email_enc) : null,
    instagram: r.instagram, website: r.website, category: r.category, city: r.city,
    source: r.source, status: r.status, assigneeId: r.assignee_id, notes: r.notes,
    contactId: r.contact_id,
    lastContactedAt: r.last_contacted_at, createdBy: r.created_by,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const BRAND_COLUMNS = `id, name, pic_name, phone_enc, email_enc, instagram, website, category, city,
            source, status, assignee_id, notes, contact_id, last_contacted_at, created_by, created_at, updated_at`;

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
 * Makes this brand's own PIC into a real Contact, using whatever phone/email
 * is already on the brand — the one field the two records share, so no data
 * gets typed twice. Not tagged `customer`: existing merely as a Contact is
 * what lets a Task or Deal point at this person, but "in Pelanggan" is a
 * separate, later fact (the deal actually closing).
 *
 * A phone number is looked up first, not inserted blind — the same person
 * may already be a Contact from an earlier WA chat, and `contacts` has a
 * unique index on phone, so a naive insert here would just crash on that.
 */
export async function createContactFromBrand(
  ctx: Ctx, args: { brandId: string; actorId: string },
): Promise<{ contactId: string } | null> {
  const brand = await getBrand(ctx, args.brandId);
  if (!brand) return null;

  const contactId = brand.phone
    ? (await upsertContactByPhone(ctx, { phone: brand.phone, displayName: brand.picName ?? brand.name })).id
    : (await createContact(ctx, {
        displayName: brand.picName ?? brand.name, phone: null, email: brand.email,
        tags: [], address: null, notes: `PIC brand ${brand.name}`,
      })).id;

  await ctx.tx.query(
    `update brands set contact_id = $3, updated_at = now() where tenant_id = $1 and id = $2`,
    [ctx.tenantId, args.brandId, contactId],
  );
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'brand.contact_created',
    resourceType: 'brand', resourceId: args.brandId, meta: { contactId },
  });
  return { contactId };
}

/**
 * The chat icon on a Brand card/row — opens the internal WA-bridge thread
 * instead of handing off to wa.me. Resolves (or creates) the brand's Contact
 * first, same plumbing as the Tugas quick-actions, then opens or reuses a
 * conversation on whichever WA-bridge number is actually connected right
 * now — chatting first doesn't require the brand to have messaged in.
 */
export async function openBrandConversation(
  ctx: Ctx, args: { brandId: string; actorId: string },
): Promise<{ ok: true; conversationId: string } | { ok: false; reason: 'not_found' | 'no_channel' }> {
  const brand = await getBrand(ctx, args.brandId);
  if (!brand) return { ok: false, reason: 'not_found' };

  const contactId = brand.contactId
    ?? (await createContactFromBrand(ctx, { brandId: args.brandId, actorId: args.actorId }))?.contactId;
  if (!contactId) return { ok: false, reason: 'not_found' };

  const channels = await listWaBridgeChannels(ctx);
  const channel = channels.find((c) => c.session_status === 'ready') ?? channels[0];
  if (!channel) return { ok: false, reason: 'no_channel' };

  const { id: conversationId } = await ensureConversation(ctx, { contactId, channelId: channel.id });
  return { ok: true, conversationId };
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

/**
 * A task or deal anchored only to this brand (no contact) has nothing left
 * to attach to once the brand is gone — `on delete set null` on `brand_id`
 * would otherwise leave it violating its own "contact or brand" check.
 *
 * A task like that is just a reminder, safe to clear out along with the
 * brand it was about. A deal like that is pipeline data — real amounts and
 * stage history — so this refuses to delete the brand at all rather than
 * quietly destroying it; the agent deletes or reassigns the deal first, the
 * same deliberate, confirmed step deleting a deal already asks for.
 */
export async function deleteBrand(
  ctx: Ctx, args: { brandId: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'has_deals' }> {
  const orphanDeals = await ctx.tx.query<{ id: string }>(
    `select id from deals where tenant_id = $1 and brand_id = $2 and contact_id is null`,
    [ctx.tenantId, args.brandId],
  );
  if (orphanDeals.length > 0) return { ok: false, reason: 'has_deals' };

  await ctx.tx.query(
    `delete from tasks where tenant_id = $1 and brand_id = $2 and contact_id is null`,
    [ctx.tenantId, args.brandId],
  );

  const rows = await ctx.tx.query<{ id: string }>(
    `delete from brands where tenant_id = $1 and id = $2 returning id`,
    [ctx.tenantId, args.brandId],
  );
  return rows[0] ? { ok: true } : { ok: false, reason: 'not_found' };
}
