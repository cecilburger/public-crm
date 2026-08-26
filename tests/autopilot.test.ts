import { describe, it, expect } from 'vitest';
import {
  extractRupiah, priceIsGrounded, selectKnowledge, checkGuardrails, decide,
  buildSystemPrompt, renderKnowledge,
  type KnowledgeItem, type AutopilotPolicy, type ModelDraft,
} from '@kirana/core';

const product = (over: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  id: 'k1', kind: 'product', title: 'Batik Parang size M', body: 'Katun primis, warna navy',
  sku: 'BTK-PRG-M', priceIdr: 480_000, stock: 7, tags: ['batik', 'parang', 'navy'], ...over,
});

const CATALOGUE: KnowledgeItem[] = [
  product(),
  product({ id: 'k2', title: 'Batik Parang size L', sku: 'BTK-PRG-L', priceIdr: 495_000, stock: 0, tags: ['batik', 'parang'] }),
  product({ id: 'k3', title: 'Kemeja Linen', sku: 'KML-01', priceIdr: 320_000, stock: 12, tags: ['kemeja', 'linen'] }),
  { id: 'p1', kind: 'policy', title: 'Ongkir', body: 'Ongkir Jabodetabek Rp 12.000. Minimal COD Rp 100.000.',
    sku: null, priceIdr: null, stock: null, tags: [] },
  { id: 'f1', kind: 'faq', title: 'Retur', body: 'Retur maksimal 3 hari setelah barang diterima.',
    sku: null, priceIdr: null, stock: null, tags: ['retur'] },
];

const POLICY: AutopilotPolicy = {
  mode: 'auto', minConfidence: 0.75, mayOfferDiscount: false, mayPromiseDelivery: false,
  persona: 'Ramah', escalateKeywords: ['komplain', 'refund'], maxReplyChars: 700,
  maxRepliesPerHour: 120, maxRepliesPerContactPerHour: 12,
};

const draft = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  reply: 'Stok Batik Parang size M masih ada 7 pcs, harga Rp 480.000 per pcs.',
  confidence: 0.94, intent: 'stock', citedSkus: ['BTK-PRG-M'], claimsInStock: true,
  needsHuman: false, handoverReason: null, ...over,
});

const guard = (d: ModelDraft, customerMessage = 'stok batik parang M ada?', policy = POLICY) =>
  checkGuardrails({ draft: d, customerMessage, knowledge: CATALOGUE, policy });

describe('reading money out of a reply', () => {
  it('finds every way an Indonesian shop writes a price', () => {
    expect(extractRupiah('Rp 480.000')).toEqual([480_000]);
    expect(extractRupiah('rp480000')).toEqual([480_000]);
    expect(extractRupiah('Rp 1,5 jt')).toEqual([1_500_000]);   // comma is a decimal point here
    expect(extractRupiah('Rp 1.440.000')).toEqual([1_440_000]); // dots group thousands
    expect(extractRupiah('Rp 25rb dan Rp 100 ribu')).toEqual([25_000, 100_000]);
    expect(extractRupiah('tidak ada angka')).toEqual([]);
  });
});

describe('a quoted price must come from the catalogue', () => {
  it('does not let a decimal shorthand match a price ten times bigger', () => {
    const pricey: KnowledgeItem[] = [product({ priceIdr: 15_000_000, sku: 'MAHAL' })];
    // "Rp 1,5jt" is 1.5 million. It must not be mistaken for the 15 million item.
    expect(extractRupiah('Rp 1,5jt')).toEqual([1_500_000]);
    expect(priceIsGrounded(1_500_000, pricey)).toBe(false);
  });

  it('accepts a price we actually charge', () => {
    expect(priceIsGrounded(480_000, CATALOGUE)).toBe(true);
  });

  it('accepts a bulk quote that is a whole multiple', () => {
    expect(priceIsGrounded(1_440_000, CATALOGUE)).toBe(true);  // 3 × 480.000
  });

  it('accepts a number written into a policy', () => {
    expect(priceIsGrounded(12_000, CATALOGUE)).toBe(true);     // ongkir
  });

  it('rejects a number the model made up', () => {
    expect(priceIsGrounded(455_000, CATALOGUE)).toBe(false);
    expect(priceIsGrounded(1_000_000, CATALOGUE)).toBe(false);
  });
});

describe('choosing what the model gets to see', () => {
  it('finds the item the customer asked about', () => {
    const picked = selectKnowledge(CATALOGUE, 'batik parang size M ada?');
    expect(picked.map((k) => k.sku)).toContain('BTK-PRG-M');
  });

  it('always includes policies, related or not', () => {
    const picked = selectKnowledge(CATALOGUE, 'kemeja linen warna apa saja');
    expect(picked.some((k) => k.kind === 'policy')).toBe(true);
  });

  it('leaves out products with nothing to do with the question', () => {
    const picked = selectKnowledge(CATALOGUE, 'kemeja linen');
    expect(picked.map((k) => k.sku)).toContain('KML-01');
    expect(picked.map((k) => k.sku)).not.toContain('BTK-PRG-M');
  });
});

