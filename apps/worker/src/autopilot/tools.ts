import {
  selectKnowledge, type KnowledgeItem,
} from '@kirana/core';
import {
  withTenant, upsertDraftOrder, setDeliveryDetails, confirmOrder, shippingCostFor,
  ordersForContact, audit, type Database,
} from '@kirana/db';

/** The shape the Messages API expects for a tool definition. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolContext {
  tenantId: string;
  conversationId: string;
  contactId: string;
  knowledge: KnowledgeItem[];
  publicBaseUrl: string;
}

export interface ToolBox {
  definitions: ToolDefinition[];
  run(name: string, input: Record<string, unknown>): Promise<unknown>;
  /** Figures the server computed this turn — the reply may quote these. */
  groundedAmounts: number[];
  /** Checkout links we issued this turn — the reply may send these. */
  groundedLinks: string[];
  /** What it actually did, for the audit trail and the console. */
  actions: { tool: string; summary: string }[];
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object', properties, required, additionalProperties: false,
});

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'cari_produk',
    description: 'Cari produk di katalog toko. Pakai ini sebelum menyebut harga atau stok apa pun.',
    input_schema: obj({ kata_kunci: { type: 'string', description: 'Kata kunci dari pertanyaan pelanggan' } }, ['kata_kunci']),
  },
  {
    name: 'cek_ongkir',
    description: 'Cek ongkos kirim ke sebuah kota atau area.',
    input_schema: obj({ kota: { type: 'string' } }, ['kota']),
  },
  {
    name: 'susun_pesanan',
    description:
      'Susun atau perbarui keranjang pesanan. Kamu hanya memberi SKU dan jumlah; harga, ongkir dan total dihitung oleh sistem. Panggil lagi kalau pelanggan mengubah pesanan.',
    input_schema: obj({
      items: {
        type: 'array',
        items: obj({ sku: { type: 'string' }, jumlah: { type: 'integer', minimum: 1 } }, ['sku', 'jumlah']),
      },
      kota: { type: ['string', 'null'], description: 'Kota tujuan kirim kalau sudah diketahui' },
    }, ['items']),
  },
  {
    name: 'simpan_alamat',
    description: 'Simpan nama penerima dan alamat pengiriman untuk pesanan yang sedang disusun.',
    input_schema: obj({
      nama_penerima: { type: 'string' },
      alamat: { type: 'string' },
      kota: { type: 'string' },
    }, ['nama_penerima', 'alamat', 'kota']),
  },
  {
    name: 'konfirmasi_pesanan',
    description:
      'Kunci pesanan dan buat halaman pembayaran. Hanya panggil setelah pelanggan setuju dengan total dan alamat sudah disimpan.',
    input_schema: obj({}, []),
  },
  {
    name: 'cek_pesanan',
    description: 'Lihat pesanan terakhir dari pelanggan ini, untuk menjawab "pesanan saya bagaimana".',
    input_schema: obj({}, []),
  },
  {
    name: 'serahkan_ke_orang',
    description: 'Serahkan percakapan ini ke manusia. Pakai kalau ragu, kalau pelanggan komplain, atau kalau permintaannya di luar katalog.',
    input_schema: obj({ alasan: { type: 'string' } }, ['alasan']),
  },
  {
    name: 'balas',
    description:
      'Kirim balasan ke pelanggan. Ini SELALU langkah terakhir — tidak ada yang sampai ke pelanggan kecuali lewat tool ini.',
    input_schema: obj({
      reply: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      intent: { type: 'string', enum: ['stock', 'price', 'shipping', 'order_status', 'return', 'complaint', 'greeting', 'other'] },
      citedSkus: { type: 'array', items: { type: 'string' } },
      claimsInStock: { type: 'boolean' },
      needsHuman: { type: 'boolean' },
      handoverReason: { type: ['string', 'null'] },
    }, ['reply', 'confidence', 'intent', 'citedSkus', 'claimsInStock', 'needsHuman', 'handoverReason']),
  },
];

export const TERMINAL_TOOLS = new Set(['balas', 'serahkan_ke_orang']);

/**
 * The chatbot's hands.
 *
 * Two properties make this safe to hand a language model:
 *
 *  1. **Nothing here quotes a price the model chose.** `susun_pesanan` takes
 *     SKUs and quantities and returns totals the server computed from the
 *     catalogue. Those totals are added to `groundedAmounts`, which is what
 *     lets the reply mention them and still pass the guardrail.
 *  2. **Nothing here is irreversible without a human's rules being satisfied.**
 *     An order cannot be confirmed without a saved address, a checkout link is
 *     the only link the reply may contain, and every write is audited.
 */
