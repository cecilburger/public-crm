import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorCan, maskPhone, invalid } from '@kirana/core';
import { listOrders, markOrderPaid, markOrderFulfilled, releaseOrder, purchasesByContact } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * The Pesanan page: every order in the shop, and the three manual steps an
 * owner takes on one — confirm a bank transfer arrived, mark it shipped, or
 * let go of a reservation nobody paid for. Reuses `deal:read`/`deal:write`
 * rather than a new permission — an order is the same sales activity a deal
 * is, just priced by the catalogue instead of typed in by hand.
 */
export function registerOrderRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/orders', async (req) => {
    ctx.guard(req, 'deal:read');

    return ctx.asTenant(req, async (tx, actor) => {
      const canReveal = actorCan(actor, 'contact:export');
      const rows = await listOrders({ tx, tenantId: actor.tenantId, kek: ctx.kek });
      return rows.map((o) => ({
        ...o,
        phone: o.phone ? (canReveal ? o.phone : maskPhone(o.phone)) : null,
      }));
    });
  });

  /** The Pelanggan list's "Jumlah" and "Pembelian" columns, one row per contact. */
  app.get('/v1/orders/purchases-by-contact', async (req) => {
    ctx.guard(req, 'deal:read');
    return ctx.asTenant(req, (tx, actor) =>
      purchasesByContact({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.post('/v1/orders/:id/mark-paid', async (req) => {
    const actor = ctx.guard(req, 'deal:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const ok = await ctx.asTenant(req, (tx) =>
      markOrderPaid({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { orderId: id, actorId: actor.userId }));
    if (!ok) throw invalid('Pesanan ini tidak sedang menunggu pembayaran');
    return { ok: true };
  });

  app.post('/v1/orders/:id/fulfill', async (req) => {
    const actor = ctx.guard(req, 'deal:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const ok = await ctx.asTenant(req, (tx) =>
      markOrderFulfilled({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { orderId: id, actorId: actor.userId }));
    if (!ok) throw invalid('Pesanan ini belum dibayar');
    return { ok: true };
  });

  app.post('/v1/orders/:id/cancel', async (req) => {
    const actor = ctx.guard(req, 'deal:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const result = await ctx.asTenant(req, (tx) =>
      releaseOrder({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { orderId: id, reason: 'cancelled_by_admin' }));
    if (!result.released) throw invalid('Pesanan ini tidak bisa dibatalkan dari sini');
    return { ok: true };
  });
}
