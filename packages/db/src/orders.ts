import { buildOrder, orderAmounts, orderCode, toMicros, fromMicros, newSecret,
         type CatalogueEntry, type OrderLineInput, type BuiltOrder } from '@kirana/core';
import type { Ctx } from './repo.ts';
import { sealField, openField, tenantKeys } from './keys.ts';
import { audit } from './audit.ts';

export interface OrderSummary {
  id: string;
  code: string;
  status: string;
  lines: { sku: string; title: string; qty: number; unitPriceIdr: number; lineTotalIdr: number }[];
  subtotalIdr: number;
  shippingIdr: number;
  totalIdr: number;
  shipArea: string | null;
  problems: BuiltOrder['problems'];
  /** Every figure the reply is allowed to quote, because we computed them. */
  amounts: number[];
}

async function catalogue(ctx: Ctx): Promise<CatalogueEntry[]> {
  const rows = await ctx.tx.query<{ id: string; sku: string | null; title: string; price_idr: string | null; stock: number | null }>(
    `select id, sku, title, price_idr, stock from knowledge_items
      where tenant_id = $1 and kind = 'product' and active and sku is not null`,
    [ctx.tenantId],
  );
  return rows.map((r) => ({
    id: r.id, sku: r.sku!, title: r.title,
    priceIdr: r.price_idr === null ? null : Number(r.price_idr),
    stock: r.stock,
  }));
}

export async function shippingCostFor(ctx: Ctx, area: string | null): Promise<{ costIdr: number; etaDays: number; area: string | null }> {
  if (!area) return { costIdr: 0, etaDays: 0, area: null };
  const rows = await ctx.tx.query<{ area: string; cost_idr: number; eta_days: number }>(
    `select area, cost_idr, eta_days from shipping_rates
      where tenant_id = $1 and (lower(area) = lower($2) or lower(area) = 'default')
      order by (lower(area) = lower($2)) desc limit 1`,
    [ctx.tenantId, area],
  );
  const row = rows[0];
  return row ? { costIdr: row.cost_idr, etaDays: row.eta_days, area: row.area } : { costIdr: 0, etaDays: 0, area: null };
}

/**
 * Build or update the basket for this conversation.
 *
 * Idempotent by design: there is one draft order per conversation, so a chatbot
 * that calls this twice in a turn revises the basket instead of creating two.
 */
export async function upsertDraftOrder(
  ctx: Ctx,
  args: { conversationId: string; contactId: string; lines: OrderLineInput[]; shipArea?: string | null },
): Promise<OrderSummary> {
  const items = await catalogue(ctx);
  const shipping = await shippingCostFor(ctx, args.shipArea ?? null);
  const built = buildOrder(args.lines, items, shipping.costIdr);

  const existing = await ctx.tx.query<{ id: string; code: string }>(
    `select id, code from orders where tenant_id = $1 and conversation_id = $2 and status = 'draft'`,
    [ctx.tenantId, args.conversationId],
  );

  let orderId = existing[0]?.id;
  let code = existing[0]?.code;

  if (!orderId) {
    code = orderCode();
    const created = await ctx.tx.query<{ id: string }>(
      `insert into orders (tenant_id, contact_id, conversation_id, code, ship_area,
                           subtotal_micros, shipping_micros, total_micros)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [ctx.tenantId, args.contactId, args.conversationId, code, shipping.area,
       toMicros(built.subtotalIdr), toMicros(built.shippingIdr), toMicros(built.totalIdr)],
    );
    orderId = created[0]!.id;
  } else {
    await ctx.tx.query(
      `update orders set ship_area = coalesce($3, ship_area),
                         subtotal_micros = $4, shipping_micros = $5, total_micros = $6, updated_at = now()
        where tenant_id = $1 and id = $2`,
      [ctx.tenantId, orderId, shipping.area,
       toMicros(built.subtotalIdr), toMicros(built.shippingIdr), toMicros(built.totalIdr)],
    );
    await ctx.tx.query('delete from order_items where tenant_id = $1 and order_id = $2', [ctx.tenantId, orderId]);
  }

  for (const line of built.lines) {
    await ctx.tx.query(
      `insert into order_items (tenant_id, order_id, knowledge_item_id, sku, title, unit_price_micros, qty, line_total_micros)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.tenantId, orderId, line.knowledgeItemId, line.sku, line.title,
       toMicros(line.unitPriceIdr), line.qty, toMicros(line.lineTotalIdr)],
    );
  }

  return {
    id: orderId!, code: code!, status: 'draft',
    lines: built.lines.map((l) => ({
      sku: l.sku, title: l.title, qty: l.qty, unitPriceIdr: l.unitPriceIdr, lineTotalIdr: l.lineTotalIdr,
    })),
    subtotalIdr: built.subtotalIdr, shippingIdr: built.shippingIdr, totalIdr: built.totalIdr,
    shipArea: shipping.area, problems: built.problems, amounts: orderAmounts(built),
  };
}

