import { describe, it, expect } from 'vitest';
import { buildOrder, orderAmounts, orderCode, MAX_QTY_PER_LINE, type CatalogueEntry } from '@kirana/core';

const CATALOGUE: CatalogueEntry[] = [
  { id: 'a', sku: 'KML-01', title: 'Kemeja Linen Pria', priceIdr: 320_000, stock: 12 },
  { id: 'b', sku: 'BTK-PRG-M', title: 'Batik Parang size M', priceIdr: 480_000, stock: 7 },
  { id: 'c', sku: 'BTK-PRG-L', title: 'Batik Parang size L', priceIdr: 495_000, stock: 0 },
  { id: 'd', sku: 'NOPRICE', title: 'Belum dihargai', priceIdr: null, stock: 5 },
];

describe('the server does the arithmetic, not the model', () => {
  it('prices a basket from the catalogue', () => {
    const order = buildOrder([{ sku: 'KML-01', qty: 2 }], CATALOGUE, 12_000);
    expect(order.lines[0]!.unitPriceIdr).toBe(320_000);
    expect(order.lines[0]!.lineTotalIdr).toBe(640_000);
    expect(order.subtotalIdr).toBe(640_000);
    expect(order.shippingIdr).toBe(12_000);
    expect(order.totalIdr).toBe(652_000);
    expect(order.problems).toEqual([]);
  });

  it('adds up several lines', () => {
    const order = buildOrder([{ sku: 'KML-01', qty: 1 }, { sku: 'BTK-PRG-M', qty: 2 }], CATALOGUE, 12_000);
    expect(order.subtotalIdr).toBe(320_000 + 960_000);
    expect(order.totalIdr).toBe(1_292_000);
  });

  it('merges a repeated SKU instead of doubling the basket', () => {
    const order = buildOrder([{ sku: 'KML-01', qty: 1 }, { sku: 'kml-01', qty: 2 }], CATALOGUE);
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]!.qty).toBe(3);
    expect(order.subtotalIdr).toBe(960_000);
  });

  it('refuses a product that is not in the catalogue', () => {
    const order = buildOrder([{ sku: 'TIDAK-ADA', qty: 1 }], CATALOGUE);
    expect(order.lines).toEqual([]);
    expect(order.problems[0]!.code).toBe('unknown_sku');
  });

  it('refuses more than there is in stock, and says how many are left', () => {
    const order = buildOrder([{ sku: 'BTK-PRG-M', qty: 9 }], CATALOGUE);
    expect(order.problems[0]!.code).toBe('out_of_stock');
    expect(order.problems[0]!.detail).toContain('7');
    expect(order.totalIdr).toBe(0);
  });

  it('refuses something sold out entirely', () => {
    expect(buildOrder([{ sku: 'BTK-PRG-L', qty: 1 }], CATALOGUE).problems[0]!.code).toBe('out_of_stock');
  });

  it('refuses a product with no price set', () => {
    expect(buildOrder([{ sku: 'NOPRICE', qty: 1 }], CATALOGUE).problems[0]!.code).toBe('no_price');
  });

  it('refuses nonsense quantities', () => {
    for (const qty of [0, -3, 1.5, MAX_QTY_PER_LINE + 1]) {
      const order = buildOrder([{ sku: 'KML-01', qty }], CATALOGUE);
      expect(order.problems.map((p) => p.code)).toContain('bad_quantity');
    }
  });

  it('charges no shipping on an empty basket', () => {
    const order = buildOrder([{ sku: 'TIDAK-ADA', qty: 1 }], CATALOGUE, 12_000);
    expect(order.shippingIdr).toBe(0);
    expect(order.totalIdr).toBe(0);
  });

  it('lists exactly the figures a reply is then allowed to quote', () => {
    const order = buildOrder([{ sku: 'KML-01', qty: 2 }], CATALOGUE, 12_000);
    const amounts = orderAmounts(order);
    expect(amounts).toEqual(expect.arrayContaining([320_000, 640_000, 12_000, 652_000]));
    expect(amounts).not.toContain(999_999);
  });

  it('makes order codes people can read down a phone line', () => {
    const code = orderCode(() => 0.5);
    expect(code).toMatch(/^INV-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(code.slice(4)).not.toMatch(/[OI01]/);
  });
});