describe('guardrails', () => {
  it('passes a grounded, in-stock, in-policy reply', () => {
    expect(guard(draft())).toEqual([]);
  });

  it('catches an invented price', () => {
    expect(guard(draft({ reply: 'Harganya Rp 455.000 saja kak.' }))).toContain('ungrounded_price');
  });

  it('catches a discount the shop never authorised', () => {
    expect(guard(draft({ reply: 'Saya kasih diskon khusus buat kakak.' }))).toContain('discount_not_allowed');
  });

  it('allows the discount when the shop does authorise it', () => {
    const permissive = { ...POLICY, mayOfferDiscount: true };
    expect(guard(draft({ reply: 'Ada diskon 10% minggu ini.' }), 'ada promo?', permissive))
      .not.toContain('discount_not_allowed');
  });

  it('catches a delivery date it cannot guarantee', () => {
    expect(guard(draft({ reply: 'Barang dijamin sampai besok pagi.' })))
      .toContain('delivery_promise_not_allowed');
  });

  it('catches a claim of stock on something sold out', () => {
    const sold = draft({ reply: 'Size L masih ada kak.', citedSkus: ['BTK-PRG-L'], claimsInStock: true });
    expect(guard(sold)).toContain('out_of_stock_claim');
  });

  it('catches a SKU that does not exist', () => {
    expect(guard(draft({ citedSkus: ['TIDAK-ADA'] }))).toContain('unknown_sku');
  });

  it('catches a link we did not put there', () => {
    expect(guard(draft({ reply: 'Cek di https://phishy.example/bayar ya' }))).toContain('external_link');
  });

  it('catches a reply longer than the shop allows', () => {
    expect(guard(draft({ reply: 'a'.repeat(900) }))).toContain('too_long');
  });

  it('catches an empty reply', () => {
    expect(guard(draft({ reply: '   ' }))).toContain('empty_reply');
  });

  it('routes an angry customer to a human whatever the reply says', () => {
    expect(guard(draft(), 'saya mau komplain, barang rusak')).toContain('escalation_keyword');
  });

  it('reports every broken rule at once, not just the first', () => {
    const bad = draft({ reply: 'Diskon khusus, harga Rp 455.000, dijamin sampai besok.' });
    const reasons = guard(bad);
    expect(reasons).toEqual(expect.arrayContaining([
      'ungrounded_price', 'discount_not_allowed', 'delivery_promise_not_allowed',
    ]));
  });
});

describe('the decision', () => {
  it('sends a clean, confident reply when the shop turned auto on', () => {
    expect(decide(draft(), [], POLICY)).toEqual({ action: 'send', reasons: [] });
  });

  it('never auto-sends a draft that broke a rule, however confident it claims to be', () => {
    const cocky = draft({ confidence: 1 });
    const decision = decide(cocky, ['ungrounded_price'], POLICY);
    expect(decision.action).toBe('handover');
    expect(decision.reasons).toContain('ungrounded_price');
  });

  it('hands over when the model is unsure', () => {
    expect(decide(draft({ confidence: 0.5 }), [], POLICY).reasons).toContain('low_confidence');
  });

  it('hands over when the model asks for a human', () => {
    expect(decide(draft({ needsHuman: true }), [], POLICY).reasons).toContain('model_asked_for_human');
  });

  it('only ever suggests while the shop is still in suggest mode', () => {
    const suggesting = { ...POLICY, mode: 'suggest' as const };
    expect(decide(draft(), [], suggesting)).toEqual({ action: 'suggest', reasons: ['mode_suggest'] });
  });

  it('does nothing at all when Autopilot is switched off', () => {
    const off = { ...POLICY, mode: 'off' as const };
    expect(decide(draft(), [], off)).toEqual({ action: 'handover', reasons: ['mode_off'] });
  });
});

describe('the prompt the model is given', () => {
  it('states the prices as data and forbids inventing them', () => {
    const prompt = buildSystemPrompt({ shopName: 'Toko Demo', policy: POLICY, knowledge: CATALOGUE });
    expect(prompt).toContain('BTK-PRG-M');
    expect(prompt).toContain('Rp 480.000');
    expect(prompt).toContain('Jangan pernah mengarang angka');
    expect(prompt).toContain('JANGAN pernah menjanjikan diskon');
  });

  it('relaxes the wording when the shop allows discounts', () => {
    const prompt = buildSystemPrompt({
      shopName: 'Toko Demo', policy: { ...POLICY, mayOfferDiscount: true }, knowledge: CATALOGUE,
    });
    expect(prompt).not.toContain('JANGAN pernah menjanjikan diskon');
  });

  it('shows stock so the model can see what is sold out', () => {
    expect(renderKnowledge(CATALOGUE)).toContain('stok: 0');
  });
});