/** Delivery details are personal data and are sealed like every other one. */
export async function setDeliveryDetails(
  ctx: Ctx, args: { orderId: string; recipient?: string | null; address?: string | null; area?: string | null },
): Promise<OrderSummary | null> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<{ id: string; conversation_id: string | null; contact_id: string }>(
    `select id, conversation_id, contact_id from orders
      where tenant_id = $1 and id = $2 and status = 'draft'`,
    [ctx.tenantId, args.orderId],
  );
  if (!rows[0]) return null;

  await ctx.tx.query(
    `update orders
        set recipient_enc = coalesce($3, recipient_enc),
            address_enc = coalesce($4, address_enc),
            ship_area = coalesce($5, ship_area),
            updated_at = now()
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, args.orderId,
     args.recipient ? sealField(keys, ctx.tenantId, args.recipient) : null,
     args.address ? sealField(keys, ctx.tenantId, args.address) : null,
     args.area ?? null],
  );

  // Re-price: shipping depends on the area we just learned.
  const lines = await ctx.tx.query<{ sku: string; qty: number }>(
    'select sku, qty from order_items where tenant_id = $1 and order_id = $2', [ctx.tenantId, args.orderId]);

  return upsertDraftOrder(ctx, {
    conversationId: rows[0].conversation_id!,
    contactId: rows[0].contact_id,
    lines: lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    shipArea: args.area ?? null,
  });
}

export interface ConfirmedOrder extends OrderSummary {
  checkoutPath: string;
  dealId: string | null;
}

export type ConfirmFailure =
  | { code: 'not_found'; detail: string }
  | { code: 'empty'; detail: string }
  | { code: 'no_address'; detail: string }
  | { code: 'out_of_stock'; detail: string };

export type ConfirmResult =
  | { ok: true; order: ConfirmedOrder }
  | { ok: false; problem: ConfirmFailure };

/** Thrown inside the transaction so a partial reservation cannot survive. */
class ConfirmAborted extends Error {
  constructor(readonly problem: ConfirmFailure) { super(problem.detail); }
}

/**
 * Lock the basket, open a checkout, and put the deal on the board. This is the
 * point where a chat becomes a commitment, so it is audited.
 */
export async function confirmOrder(
  ctx: Ctx, args: { orderId: string; publicBaseUrl: string },
): Promise<ConfirmResult> {
  try {
    return { ok: true, order: await confirmOrThrow(ctx, args) };
  } catch (err) {
    if (err instanceof ConfirmAborted) return { ok: false, problem: err.problem };
    throw err;
  }
}

async function confirmOrThrow(
  ctx: Ctx, args: { orderId: string; publicBaseUrl: string },
): Promise<ConfirmedOrder> {
  const rows = await ctx.tx.query<{
    id: string; code: string; contact_id: string; conversation_id: string | null;
    subtotal_micros: string; shipping_micros: string; total_micros: string; ship_area: string | null;
    address_enc: string | null;
  }>(
    `select id, code, contact_id, conversation_id, subtotal_micros, shipping_micros,
            total_micros, ship_area, address_enc
       from orders where tenant_id = $1 and id = $2 and status = 'draft'`,
    [ctx.tenantId, args.orderId],
  );
  const order = rows[0];
  if (!order) throw new ConfirmAborted({ code: 'not_found', detail: 'Pesanan tidak ditemukan atau sudah dikunci.' });

  const items = await ctx.tx.query<{
    knowledge_item_id: string | null; sku: string; title: string; qty: number;
    unit_price_micros: string; line_total_micros: string;
  }>(
    `select knowledge_item_id, sku, title, qty, unit_price_micros, line_total_micros
       from order_items where tenant_id = $1 and order_id = $2`,
    [ctx.tenantId, order.id],
  );
  if (items.length === 0) throw new ConfirmAborted({ code: 'empty', detail: 'Keranjangnya masih kosong.' });
  // An address is required before money is asked for.
  if (!order.address_enc) {
    throw new ConfirmAborted({ code: 'no_address', detail: 'Alamat pengiriman belum disimpan.' });
  }

  // Reserve the stock, atomically, one line at a time.
  //
  // `stock >= qty` inside the UPDATE is the actual guarantee: two customers
  // confirming the last item at the same moment both run this, and exactly one
  // of them matches a row. The loser aborts the whole transaction, so nothing is
  // half-reserved and nothing is oversold.
  for (const item of items) {
    if (!item.knowledge_item_id) continue;
    const reserved = await ctx.tx.query<{ stock: number }>(
      `update knowledge_items set stock = stock - $3, updated_at = now()
        where tenant_id = $1 and id = $2 and stock >= $3
        returning stock`,
      [ctx.tenantId, item.knowledge_item_id, item.qty],
    );
    if (!reserved[0]) {
      throw new ConfirmAborted({
        code: 'out_of_stock',
        detail: `Stok ${item.title} keburu habis sebelum pesanan dikunci.`,
      });
    }
  }

  await ctx.tx.query(
    `update orders set status = 'awaiting_payment', updated_at = now() where tenant_id = $1 and id = $2`,
    [ctx.tenantId, order.id],
  );

  const code = newSecret(16);
  await ctx.tx.query(
    `insert into payment_links (tenant_id, order_id, code) values ($1,$2,$3)`,
    [ctx.tenantId, order.id, code],
  );

  // The conversation becomes a deal on the board, at the amount we computed.
  let dealId: string | null = null;
  const stage = await ctx.tx.query<{ id: string; pipeline_id: string }>(
    `select s.id, s.pipeline_id from pipeline_stages s
       join pipelines p on p.id = s.pipeline_id and p.tenant_id = s.tenant_id
      where s.tenant_id = $1 and p.is_default order by s.position asc limit 1`,
    [ctx.tenantId],
  );
  if (stage[0]) {
    const deal = await ctx.tx.query<{ id: string }>(
      `insert into deals (tenant_id, contact_id, pipeline_id, stage_id, title, amount_micros,
                          source_conversation_id, rots_at)
       values ($1,$2,$3,$4,$5,$6,$7, now() + interval '3 days') returning id`,
      [ctx.tenantId, order.contact_id, stage[0].pipeline_id, stage[0].id,
       `Pesanan ${order.code}`, order.total_micros, order.conversation_id],
    );
    dealId = deal[0]!.id;
    await ctx.tx.query('update orders set deal_id = $3 where tenant_id = $1 and id = $2',
      [ctx.tenantId, order.id, dealId]);
  }

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'system', action: 'order.confirmed', resourceType: 'order', resourceId: order.id,
    meta: { code: order.code, totalIdr: fromMicros(Number(order.total_micros)), lines: items.length },
  });

  const summary: ConfirmedOrder = {
    id: order.id, code: order.code, status: 'awaiting_payment',
    lines: items.map((i) => ({
      sku: i.sku, title: i.title, qty: i.qty,
      unitPriceIdr: fromMicros(Number(i.unit_price_micros)),
      lineTotalIdr: fromMicros(Number(i.line_total_micros)),
    })),
    subtotalIdr: fromMicros(Number(order.subtotal_micros)),
    shippingIdr: fromMicros(Number(order.shipping_micros)),
    totalIdr: fromMicros(Number(order.total_micros)),
    shipArea: order.ship_area,
    problems: [],
    amounts: [],
    checkoutPath: `${args.publicBaseUrl.replace(/\/$/, '')}/bayar/${code}`,
    dealId,
  };
  summary.amounts = [
    ...summary.lines.map((l) => l.unitPriceIdr),
    ...summary.lines.map((l) => l.lineTotalIdr),
    summary.subtotalIdr, summary.shippingIdr, summary.totalIdr,
  ].filter((n) => n > 0);
  return summary;
}

/**
 * Give the stock back. Used when an order is cancelled and by the sweeper that
 * expires unpaid orders — a reservation nobody pays for must not sit on the
 * shelf forever.
 */
export async function releaseOrder(
  ctx: Ctx, args: { orderId: string; reason: string },
): Promise<{ released: boolean; restored: number }> {
  const orders = await ctx.tx.query<{ id: string; code: string }>(
    `update orders set status = 'cancelled', updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'awaiting_payment'
      returning id, code`,
    [ctx.tenantId, args.orderId],
  );
  if (!orders[0]) return { released: false, restored: 0 };

  const items = await ctx.tx.query<{ knowledge_item_id: string | null; qty: number }>(
    'select knowledge_item_id, qty from order_items where tenant_id = $1 and order_id = $2',
    [ctx.tenantId, args.orderId],
  );
  let restored = 0;
  for (const item of items) {
    if (!item.knowledge_item_id) continue;
    await ctx.tx.query(
      `update knowledge_items set stock = stock + $3, updated_at = now()
        where tenant_id = $1 and id = $2`,
      [ctx.tenantId, item.knowledge_item_id, item.qty],
    );
    restored += item.qty;
  }

  await ctx.tx.query(
    `update payment_links set status = 'cancelled' where tenant_id = $1 and order_id = $2 and status = 'open'`,
    [ctx.tenantId, args.orderId],
  );
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'system', action: 'order.released', resourceType: 'order', resourceId: args.orderId,
    meta: { code: orders[0].code, reason: args.reason, stockRestored: restored },
  });
  return { released: true, restored };
}

export async function ordersForContact(ctx: Ctx, contactId: string, limit = 5) {
  const orders = await ctx.tx.query<{
    id: string; code: string; status: string; total_micros: string; ship_area: string | null; created_at: Date;
  }>(
    `select id, code, status, total_micros, ship_area, created_at from orders
      where tenant_id = $1 and contact_id = $2 order by created_at desc limit $3`,
    [ctx.tenantId, contactId, limit],
  );
  return orders.map((o) => ({
    id: o.id, code: o.code, status: o.status,
    totalIdr: fromMicros(Number(o.total_micros)),
    shipArea: o.ship_area, createdAt: o.created_at,
  }));
}

/** The order(s) `confirmOrder` filed under this deal — usually one. */
export async function ordersForDeal(ctx: Ctx, dealId: string) {
  const orders = await ctx.tx.query<{
    id: string; code: string; status: string; total_micros: string; ship_area: string | null; created_at: Date;
  }>(
    `select id, code, status, total_micros, ship_area, created_at from orders
      where tenant_id = $1 and deal_id = $2 order by created_at desc`,
    [ctx.tenantId, dealId],
  );
  return orders.map((o) => ({
    id: o.id, code: o.code, status: o.status,
    totalIdr: fromMicros(Number(o.total_micros)),
    shipArea: o.ship_area, createdAt: o.created_at,
  }));
}

export interface OrderListItem {
  id: string; code: string; status: string;
  contactId: string; displayName: string | null; phone: string | null;
  itemCount: number; totalIdr: number; shipArea: string | null;
  createdAt: Date; paidAt: Date | null;
}

/** Every order in the shop, newest first — the Pesanan page's one query. */
export async function listOrders(ctx: Ctx, args: { limit?: number } = {}): Promise<OrderListItem[]> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<{
    id: string; code: string; status: string; contact_id: string;
    display_name: string | null; phone_enc: string | null;
    item_count: string; total_micros: string; ship_area: string | null;
    created_at: Date; paid_at: Date | null;
  }>(
    `select o.id, o.code, o.status, o.contact_id, ct.display_name, ct.phone_enc,
            (select count(*) from order_items oi
              where oi.tenant_id = o.tenant_id and oi.order_id = o.id) as item_count,
            o.total_micros, o.ship_area, o.created_at, o.paid_at
       from orders o
       join contacts ct on ct.id = o.contact_id and ct.tenant_id = o.tenant_id
      where o.tenant_id = $1
      order by o.created_at desc
      limit $2`,
    [ctx.tenantId, Math.min(args.limit ?? 200, 500)],
  );
  return rows.map((r) => ({
    id: r.id, code: r.code, status: r.status, contactId: r.contact_id,
    displayName: r.display_name,
    phone: r.phone_enc ? openField(keys, ctx.tenantId, r.phone_enc) : null,
    itemCount: Number(r.item_count),
    totalIdr: fromMicros(Number(r.total_micros)),
    shipArea: r.ship_area, createdAt: r.created_at, paidAt: r.paid_at,
  }));
}

/**
 * Confirming a bank transfer by hand — the same manual step invoices use.
 * Only `awaiting_payment` can become `paid`; a draft has no payment link yet
 * and a cancelled/fulfilled order is done.
 */
export async function markOrderPaid(ctx: Ctx, args: { orderId: string; actorId: string }): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string; code: string }>(
    `update orders set status = 'paid', paid_at = now(), updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'awaiting_payment'
      returning id, code`,
    [ctx.tenantId, args.orderId],
  );
  if (!rows[0]) return false;

  await ctx.tx.query(
    `update payment_links set status = 'paid' where tenant_id = $1 and order_id = $2 and status = 'open'`,
    [ctx.tenantId, args.orderId],
  );
  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'order.paid_manually',
    resourceType: 'order', resourceId: args.orderId, meta: { code: rows[0].code },
  });
  return true;
}

/** Only a paid order ships — this is the last step in the order's life. */
export async function markOrderFulfilled(ctx: Ctx, args: { orderId: string; actorId: string }): Promise<boolean> {
  const rows = await ctx.tx.query<{ id: string; code: string }>(
    `update orders set status = 'fulfilled', updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'paid'
      returning id, code`,
    [ctx.tenantId, args.orderId],
  );
  if (!rows[0]) return false;

  await audit(ctx.tx, ctx.tenantId, {
    actorType: 'user', actorId: args.actorId, action: 'order.fulfilled',
    resourceType: 'order', resourceId: args.orderId, meta: { code: rows[0].code },
  });
  return true;
}

export async function readAddress(ctx: Ctx, orderId: string): Promise<{ recipient: string | null; address: string | null }> {
  const keys = await tenantKeys(ctx.tx, ctx.kek, ctx.tenantId);
  const rows = await ctx.tx.query<{ recipient_enc: string | null; address_enc: string | null }>(
    'select recipient_enc, address_enc from orders where tenant_id = $1 and id = $2', [ctx.tenantId, orderId]);
  const row = rows[0];
  return {
    recipient: row?.recipient_enc ? openField(keys, ctx.tenantId, row.recipient_enc) : null,
    address: row?.address_enc ? openField(keys, ctx.tenantId, row.address_enc) : null,
  };
}
