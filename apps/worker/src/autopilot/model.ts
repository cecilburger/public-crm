import { z } from 'zod';
import {
  buildSystemPrompt, type AutopilotPolicy, type KnowledgeItem, type ModelDraft,
} from '@kirana/core';
import type { ToolBox } from './tools.ts';

/**
 * The model's output contract.
 *
 * `citedSkus` and `claimsInStock` exist so the guardrails have something
 * checkable to work with. Asking a model to "be accurate about prices" is a
 * hope; asking it to declare which catalogue rows it used is a fact we can
 * verify against the database.
 */
const INTENTS = ['stock', 'price', 'shipping', 'order_status', 'return', 'complaint', 'greeting', 'other'] as const;

/**
 * The schema sent to the API to constrain generation. Written by hand rather
 * than derived from Zod, because the SDK's Zod helper targets Zod 4 and the rest
 * of this codebase is on Zod 3 — and because our own validation below should be
 * the gate regardless of what the API enforces.
 */
export const DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Balasan untuk pelanggan, dalam Bahasa Indonesia' },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Seberapa yakin jawaban ini benar' },
    intent: { type: 'string', enum: [...INTENTS] },
    citedSkus: { type: 'array', items: { type: 'string' }, description: 'SKU dari katalog yang dipakai' },
    claimsInStock: { type: 'boolean', description: 'True kalau balasan menyatakan barang tersedia' },
    needsHuman: { type: 'boolean', description: 'True kalau sebaiknya dijawab manusia' },
    handoverReason: { type: ['string', 'null'], description: 'Alasan singkat kalau needsHuman true' },
  },
  required: ['reply', 'confidence', 'intent', 'citedSkus', 'claimsInStock', 'needsHuman', 'handoverReason'],
  additionalProperties: false,
} as const;

export const DraftSchema = z.object({
  reply: z.string().describe('Balasan untuk pelanggan, dalam Bahasa Indonesia'),
  confidence: z.number().min(0).max(1).describe('Seberapa yakin jawaban ini benar, 0 sampai 1'),
  intent: z.enum(INTENTS),
  citedSkus: z.array(z.string()).describe('SKU dari katalog yang dipakai untuk menjawab'),
  claimsInStock: z.boolean().describe('True kalau balasan menyatakan barang tersedia'),
  needsHuman: z.boolean().describe('True kalau sebaiknya dijawab manusia'),
  handoverReason: z.string().nullable().describe('Alasan singkat kalau needsHuman true'),
});

export interface DraftRequest {
  shopName: string;
  policy: AutopilotPolicy;
  knowledge: KnowledgeItem[];
  /** Oldest first. The customer's latest message is the last entry. */
  history: { role: 'customer' | 'shop'; text: string }[];
  /** When present the model can act, not just answer. */
  tools?: ToolBox;
}

export interface DraftResult {
  draft: ModelDraft;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}

export interface AutopilotModel {
  draft(request: DraftRequest): Promise<DraftResult>;
}

const HANDOVER = (reason: string): ModelDraft => ({
  reply: '', confidence: 0, intent: 'other', citedSkus: [], claimsInStock: false,
  needsHuman: true, handoverReason: reason,
});

/* ------------------------------------------------------------------ Claude */

export interface ClaudeOptions {
  apiKey?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}

export class ClaudeAutopilot implements AutopilotModel {
  /** Defined below the class; the agent loop, kept out of the constructor body. */
  declare converse: (
    client: import('@anthropic-ai/sdk').default, system: string, request: DraftRequest, tools: ToolBox,
  ) => Promise<DraftResult>;

  private client: import('@anthropic-ai/sdk').default | null = null;
  private readonly model: string;
  private readonly effort: NonNullable<ClaudeOptions['effort']>;
  private readonly maxTokens: number;
  private readonly apiKey: string | undefined;

  constructor(opts: ClaudeOptions = {}) {
    this.model = opts.model ?? 'claude-opus-5';
    // Drafting a reply from a supplied catalogue is a well-specified task, not a
    // reasoning problem. Medium keeps latency and cost sane for something that
    // runs on every inbound message; raise it per tenant if quality demands.
    this.effort = opts.effort ?? 'medium';
    this.maxTokens = opts.maxTokens ?? 2_000;
    this.apiKey = opts.apiKey;
  }

