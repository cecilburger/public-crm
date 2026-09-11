import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorCan, maskPhone, invalid, notFound } from '@kirana/core';
import {
  audit, listBrands, createBrand, getBrand, updateBrand, setBrandStatus, deleteBrand,
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
      const ok = await deleteBrand({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { brandId: id });
      if (!ok) throw notFound('Brand');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'brand.deleted',
        resourceType: 'brand', resourceId: id,
      });
      return { ok: true };
    });
  });
}