export function createToolBox(
  deps: { db: Database; kek: Buffer },
  context: ToolContext,
): ToolBox {
  const box: ToolBox = {
    definitions: TOOL_DEFINITIONS,
    groundedAmounts: [],
    groundedLinks: [],
    actions: [],
    async run(name, input) {
      const ctxFor = <T>(fn: (tx: import('@kirana/db').Sql) => Promise<T>) =>
        withTenant(deps.db, context.tenantId, fn);

      switch (name) {
        case 'cari_produk': {
          const found = selectKnowledge(context.knowledge, String(input.kata_kunci ?? ''), 8);
          box.actions.push({ tool: name, summary: `cari "${input.kata_kunci}" → ${found.length}` });
          return found.map((k) => ({
            sku: k.sku, nama: k.title, harga: k.priceIdr, stok: k.stock, catatan: k.body, jenis: k.kind,
          }));
        }

        case 'cek_ongkir': {
          const rate = await ctxFor((tx) =>
            shippingCostFor({ tx, tenantId: context.tenantId, kek: deps.kek }, String(input.kota ?? '')));
          if (rate.costIdr > 0) box.groundedAmounts.push(rate.costIdr);
          box.actions.push({ tool: name, summary: `ongkir ${input.kota} → ${rate.costIdr}` });
          return { kota: rate.area, ongkir: rate.costIdr, estimasi_hari: rate.etaDays };
        }

        case 'susun_pesanan': {
          const raw = Array.isArray(input.items) ? input.items : [];
          const lines = raw.map((i) => {
            const row = i as { sku?: unknown; jumlah?: unknown };
            return { sku: String(row.sku ?? ''), qty: Number(row.jumlah ?? 0) };
          });
          const order = await ctxFor((tx) =>
            upsertDraftOrder({ tx, tenantId: context.tenantId, kek: deps.kek }, {
              conversationId: context.conversationId, contactId: context.contactId,
              lines, shipArea: input.kota === null ? null : String(input.kota ?? '') || null,
            }));
          box.groundedAmounts.push(...order.amounts);
          box.actions.push({ tool: name, summary: `keranjang ${order.code} → ${order.totalIdr}` });
          return {
            kode: order.code,
            barang: order.lines.map((l) => ({ sku: l.sku, nama: l.title, jumlah: l.qty, harga_satuan: l.unitPriceIdr, subtotal: l.lineTotalIdr })),
            subtotal: order.subtotalIdr, ongkir: order.shippingIdr, total: order.totalIdr,
            masalah: order.problems.map((p) => p.detail),
          };
        }

        case 'simpan_alamat': {
          const order = await ctxFor(async (tx) => {
            const ctx = { tx, tenantId: context.tenantId, kek: deps.kek };
            const draft = await tx.query<{ id: string }>(
              `select id from orders where tenant_id = $1 and conversation_id = $2 and status = 'draft'`,
              [context.tenantId, context.conversationId]);
            if (!draft[0]) return null;
            return setDeliveryDetails(ctx, {
              orderId: draft[0].id,
              recipient: String(input.nama_penerima ?? ''),
              address: String(input.alamat ?? ''),
              area: String(input.kota ?? ''),
            });
          });
          if (!order) return { error: 'Belum ada pesanan yang disusun. Panggil susun_pesanan dulu.' };
          box.groundedAmounts.push(...order.amounts);
          box.actions.push({ tool: name, summary: `alamat ${order.code}` });
          return { kode: order.code, ongkir: order.shippingIdr, total: order.totalIdr, alamat_tersimpan: true };
        }

        case 'konfirmasi_pesanan': {
          const confirmed = await ctxFor(async (tx) => {
            const ctx = { tx, tenantId: context.tenantId, kek: deps.kek };
            const draft = await tx.query<{ id: string }>(
              `select id from orders where tenant_id = $1 and conversation_id = $2 and status = 'draft'`,
              [context.tenantId, context.conversationId]);
            if (!draft[0]) return null;
            return confirmOrder(ctx, { orderId: draft[0].id, publicBaseUrl: context.publicBaseUrl });
          });
          if (!confirmed || !confirmed.ok) {
            const detail = confirmed?.problem.detail ?? 'Pesanan belum bisa dikunci.';
            box.actions.push({ tool: name, summary: `gagal: ${detail}` });
            return { error: detail };
          }
          const order = confirmed.order;
          box.groundedAmounts.push(...order.amounts);
          box.groundedLinks.push(order.checkoutPath);
          box.actions.push({ tool: name, summary: `pesanan ${order.code} dikunci → ${order.totalIdr}` });
          return {
            kode: order.code, total: order.totalIdr,
            link_pembayaran: order.checkoutPath,
            catatan: 'Sebutkan kode pesanan dan total ini apa adanya.',
          };
        }

        case 'cek_pesanan': {
          const orders = await ctxFor((tx) =>
            ordersForContact({ tx, tenantId: context.tenantId, kek: deps.kek }, context.contactId));
          box.groundedAmounts.push(...orders.map((o) => o.totalIdr));
          box.actions.push({ tool: name, summary: `cek pesanan → ${orders.length}` });
          return orders.map((o) => ({ kode: o.code, status: o.status, total: o.totalIdr, kota: o.shipArea }));
        }

        case 'serahkan_ke_orang': {
          box.actions.push({ tool: name, summary: String(input.alasan ?? '') });
          return { ok: true };
        }

        default:
          return { error: `Tool ${name} tidak ada.` };
      }
    },
  };
  return box;
}

/** Written into the audit trail so a supervisor can see what the bot did. */
export async function auditToolUse(
  deps: { db: Database }, tenantId: string, conversationId: string, box: ToolBox,
): Promise<void> {
  if (box.actions.length === 0) return;
  await withTenant(deps.db, tenantId, (tx) =>
    audit(tx, tenantId, {
      actorType: 'system', action: 'autopilot.tools_used',
      resourceType: 'conversation', resourceId: conversationId,
      meta: { actions: box.actions },
    }));
}