  private async sdk() {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = this.apiKey ? new Anthropic({ apiKey: this.apiKey }) : new Anthropic();
    }
    return this.client;
  }

  async draft(request: DraftRequest): Promise<DraftResult> {
    const client = await this.sdk();

    const system = buildSystemPrompt({
      shopName: request.shopName, policy: request.policy, knowledge: request.knowledge,
      hasTools: Boolean(request.tools),
    });

    if (request.tools) return this.converse(client, system, request, request.tools);

    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      // The catalogue and the rules are identical for every message this tenant
      // receives, so they are worth caching; the conversation goes after it.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.effort,
        format: { type: 'json_schema', schema: DRAFT_JSON_SCHEMA as unknown as Record<string, unknown> },
      },
      messages: request.history.map((turn) => ({
        role: turn.role === 'customer' ? ('user' as const) : ('assistant' as const),
        content: turn.text,
      })),
    });

    // A safety refusal on a customer-service reply is exactly the case a human
    // should take, so it becomes a handover rather than a fallback to another
    // model. Silently answering anyway would be the wrong instinct here.
    if (response.stop_reason === 'refusal') {
      return {
        draft: HANDOVER(`model menolak menjawab (${response.stop_details?.category ?? 'tanpa kategori'})`),
        model: this.model,
        usage: {},
      };
    }

    const text = response.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Our schema is the gate. A response that does not satisfy it becomes a
    // handover rather than a guess — the whole point is that nothing unverified
    // reaches a customer.
    let parsed;
    try {
      parsed = DraftSchema.safeParse(JSON.parse(text));
    } catch {
      return { draft: HANDOVER('jawaban model bukan JSON yang valid'), model: this.model, usage: {} };
    }
    if (!parsed.success) {
      return { draft: HANDOVER('jawaban model tidak sesuai format'), model: this.model, usage: {} };
    }

    return {
      draft: parsed.data,
      model: response.model ?? this.model,
      usage: {
        inputTokens: response.usage?.input_tokens ?? undefined,
        outputTokens: response.usage?.output_tokens ?? undefined,
        cacheReadTokens: response.usage?.cache_read_input_tokens ?? undefined,
      },
    };
  }
}

/**
 * The agent loop.
 *
 * Bounded on purpose: a chatbot that can call tools forever is a chatbot that
 * can spend forever. Every path out of the loop is either a `balas` (the only
 * way to reach the customer), an explicit handover, or a handover we impose.
 */
const MAX_STEPS = 8;

ClaudeAutopilot.prototype.converse = async function converse(
  this: ClaudeAutopilot,
  client: import('@anthropic-ai/sdk').default,
  system: string,
  request: DraftRequest,
  tools: ToolBox,
): Promise<DraftResult> {
  const self = this as unknown as { model: string; effort: string; maxTokens: number };
  type Param = import('@anthropic-ai/sdk').Anthropic.MessageParam;

  const messages: Param[] = request.history.map((turn) => ({
    role: turn.role === 'customer' ? ('user' as const) : ('assistant' as const),
    content: turn.text,
  }));

  let usage: DraftResult['usage'] = {};

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const response = await client.messages.create({
      model: self.model,
      max_tokens: self.maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: { effort: self.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
      tools: tools.definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        input_schema: definition.input_schema as never,
      })),
      messages,
    });

    usage = {
      inputTokens: response.usage?.input_tokens ?? undefined,
      outputTokens: response.usage?.output_tokens ?? undefined,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? undefined,
    };

    if (response.stop_reason === 'refusal') {
      return { draft: HANDOVER(`model menolak menjawab (${response.stop_details?.category ?? 'tanpa kategori'})`),
               model: self.model, usage };
    }

    messages.push({ role: 'assistant', content: response.content });

    const calls = response.content.filter(
      (block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use',
    );
    if (calls.length === 0) {
      return { draft: HANDOVER('model berhenti tanpa memanggil balas'), model: self.model, usage };
    }

    // Every tool_use needs a tool_result in one user message, even the terminal
    // ones — dropping any of them corrupts the next turn.
    const results: import('@anthropic-ai/sdk').Anthropic.ToolResultBlockParam[] = [];
    let terminal: ModelDraft | null = null;

    for (const call of calls) {
      if (call.name === 'balas') {
        const parsed = DraftSchema.safeParse(call.input);
        terminal = parsed.success ? parsed.data : HANDOVER('isi balas tidak sesuai format');
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'ok' });
        continue;
      }
      if (call.name === 'serahkan_ke_orang') {
        const reason = (call.input as { alasan?: string })?.alasan ?? 'diminta model';
        await tools.run(call.name, call.input as Record<string, unknown>);
        terminal = HANDOVER(reason);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'ok' });
        continue;
      }
      const output = await tools.run(call.name, (call.input ?? {}) as Record<string, unknown>)
        .catch((err: Error) => ({ error: err.message }));
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(output) });
    }

    if (terminal) return { draft: terminal, model: response.model ?? self.model, usage };
    messages.push({ role: 'user', content: results });
  }

  return { draft: HANDOVER('percakapan terlalu panjang untuk diselesaikan otomatis'), model: self.model, usage };
};

