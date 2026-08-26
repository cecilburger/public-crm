import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fromMicros } from '@kirana/core';
import { withTenant, withoutTenant } from '@kirana/db';
import type { AppCtx } from '../app.ts';

const rp = (n: number) => `Rp ${n.toLocaleString('id-ID')}`;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * The page a customer opens from the chat.
 *
 * The link is a capability: a 128-bit code is the only credential, so the page
 * shows what the buyer already knows — their own basket — and deliberately not
 * their full address. If a link is forwarded, the damage is bounded to an order
 * summary rather than a home address.
 *
 * Payment itself is a bank transfer today. A provider (Xendit, Midtrans) plugs
 * in exactly here: create the invoice at confirm time, store its URL on the
 * payment link, and redirect instead of rendering.
 */
export function registerCheckoutRoutes(app: FastifyInstance, ctx: AppCtx): void {

  app.get('/bayar/:code', async (req, reply) => {
    const params = z.object({ code: z.string().min(10).max(64) }).safeParse(req.params);
    if (!params.success) return reply.status(404).type('text/html').send(page404());

    const links = await withoutTenant(ctx.control, 'resolving a public checkout link', (tx) =>
      tx.query<{ tenant_id: string; order_id: string; status: string; expires_at: Date }>(
        'select tenant_id, order_id, status, expires_at from payment_links where code = $1',
        [params.data.code],
      ));
    const link = links[0];
    if (!link) return reply.status(404).type('text/html').send(page404());
    if (new Date(link.expires_at) < new Date()) {
      return reply.status(410).type('text/html').send(pageMessage('Link ini sudah kedaluwarsa', 'Hubungi tokonya lewat WhatsApp untuk link baru.'));
    }

    const view = await withTenant(ctx.db, link.tenant_id, async (tx) => {
      const orders = await tx.query<{
        code: string; status: string; subtotal_micros: string; shipping_micros: string;
        total_micros: string; ship_area: string | null;
      }>(
        `select code, status, subtotal_micros, shipping_micros, total_micros, ship_area
           from orders where tenant_id = $1 and id = $2`,
        [link.tenant_id, link.order_id],
      );
      if (!orders[0]) return null;

      const items = await tx.query<{ title: string; qty: number; unit_price_micros: string; line_total_micros: string }>(
        'select title, qty, unit_price_micros, line_total_micros from order_items where tenant_id = $1 and order_id = $2',
        [link.tenant_id, link.order_id],
      );
      const shop = await tx.query<{ name: string }>('select name from tenants where id = $1', [link.tenant_id]);
      const payment = await tx.query<{ body: string }>(
        `select body from knowledge_items
          where tenant_id = $1 and kind = 'policy' and active and lower(title) like '%bayar%' limit 1`,
        [link.tenant_id],
      );
      return { order: orders[0], items, shop: shop[0]?.name ?? 'Toko', payment: payment[0]?.body ?? null };
    });

    if (!view) return reply.status(404).type('text/html').send(page404());

    return reply.type('text/html').send(pageOrder({
      shop: view.shop,
      code: view.order.code,
      status: view.order.status,
      area: view.order.ship_area,
      items: view.items.map((i) => ({
        title: i.title, qty: i.qty,
        unitIdr: fromMicros(Number(i.unit_price_micros)),
        totalIdr: fromMicros(Number(i.line_total_micros)),
      })),
      subtotalIdr: fromMicros(Number(view.order.subtotal_micros)),
      shippingIdr: fromMicros(Number(view.order.shipping_micros)),
      totalIdr: fromMicros(Number(view.order.total_micros)),
      payment: view.payment,
    }));
  });
}

interface OrderView {
  shop: string; code: string; status: string; area: string | null;
  items: { title: string; qty: number; unitIdr: number; totalIdr: number }[];
  subtotalIdr: number; shippingIdr: number; totalIdr: number; payment: string | null;
}

const shell = (title: string, body: string) => `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escape(title)}</title>
<style>
:root{--bg:#F4F4F9;--panel:#fff;--ink:#16183C;--ink2:#565A80;--line:#E0DFEC;--brand:#2F31A8;--accent:#A9690A}
@media(prefers-color-scheme:dark){:root{--bg:#08091C;--panel:#101230;--ink:#EDECF8;--ink2:#A3A5C8;--line:#232659;--brand:#8385F2;--accent:#EFB253}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:22px 16px}
.wrap{max-width:460px;margin:0 auto}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:14px}
h1{font-size:19px;margin:0 0 4px}
.muted{color:var(--ink2);font-size:13.5px}
table{width:100%;border-collapse:collapse;margin-top:14px;font-size:14px}
td{padding:7px 0;border-bottom:1px solid var(--line);vertical-align:top}
td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
.total td{font-weight:700;font-size:16px;padding-top:12px;border-top:2px solid var(--line)}
.chip{display:inline-block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:6px;background:var(--brand);color:var(--panel)}
.pay{white-space:pre-wrap;font-size:14px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:10px}
.code{font-family:ui-monospace,Menlo,monospace;font-size:17px;letter-spacing:.06em;color:var(--accent);font-weight:700}
</style></head><body><div class="wrap">${body}</div></body></html>`;

const page404 = () => shell('Tidak ditemukan',
  `<div class="card"><h1>Halaman tidak ditemukan</h1><p class="muted">Link pembayaran ini tidak berlaku.</p></div>`);

const pageMessage = (title: string, note: string) => shell(title,
  `<div class="card"><h1>${escape(title)}</h1><p class="muted">${escape(note)}</p></div>`);

function pageOrder(v: OrderView): string {
  const rows = v.items.map((i) => `<tr>
      <td>${escape(i.title)}<br><span class="muted">${i.qty} × ${rp(i.unitIdr)}</span></td>
      <td class="n">${rp(i.totalIdr)}</td></tr>`).join('');

  const status = v.status === 'paid'
    ? '<span class="chip">Sudah dibayar</span>'
    : '<span class="chip">Menunggu pembayaran</span>';

  return shell(`Pesanan ${v.code} · ${v.shop}`, `
  <div class="card">
    <h1>${escape(v.shop)}</h1>
    <p class="muted">Pesanan <span class="code">${escape(v.code)}</span></p>
    <p style="margin-top:10px">${status}</p>
    <table>
      ${rows}
      <tr><td>Subtotal</td><td class="n">${rp(v.subtotalIdr)}</td></tr>
      <tr><td>Ongkir${v.area ? ` — ${escape(v.area)}` : ''}</td><td class="n">${rp(v.shippingIdr)}</td></tr>
      <tr class="total"><td>Total</td><td class="n">${rp(v.totalIdr)}</td></tr>
    </table>
  </div>
  <div class="card">
    <h1 style="font-size:16px">Cara bayar</h1>
    ${v.payment
      ? `<div class="pay">${escape(v.payment)}</div>`
      : `<p class="muted">Balas di WhatsApp untuk cara pembayaran.</p>`}
    <p class="muted" style="margin-top:12px">Sebutkan kode <span class="code">${escape(v.code)}</span> saat konfirmasi.</p>
  </div>`);
}
