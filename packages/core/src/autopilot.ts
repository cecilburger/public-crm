/**
 * Autopilot: the rules, with no I/O.
 *
 * The model proposes; this module disposes. Everything here is pure so the
 * safety behaviour can be tested exhaustively without a network call — which
 * matters more than usual, because the failure mode is a wrong price quoted to
 * a real customer in a real shop.
 *
 * The design principle throughout: **do not ask the model to be careful, make
 * carelessness detectable.** The model returns structured claims (which SKUs it
 * used, whether it asserted stock), and this module checks those claims against
 * the catalogue. Prose is not verifiable; claims are.
 */

export type AutopilotMode = 'off' | 'suggest' | 'auto';

export type Intent =
  | 'stock' | 'price' | 'shipping' | 'order_status'
  | 'return' | 'complaint' | 'greeting' | 'other';

export interface KnowledgeItem {
  id: string;
  kind: 'product' | 'faq' | 'policy';
  title: string;
  body: string;
  sku: string | null;
  priceIdr: number | null;
  stock: number | null;
  tags: string[];
}

export interface AutopilotPolicy {
  mode: AutopilotMode;
  minConfidence: number;
  mayOfferDiscount: boolean;
  mayPromiseDelivery: boolean;
  persona: string;
  escalateKeywords: string[];
  maxReplyChars: number;
  /** Generations per hour for the whole workspace. 0 disables the cap. */
  maxRepliesPerHour: number;
  /** Generations per hour for one customer. 0 disables the cap. */
  maxRepliesPerContactPerHour: number;
}

/** Exactly what the model is required to return. */
export interface ModelDraft {
  reply: string;
  confidence: number;
  intent: Intent;
  citedSkus: string[];
  claimsInStock: boolean;
  needsHuman: boolean;
  handoverReason: string | null;
}

export type ReasonCode =
  | 'mode_off' | 'mode_suggest'
  | 'low_confidence' | 'model_asked_for_human' | 'escalation_keyword'
  | 'ungrounded_price' | 'discount_not_allowed' | 'delivery_promise_not_allowed'
  | 'unknown_sku' | 'out_of_stock_claim' | 'too_long' | 'external_link'
  | 'empty_reply' | 'model_refused' | 'rate_limited' | 'contact_rate_limited';

export type AutopilotAction = 'send' | 'suggest' | 'handover';

export interface AutopilotDecision {
  action: AutopilotAction;
  reasons: ReasonCode[];
}

/* ------------------------------------------------------------- retrieval */

const STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'ini', 'itu', 'ada',
  'apa', 'saya', 'kak', 'sis', 'gan', 'bu', 'pak', 'mau', 'bisa', 'ga', 'gak',
  'tidak', 'sudah', 'masih', 'nya', 'aja', 'ya', 'the', 'a', 'is', 'for',
]);

export function tokenise(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Keyword retrieval, scored by field weight. A shop catalogue is hundreds of
 * items, not millions — this is the right tool for that size, and it has the
 * advantage of being inspectable when it picks the wrong thing.
 *
 * Policies are always included: "we do not ship on Sunday" is relevant to every
 * question whether or not it shares a word with it.
 */
export function selectKnowledge(items: KnowledgeItem[], query: string, limit = 8): KnowledgeItem[] {
  const terms = tokenise(query);
  const policies = items.filter((i) => i.kind === 'policy');

  const scored = items
    .filter((i) => i.kind !== 'policy')
    .map((item) => {
      const title = tokenise(item.title);
      const tags = item.tags.flatMap(tokenise);
      const body = tokenise(item.body);
      const sku = (item.sku ?? '').toLowerCase();

      let score = 0;
      for (const term of terms) {
        if (sku && sku.includes(term)) score += 6;
        if (title.includes(term)) score += 4;
        if (tags.includes(term)) score += 3;
        if (body.includes(term)) score += 1;
      }
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit - policies.length))
    .map((s) => s.item);

  return [...policies, ...scored];
}

/* ------------------------------------------------------------ guardrails */

/** Every "Rp 480.000" / "Rp480rb" style amount the reply commits us to. */
export function extractRupiah(text: string): number[] {
  const out: number[] = [];
  const re = /rp\s*([\d.,]+)\s*(jt|juta|rb|ribu|k)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? '';
    if (!/\d/.test(raw)) continue;
    // Indonesian convention: "." groups thousands, "," is the decimal point.
    // Reading "Rp 1,5 jt" as 15 million instead of 1,5 million would let a
    // wrongly-quoted price match a real catalogue entry ten times its size.
    let value = Number(raw.replace(/\./g, '').replace(',', '.'));
    const unit = (m[2] ?? '').toLowerCase();
    if (unit === 'jt' || unit === 'juta') value *= 1_000_000;
    else if (unit === 'rb' || unit === 'ribu' || unit === 'k') value *= 1_000;
    if (Number.isFinite(value) && value > 0) out.push(Math.round(value));
  }
  return out;
}

