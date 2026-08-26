import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import { audit } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * What Autopilot knows and what it is allowed to do.
 *
 * These are the two dials a shop owner actually needs: the catalogue it answers
 * from, and how far it may go without a person. Both are per tenant and both are
 * audited, because turning on auto-send is a decision someone should be able to
 * point at later.
 */
export function registerAutopilotRoutes(app: FastifyInstance, ctx: AppCtx): void {

  app.get('/v1/autopilot', async (req) => {
    ctx.guard(req, 'conversation:read');
    return ctx.asTenant(req, async (tx, actor) => {
      const rows = await tx.query(
        `select mode, min_confidence, may_offer_discount, may_promise_delivery,
                persona, escalate_keywords, max_reply_chars, max_replies_per_hour,
                max_replies_per_contact_per_hour
           from autopilot_settings where tenant_id = $1`,
        [actor.tenantId],
      );
      const stats = await tx.query<{ status: string; n: number }>(
        `select status, count(*)::int as n from message_drafts
          where tenant_id = $1 and created_at > now() - interval '30 days' group by status`,
        [actor.tenantId],
      );
      return {
        settings: rows[0] ?? null,
        last30Days: Object.fromEntries(stats.map((s) => [s.status, s.n])),
      };
    });
  });

  app.put('/v1/autopilot', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const body = z.object({
      mode: z.enum(['off', 'suggest', 'auto']),
      minConfidence: z.number().min(0).max(1).optional(),
      mayOfferDiscount: z.boolean().optional(),
      mayPromiseDelivery: z.boolean().optional(),
      persona: z.string().max(500).optional(),
      maxReplyChars: z.number().int().min(100).max(4000).optional(),
      maxRepliesPerHour: z.number().int().min(0).max(10_000).optional(),
      maxRepliesPerContactPerHour: z.number().int().min(0).max(1_000).optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the Autopilot settings');

    return ctx.asTenant(req, async (tx) => {
      const d = body.data;
      await tx.query(
        `insert into autopilot_settings
           (tenant_id, mode, min_confidence, may_offer_discount, may_promise_delivery,
            persona, max_reply_chars, max_replies_per_hour, max_replies_per_contact_per_hour)
         values ($1, $2, coalesce($3, 0.75), coalesce($4, false), coalesce($5, false),
                 coalesce($6, 'Ramah, sopan, ringkas. Pakai Bahasa Indonesia sehari-hari.'),
                 coalesce($7, 700), coalesce($8, 120), coalesce($9, 12))
         on conflict (tenant_id) do update set
           mode = excluded.mode,
           min_confidence = coalesce($3, autopilot_settings.min_confidence),
           may_offer_discount = coalesce($4, autopilot_settings.may_offer_discount),
           may_promise_delivery = coalesce($5, autopilot_settings.may_promise_delivery),
           persona = coalesce($6, autopilot_settings.persona),
           max_reply_chars = coalesce($7, autopilot_settings.max_reply_chars),
           max_replies_per_hour = coalesce($8, autopilot_settings.max_replies_per_hour),
           max_replies_per_contact_per_hour =
             coalesce($9, autopilot_settings.max_replies_per_contact_per_hour),
           updated_at = now()`,
        [actor.tenantId, d.mode, d.minConfidence ?? null, d.mayOfferDiscount ?? null,
         d.mayPromiseDelivery ?? null, d.persona ?? null, d.maxReplyChars ?? null,
         d.maxRepliesPerHour ?? null, d.maxRepliesPerContactPerHour ?? null],
      );
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'autopilot.settings_changed',
        resourceType: 'autopilot', meta: { mode: d.mode },
      });
      return { ok: true };
    });
  });

  app.get('/v1/knowledge', async (req) => {
    ctx.guard(req, 'conversation:read');
    return ctx.asTenant(req, (tx, actor) =>
      tx.query(
        `select id, kind, title, body, sku, price_idr, stock, tags, active, updated_at
           from knowledge_items where tenant_id = $1 order by kind, title limit 500`,
        [actor.tenantId]));
  });

  app.post('/v1/knowledge', async (req, reply) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const body = z.object({
      kind: z.enum(['product', 'faq', 'policy']),
      title: z.string().min(1).max(200),
      body: z.string().max(4000).default(''),
      sku: z.string().max(64).optional(),
      priceIdr: z.number().int().min(0).optional(),
      stock: z.number().int().min(0).optional(),
      tags: z.array(z.string().max(40)).max(20).default([]),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the catalogue entry');

    const created = await ctx.asTenant(req, async (tx) => {
      const d = body.data;
      const rows = await tx.query<{ id: string }>(
        `insert into knowledge_items (tenant_id, kind, title, body, sku, price_idr, stock, tags)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id, sku) where sku is not null
         do update set title = excluded.title, body = excluded.body,
                       price_idr = excluded.price_idr, stock = excluded.stock,
                       tags = excluded.tags, updated_at = now()
         returning id`,
        [actor.tenantId, d.kind, d.title, d.body, d.sku ?? null,
         d.priceIdr ?? null, d.stock ?? null, d.tags],
      );
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'knowledge.upserted',
        resourceType: 'knowledge_item', resourceId: rows[0]!.id, meta: { kind: d.kind, sku: d.sku ?? null },
      });
      return rows[0]!;
    });
    return reply.status(201).send(created);
  });

  app.patch('/v1/knowledge/:id', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      title: z.string().min(1).max(200).optional(),
      body: z.string().max(4000).optional(),
      sku: z.string().max(64).nullable().optional(),
      priceIdr: z.number().int().min(0).nullable().optional(),
      stock: z.number().int().min(0).nullable().optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
      active: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the fields being changed');

    return ctx.asTenant(req, async (tx) => {
      const d = body.data;
      const rows = await tx.query<{ id: string }>(
        `update knowledge_items
            set title = coalesce($3, title),
                body = coalesce($4, body),
                sku = coalesce($5, sku),
                price_idr = case when $6::bigint is null then price_idr else $6 end,
                stock = case when $7::integer is null then stock else $7 end,
                tags = coalesce($8, tags),
                active = coalesce($9, active),
                updated_at = now()
          where tenant_id = $1 and id = $2
          returning id`,
        [actor.tenantId, id, d.title ?? null, d.body ?? null, d.sku ?? null,
         d.priceIdr ?? null, d.stock ?? null, d.tags ?? null, d.active ?? null],
      );
      if (!rows[0]) throw notFound('Catalogue entry');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'knowledge.updated',
        resourceType: 'knowledge_item', resourceId: id,
        meta: { fields: Object.keys(d) },
      });
      return { ok: true };
    });
  });

  /**
   * Where the shop delivers, and for how much. Autopilot cannot quote an ongkir
   * it has not been told, and the order total is built from these rows.
   */
  app.get('/v1/shipping-rates', async (req) => {
    ctx.guard(req, 'conversation:read');
    return ctx.asTenant(req, (tx, actor) =>
      tx.query(
        `select id, area, cost_idr, eta_days from shipping_rates
          where tenant_id = $1 order by (lower(area) = 'default'), lower(area)`,
        [actor.tenantId]));
  });

  app.post('/v1/shipping-rates', async (req, reply) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const body = z.object({
      area: z.string().min(1).max(80),
      costIdr: z.number().int().min(0).max(100_000_000),
      etaDays: z.number().int().min(0).max(60).default(2),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the area and cost');

    const created = await ctx.asTenant(req, async (tx) => {
      const d = body.data;
      const rows = await tx.query<{ id: string }>(
        `insert into shipping_rates (tenant_id, area, cost_idr, eta_days)
         values ($1,$2,$3,$4)
         on conflict (tenant_id, lower(area))
         do update set cost_idr = excluded.cost_idr, eta_days = excluded.eta_days
         returning id`,
        [actor.tenantId, d.area.trim(), d.costIdr, d.etaDays],
      );
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'shipping.upserted',
        resourceType: 'shipping_rate', resourceId: rows[0]!.id, meta: { area: d.area, costIdr: d.costIdr },
      });
      return rows[0]!;
    });
    return reply.status(201).send(created);
  });

  app.delete('/v1/shipping-rates/:id', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return ctx.asTenant(req, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        'delete from shipping_rates where tenant_id = $1 and id = $2 returning id',
        [actor.tenantId, id],
      );
      if (!rows[0]) throw notFound('Shipping rate');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'shipping.removed',
        resourceType: 'shipping_rate', resourceId: id,
      });
      return { ok: true };
    });
  });

  app.delete('/v1/knowledge/:id', async (req) => {
    const actor = ctx.guard(req, 'autopilot:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return ctx.asTenant(req, async (tx) => {
      // Deactivated, not deleted: a draft that cited it should stay explainable.
      const rows = await tx.query<{ id: string }>(
        `update knowledge_items set active = false, updated_at = now()
          where tenant_id = $1 and id = $2 returning id`,
        [actor.tenantId, id],
      );
      if (!rows[0]) throw notFound('Catalogue entry');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'knowledge.deactivated',
        resourceType: 'knowledge_item', resourceId: id,
      });
      return { ok: true };
    });
  });
}
