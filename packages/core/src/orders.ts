/**
 * Order arithmetic. Pure, integer rupiah, no I/O.
 *
 * This module exists so that the chatbot cannot do the maths. It supplies SKUs
 * and quantities; prices, line totals, shipping and the grand total are computed
 * here from the catalogue the shop maintains. A model that never touches a
 * number cannot get a number wrong.
 */

export interface CatalogueEntry {
  id: string;
  sku: string;
  title: string;
  priceIdr: number | null;
  stock: number | null;
}

export interface OrderLineInput {
  sku: string;
  qty: number;
}

export interface OrderLine {
  knowledgeItemId: string;
  sku: string;
  title: string;
  unitPriceIdr: number;
  qty: number;
  lineTotalIdr: number;
}

export type OrderProblemCode = 'unknown_sku' | 'no_price' | 'out_of_stock' | 'bad_quantity' | 'empty_order';

export interface OrderProblem {
  code: OrderProblemCode;
  sku?: string;
  /** Said in Indonesian, because it is handed straight back to the model. */
  detail: string;
}

export interface BuiltOrder {
  lines: OrderLine[];
  subtotalIdr: number;
  shippingIdr: number;
  totalIdr: number;
  problems: OrderProblem[];
}

export const MAX_QTY_PER_LINE = 999;

export function buildOrder(
  inputs: OrderLineInput[],
  catalogue: CatalogueEntry[],
  shippingIdr = 0,
): BuiltOrder {
  const bySku = new Map(catalogue.filter((c) => c.sku).map((c) => [c.sku.toLowerCase(), c]));
  const lines: OrderLine[] = [];
  const problems: OrderProblem[] = [];

  // Two mentions of the same SKU are one line, not two — a chatbot correcting
  // itself mid-conversation should not double the basket.
  const merged = new Map<string, number>();
  for (const input of inputs) {
    const key = (input.sku ?? '').trim().toLowerCase();
    if (!key) continue;
    // Deliberately not truncated: "1.5" is a mistake to report, not a number to
    // round. Silently shipping 1 when the basket said 1.5 is how a customer
    // ends up arguing with an invoice.
    merged.set(key, (merged.get(key) ?? 0) + Number(input.qty ?? 0));
  }

  for (const [sku, qty] of merged) {
    const item = bySku.get(sku);
    if (!item) {
      problems.push({ code: 'unknown_sku', sku, detail: `Produk dengan kode ${sku} tidak ada di katalog.` });
      continue;
    }
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY_PER_LINE) {
      problems.push({ code: 'bad_quantity', sku: item.sku, detail: `Jumlah untuk ${item.title} tidak masuk akal.` });
      continue;
    }
    if (item.priceIdr === null || item.priceIdr <= 0) {
      problems.push({ code: 'no_price', sku: item.sku, detail: `${item.title} belum ada harganya di katalog.` });
      continue;
    }
    if ((item.stock ?? 0) < qty) {
      problems.push({
        code: 'out_of_stock', sku: item.sku,
        detail: `Stok ${item.title} tinggal ${item.stock ?? 0}, tidak cukup untuk ${qty}.`,
      });
      continue;
    }
    lines.push({
      knowledgeItemId: item.id,
      sku: item.sku,
      title: item.title,
      unitPriceIdr: item.priceIdr,
      qty,
      lineTotalIdr: item.priceIdr * qty,
    });
  }

  if (lines.length === 0 && problems.length === 0) {
    problems.push({ code: 'empty_order', detail: 'Belum ada barang yang dipilih.' });
  }

  const subtotalIdr = lines.reduce((sum, line) => sum + line.lineTotalIdr, 0);
  const shipping = lines.length > 0 ? Math.max(0, Math.trunc(shippingIdr)) : 0;

  return { lines, subtotalIdr, shippingIdr: shipping, totalIdr: subtotalIdr + shipping, problems };
}

/**
 * Every amount an order legitimately puts into a reply. The guardrail that
 * checks quoted prices takes this alongside the catalogue, so a total the server
 * computed is quotable while an invented one still is not.
 */
export function orderAmounts(order: BuiltOrder): number[] {
  return [
    ...order.lines.map((l) => l.unitPriceIdr),
    ...order.lines.map((l) => l.lineTotalIdr),
    order.subtotalIdr,
    order.shippingIdr,
    order.totalIdr,
  ].filter((n) => n > 0);
}

/** Short, unambiguous, readable over the phone: no O/0 or I/1 confusion. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function orderCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? 'X';
  return `INV-${out}`;
}