/**
 * A quoted amount is allowed only if the catalogue can account for it: the exact
 * price of something we sell, a whole-number multiple of it (a bulk quote), or a
 * figure that already appears in a policy or FAQ (a delivery fee, a minimum
 * order). Anything else is the model inventing a number, which is the single
 * most damaging thing it could do.
 */
export function priceIsGrounded(amount: number, knowledge: KnowledgeItem[]): boolean {
  const prices = knowledge.map((k) => k.priceIdr).filter((p): p is number => typeof p === 'number' && p > 0);

  for (const price of prices) {
    if (amount === price) return true;
    if (amount % price === 0 && amount / price <= 50) return true;
  }
  // Numbers written into the knowledge text itself are already ours to quote.
  return knowledge.some((k) => extractRupiah(k.body).includes(amount));
}

const DISCOUNT_WORDS = /\b(diskon|discount|potongan harga|cashback|gratis ongkir|free ongkir|bonus gratis)\b/i;
const DELIVERY_WORDS = /\b(sampai (hari|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu|minggu)|tiba (hari|besok|lusa)|dijamin sampai|pasti sampai|garansi sampai)\b/i;
const LINK = /https?:\/\/[^\s]+/gi;

export interface GuardInput {
  draft: ModelDraft;
  customerMessage: string;
  knowledge: KnowledgeItem[];
  policy: AutopilotPolicy;
  /**
   * Amounts the server itself computed this turn — order line totals, shipping,
   * the grand total. Quotable precisely because we produced them, not the model.
   */
  groundedAmounts?: number[];
  /** Checkout links we issued this turn, which the model may therefore send. */
  groundedLinks?: string[];
}

/** Every rule the draft can break, checked independently and reported together. */
export function checkGuardrails(input: GuardInput): ReasonCode[] {
  const { draft, customerMessage, knowledge, policy } = input;
  const reasons: ReasonCode[] = [];
  const reply = draft.reply ?? '';

  if (reply.trim().length === 0) reasons.push('empty_reply');
  if (reply.length > policy.maxReplyChars) reasons.push('too_long');

  const computed = new Set(input.groundedAmounts ?? []);
  for (const amount of extractRupiah(reply)) {
    if (computed.has(amount)) continue;
    if (!priceIsGrounded(amount, knowledge)) {
      reasons.push('ungrounded_price');
      break;
    }
  }

  if (!policy.mayOfferDiscount && DISCOUNT_WORDS.test(reply)) reasons.push('discount_not_allowed');
  if (!policy.mayPromiseDelivery && DELIVERY_WORDS.test(reply)) reasons.push('delivery_promise_not_allowed');

  const bySku = new Map(knowledge.filter((k) => k.sku).map((k) => [k.sku!.toLowerCase(), k]));
  for (const sku of draft.citedSkus ?? []) {
    const item = bySku.get(sku.toLowerCase());
    if (!item) { reasons.push('unknown_sku'); continue; }
    if (draft.claimsInStock && (item.stock ?? 0) <= 0) reasons.push('out_of_stock_claim');
  }

  // A link we did not put in the knowledge base is a link we cannot vouch for.
  const known = [...knowledge.flatMap((k) => k.body.match(LINK) ?? []), ...(input.groundedLinks ?? [])];
  for (const link of reply.match(LINK) ?? []) {
    if (!known.includes(link)) { reasons.push('external_link'); break; }
  }

  const lower = customerMessage.toLowerCase();
  if (policy.escalateKeywords.some((word) => word && lower.includes(word.toLowerCase()))) {
    reasons.push('escalation_keyword');
  }

  return [...new Set(reasons)];
}

/**
 * The decision.
 *
 * One rule dominates everything: a draft that broke a guardrail is never sent
 * automatically, no matter how confident the model claims to be. Confidence is
 * the model's opinion of itself; a guardrail is a fact about the catalogue.
 */