/* ------------------------------------------------------------------ offline */

/**
 * A deterministic stand-in, used by the tests and by the demo stack.
 *
 * It answers from the same catalogue the real model is given, so the guardrail
 * and metering paths are exercised for real — only the generation is fake. It
 * also lets the suite prove what happens when a model behaves badly, which you
 * cannot ask a real one to do on demand.
 */
export class ScriptedAutopilot implements AutopilotModel {
  constructor(private script: (req: DraftRequest) => ModelDraft | Promise<ModelDraft> = defaultScript) {}

  async draft(request: DraftRequest): Promise<DraftResult> {
    return { draft: await this.script(request), model: 'scripted', usage: {} };
  }
}

/**
 * A deterministic order-taker.
 *
 * It walks the same tools the real model does — search, basket, address,
 * confirm — so the whole path is exercised offline. It is dumb on purpose: it
 * matches on words rather than understanding, which is exactly why it makes a
 * good test double and a poor product.
 */
async function defaultScript(req: DraftRequest): Promise<ModelDraft> {
  const said = req.history.filter((t) => t.role === 'customer').map((t) => t.text).join(' ');
  const lower = said.toLowerCase();

  const product = req.knowledge.find(
    (k) => k.kind === 'product' && (k.stock ?? 0) > 0 &&
      k.title.toLowerCase().split(/\s+/).some((w) => w.length > 3 && lower.includes(w)),
  );
  if (!product || !product.sku) {
    return HANDOVER('tidak ada produk yang cocok di katalog');
  }

  const reply = (text: string, over: Partial<ModelDraft> = {}): ModelDraft => ({
    reply: text, confidence: 0.92, intent: 'stock', citedSkus: [product.sku!],
    claimsInStock: true, needsHuman: false, handoverReason: null, ...over,
  });

  const priced = `Rp ${(product.priceIdr ?? 0).toLocaleString('id-ID')}`;
  if (!req.tools) {
    return reply(`Stok ${product.title} masih ada ${product.stock} pcs, harganya ${priced} per pcs. Mau saya bantu buatkan pesanannya?`);
  }

  await req.tools.run('cari_produk', { kata_kunci: product.title });

  const customerLines = req.history.filter((t) => t.role === 'customer').map((t) => t.text);
  const addressLine = customerLines.find((text) => /\b(jl|jalan|alamat|no\.?\s*\d)/i.test(text));

  // Quantities are read from everything except the address — a house number is
  // not an order quantity, and "Jl. Melati 12" would otherwise buy twelve.
  const qtyText = customerLines
    .filter((text) => text !== addressLine)
    .join(' ')
    .toLowerCase()
    .replace(/rp\s*[\d.,]+/g, '');
  const quantities = [...qtyText.matchAll(/(\d{1,3})\s*(pcs|buah|biji|aja|saja|ya)?\b/g)];
  // Last number wins: "2 pcs … eh jadi 3 aja" is a customer changing their mind.
  const qty = quantities.length ? Number(quantities[quantities.length - 1]![1]) : null;

  if (!qty || qty < 1) {
    return reply(`Stok ${product.title} masih ada ${product.stock} pcs, harganya ${priced} per pcs. Mau pesan berapa?`, { intent: 'price' });
  }

  if (!addressLine) {
    const basket = await req.tools.run('susun_pesanan', { items: [{ sku: product.sku, jumlah: qty }] }) as
      { total?: number; masalah?: string[] };
    if (basket.masalah?.length) return HANDOVER(basket.masalah.join('; '));
    return reply(
      `Baik, ${qty} pcs ${product.title} = Rp ${(basket.total ?? 0).toLocaleString('id-ID')}. Alamat kirimnya ke mana ya?`,
      { intent: 'other', claimsInStock: false },
    );
  }

  const city = (addressLine.split(',').pop() ?? '').trim() || 'default';
  await req.tools.run('susun_pesanan', { items: [{ sku: product.sku, jumlah: qty }], kota: city });
  await req.tools.run('simpan_alamat', { nama_penerima: 'Pelanggan', alamat: addressLine, kota: city });
  const confirmed = await req.tools.run('konfirmasi_pesanan', {}) as
    { kode?: string; total?: number; link_pembayaran?: string; error?: string };

  if (confirmed.error) return HANDOVER(confirmed.error);

  return reply(
    `Pesanan ${confirmed.kode} sudah saya buat. Totalnya Rp ${(confirmed.total ?? 0).toLocaleString('id-ID')} sudah termasuk ongkir. Ini link pembayarannya: ${confirmed.link_pembayaran}`,
    { intent: 'other', claimsInStock: false },
  );
}
