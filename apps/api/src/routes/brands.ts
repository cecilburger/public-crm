import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorCan, maskPhone, invalid, notFound } from '@kirana/core';
import {
  audit, listBrands, createBrand, getBrand, updateBrand, setBrandStatus, deleteBrand, createContactFromBrand,
  openBrandConversation,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

const brandBody = z.object({
  name: z.string().min(1).max(200),
  picName: z.string().max(200).optional(),
  phone: z.string().max(32).optional(),
  email: z.string().email().max(200).optional(),
  instagram: z.string().max(120).optional(),
  website: z.string().max(300).optional(),
  category: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  source: z.enum(['scrape', 'manual', 'referral', 'other']).optional(),
  assigneeId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
});

// Loose on purpose: a bulk import row comes out of someone else's
// spreadsheet, not this app's own form — an odd-shaped email or a phone
// number with dashes in it shouldn't sink the whole row when only the name
// actually needs to be trustworthy.
const importRow = z.object({
  name: z.string().min(1).max(200),
  picName: z.string().max(200).optional(),
  phone: z.string().max(32).optional(),
  email: z.string().max(200).optional(),
  instagram: z.string().max(120).optional(),
  website: z.string().max(300).optional(),
  category: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  source: z.enum(['scrape', 'manual', 'referral', 'other']).optional(),
});

/**
 * The Brand page: a lead list for outreach, not the customer inbox. Reuses
 * its own `brand:read`/`brand:write` permission rather than `contact:*` —
 * a brand a shop is chasing for a partnership is not a customer, and never
 * becomes one just by being on this list.
 */
export function registerBrandRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/brands', async (req) => {
    ctx.guard(req, 'brand:read');

    return ctx.asTenant(req, async (tx, actor) => {
      const canReveal = actorCan(actor, 'contact:export');
      const rows = await listBrands({ tx, tenantId: actor.tenantId, kek: ctx.kek });
      return rows.map((r) => ({
        ...r,
        phone: r.phone ? (canReveal ? r.phone : maskPhone(r.phone)) : null,
      }));
    });
  });

  app.post('/v1/brands', async (req, reply) => {
    const actor = ctx.guard(req, 'brand:write');
    const body = brandBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the brand fields');

    const created = await ctx.asTenant(req, async (tx) => {
      const b = await createBrand({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        ...body.data, createdBy: actor.userId,
      });
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'brand.created',
        resourceType: 'brand', resourceId: b.id,
      });
      return b;
    });
    return reply.status(201).send(created);
  });

  /**
   * Bulk creation for the Brand Management import page — rows already parsed
   * client-side from whatever spreadsheet an agent uploaded. Each row is its
   * own `createBrand` call inside one transaction: one bad row (a name that's
   * just whitespace, say) is skipped and reported, not a reason to fail the
   * other 400 rows in the same file.
   */
  app.post('/v1/brands/import', async (req) => {
    const actor = ctx.guard(req, 'brand:write');
    const body = z.object({ rows: z.array(importRow).min(1).max(2000) }).safeParse(req.body);
    if (!body.success) throw invalid('Data import tidak valid');

    return ctx.asTenant(req, async (tx) => {
      let created = 0;
      const errors: { row: number; message: string }[] = [];
      for (let i = 0; i < body.data.rows.length; i++) {
        const row = body.data.rows[i]!;
        try {
          const b = await createBrand({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
            ...row, createdBy: actor.userId,
          });
          await audit(tx, actor.tenantId, {
            actorType: 'user', actorId: actor.userId, action: 'brand.created',
            resourceType: 'brand', resourceId: b.id, meta: { imported: true },
          });
          created += 1;
        } catch (err) {
          errors.push({ row: i + 1, message: err instanceof Error ? err.message : 'Gagal menambah' });
        }
      }
      return { created, errors };
    });
  });

  app.get('/v1/brands/:id', async (req) => {
    ctx.guard(req, 'brand:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx, actor) => {
      const canReveal = actorCan(actor, 'contact:export');
      const row = await getBrand({ tx, tenantId: actor.tenantId, kek: ctx.kek }, id);
      if (!row) throw notFound('Brand');
      return { ...row, phone: row.phone ? (canReveal ? row.phone : maskPhone(row.phone)) : null };
    });
  });

  app.patch('/v1/brands/:id', async (req) => {
    const actor = ctx.guard(req, 'brand:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = brandBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the brand fields');

    return ctx.asTenant(req, async (tx) => {
      const ok = await updateBrand({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        ...body.data, brandId: id,
      });
      if (!ok) throw notFound('Brand');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'brand.updated',
        resourceType: 'brand', resourceId: id,
      });
      return { ok: true };
    });
  });

  /** The "buat & hubungkan" shortcut on the Brand form — reuses whatever phone/email the brand already has. */
  app.post('/v1/brands/:id/contact', async (req) => {
    const actor = ctx.guard(req, 'brand:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx) => {
      const result = await createContactFromBrand({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        brandId: id, actorId: actor.userId,
      });
      if (!result) throw notFound('Brand');
      return result;
    });
  });

  /**
   * The chat icon on a Brand card/row — resolves (or creates) the brand's
   * Contact and opens/reuses a WA-bridge conversation, so it lands in the
   * internal Chat WA thread instead of handing off to wa.me.
   */
  app.post('/v1/brands/:id/chat', async (req, reply) => {
    const actor = ctx.guard(req, 'brand:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const result = await ctx.asTenant(req, (tx) =>
      openBrandConversation({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        brandId: id, actorId: actor.userId,
      }));
    if (!result.ok) {
      if (result.reason === 'not_found') throw notFound('Brand');
      throw invalid('Belum ada nomor WhatsApp yang terhubung');
    }
    return reply.status(201).send({ conversationId: result.conversationId });
  });

  app.post('/v1/brands/:id/status', async (req) => {
    const actor = ctx.guard(req, 'brand:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      status: z.enum(['not_contacted', 'contacted', 'replied', 'interested', 'rejected']),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the status');

    const ok = await ctx.asTenant(req, (tx) =>
      setBrandStatus({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        brandId: id, status: body.data.status, actorId: actor.userId,
      }));
    if (!ok) throw notFound('Brand');
    return { ok: true };
  });

  app.delete('/v1/brands/:id', async (req) => {
    const actor = ctx.guard(req, 'brand:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx) => {
      const result = await deleteBrand({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { brandId: id });
      if (!result.ok) {
        if (result.reason === 'not_found') throw notFound('Brand');
        throw invalid('Brand ini masih punya deal yang belum dihapus — hapus atau pindahkan deal-nya dulu', {
          reason: result.reason,
        });
      }
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'brand.deleted',
        resourceType: 'brand', resourceId: id,
      });
      return { ok: true };
    });
  });
}