export function decide(
  draft: ModelDraft, guardrails: ReasonCode[], policy: AutopilotPolicy,
): AutopilotDecision {
  const reasons = [...guardrails];

  if (policy.mode === 'off') return { action: 'handover', reasons: ['mode_off'] };
  if (draft.needsHuman) reasons.push('model_asked_for_human');
  if (draft.confidence < policy.minConfidence) reasons.push('low_confidence');

  const blocking = reasons.length > 0;
  if (blocking) return { action: 'handover', reasons: [...new Set(reasons)] };
  if (policy.mode === 'suggest') return { action: 'suggest', reasons: ['mode_suggest'] };
  return { action: 'send', reasons: [] };
}

/* --------------------------------------------------------------- prompt */

export interface PromptInput {
  shopName: string;
  policy: AutopilotPolicy;
  knowledge: KnowledgeItem[];
  /** When true, the model can act — and must finish by calling `balas`. */
  hasTools?: boolean;
}

/**
 * The catalogue is rendered as data, not prose, and the instructions say the
 * catalogue is the only source of prices. The structured-output schema then
 * forces the model to declare which items it used, so the claim is checkable.
 */
export function renderKnowledge(knowledge: KnowledgeItem[]): string {
  if (knowledge.length === 0) return '(katalog kosong)';
  return knowledge.map((k) => {
    if (k.kind === 'product') {
      return [
        `- [${k.sku ?? 'NO-SKU'}] ${k.title}`,
        k.priceIdr !== null ? `  harga: Rp ${k.priceIdr.toLocaleString('id-ID')}` : '  harga: tidak tercantum',
        `  stok: ${k.stock ?? 0}`,
        k.body ? `  catatan: ${k.body}` : '',
      ].filter(Boolean).join('\n');
    }
    return `- (${k.kind}) ${k.title}: ${k.body}`;
  }).join('\n');
}

export function buildSystemPrompt({ shopName, policy, knowledge, hasTools }: PromptInput): string {
  const toolRules = hasTools ? `
CARA KERJA DENGAN TOOL
- Pakai cari_produk sebelum menyebut harga atau stok apa pun.
- Untuk membuat pesanan: susun_pesanan (kamu hanya memberi SKU dan jumlah — harga,
  ongkir, dan total dihitung sistem, jangan pernah menghitung sendiri).
- Minta nama penerima dan alamat, lalu simpan_alamat.
- Setelah pelanggan setuju totalnya, baru konfirmasi_pesanan untuk membuat link bayar.
- Sebutkan angka dan kode pesanan persis seperti yang dikembalikan tool.
- Kalau di luar kemampuanmu: serahkan_ke_orang.
- SELALU akhiri dengan tool balas. Tanpa itu pelanggan tidak menerima apa pun.
` : '';

  return `Kamu adalah asisten customer service untuk ${shopName}, sebuah toko di Indonesia.
Gaya bicara: ${policy.persona}

ATURAN YANG TIDAK BOLEH DILANGGAR
1. Harga, stok, dan detail produk HANYA boleh diambil dari katalog di bawah.
   Jangan pernah mengarang angka. Kalau tidak ada di katalog, bilang tidak tahu
   dan minta bantuan manusia.
2. ${policy.mayOfferDiscount ? 'Diskon boleh ditawarkan sesuai katalog.' : 'JANGAN pernah menjanjikan diskon, potongan harga, cashback, atau gratis ongkir.'}
3. ${policy.mayPromiseDelivery ? 'Estimasi pengiriman boleh disebut.' : 'JANGAN menjanjikan tanggal barang pasti sampai.'}
4. Jangan pernah meminta nomor kartu, PIN, OTP, atau password.
5. Kalau pelanggan marah, komplain berat, atau minta refund: serahkan ke manusia.
6. Balasan maksimal ${policy.maxReplyChars} karakter. Ringkas, hangat, langsung ke inti.
7. Kalau ragu sedikit saja, turunkan confidence dan set needsHuman = true.
   Lebih baik manusia yang menjawab daripada pelanggan diberi info salah.

${toolRules}
KATALOG DAN KEBIJAKAN
${renderKnowledge(knowledge)}

Isi citedSkus dengan SKU produk yang kamu pakai untuk menjawab.
Isi claimsInStock = true hanya kalau kamu menyatakan barangnya tersedia.`;
}
