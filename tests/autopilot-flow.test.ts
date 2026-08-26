import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTenant, ingestInboundMessage, currentUsage, tenantKeys, openField, type Database } from '@kirana/db';
import type { ModelDraft } from '@kirana/core';
import { processAutopilotDraft } from '../apps/worker/src/processors/autopilotDraft.ts';
import { ScriptedAutopilot, type DraftRequest } from '../apps/worker/src/autopilot/model.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * The whole Autopilot loop against a real database: catalogue in, message in,
 * draft out, guardrails applied, metering recorded. The model is scripted so the
 * suite can make it misbehave on demand — which is the only way to test what
 * happens when it does.
 */
describe('Autopilot, end to end', () => {
  let db: Database;
  let t: TestTenant;
  const dispatched: { queue: string; payload: unknown }[] = [];

  const seedCatalogue = () => withTenant(db, t.tenantId, async (tx) => {
    await tx.query(
      `insert into knowledge_items (tenant_id, kind, title, body, sku, price_idr, stock, tags)
       values ($1,'product','Batik Parang size M','Katun primis','BTK-PRG-M',480000,7,'{batik,parang}'),
              ($1,'product','Batik Parang size L','Katun primis','BTK-PRG-L',495000,0,'{batik,parang}'),
              ($1,'policy','Ongkir','Ongkir Jabodetabek Rp 12.000.',null,null,null,'{}')`,
      [t.tenantId],
    );
  });

  const setMode = (mode: 'off' | 'suggest' | 'auto') => withTenant(db, t.tenantId, (tx) =>
    tx.query(
      `insert into autopilot_settings (tenant_id, mode) values ($1,$2)
       on conflict (tenant_id) do update set mode = excluded.mode`,
      [t.tenantId, mode],
    ));

  const customerAsks = (text: string) => withTenant(db, t.tenantId, (tx) =>
    ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
      channelId: t.channelId, from: '08123456789', body: text,
      providerMessageId: `wamid.${Math.random()}`, displayName: 'Bu Sari',
    }));

  const run = (script?: (req: DraftRequest) => ModelDraft) =>
    processAutopilotDraft(
      { db, kek: TEST_KEK, model: new ScriptedAutopilot(script), dispatch: async (j) => { dispatched.push(j); } },
      { tenantId: t.tenantId, conversationId: conversationId! },
    );

  let conversationId: string | undefined;

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'autopilot');
    dispatched.length = 0;
    await seedCatalogue();
    const first = await customerAsks('Sis, batik parang size M masih ada?');
    conversationId = first.conversationId;
  });
  afterEach(async () => { await db.close(); });

  const drafts = () => withTenant(db, t.tenantId, async (tx) => {
    const rows = await tx.query<{ id: string; status: string; body_enc: string; reasons: unknown; confidence: string }>(
      'select id, status, body_enc, reasons, confidence from message_drafts order by created_at desc');
    const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
    return rows.map((r) => ({ ...r, body: openField(keys, t.tenantId, r.body_enc) }));
  });

  const outbound = () => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ n: number }>(`select count(*)::int as n from messages where direction = 'outbound'`));

  it('drafts a grounded reply and holds it for a human in suggest mode', async () => {
    await setMode('suggest');
    const outcome = await run();

    expect(outcome.status).toBe('suggested');
    const [draft] = await drafts();
    expect(draft!.status).toBe('pending');
    expect(draft!.body).toContain('Rp 480.000');
    expect((await outbound())[0]!.n).toBe(0); // nothing reached the customer
  });

  it('sends it without a human once the shop switches to auto', async () => {
    await setMode('auto');
    const outcome = await run();

    expect(outcome.status).toBe('sent');
    expect((await drafts())[0]!.status).toBe('auto_sent');
    expect((await outbound())[0]!.n).toBe(1);
    expect(dispatched.some((d) => d.queue === 'outbound.send')).toBe(true);
  });

  it('refuses to auto-send a made-up price, however confident the model is', async () => {
    await setMode('auto');
    const outcome = await run(() => ({
      reply: 'Bisa kak, harga spesial Rp 399.000 saja.',
      confidence: 0.99, intent: 'price', citedSkus: ['BTK-PRG-M'],
      claimsInStock: true, needsHuman: false, handoverReason: null,
    }));

    expect(outcome.status).toBe('handover');
    expect(outcome.reasons).toContain('ungrounded_price');
    const [draft] = await drafts();
    expect(draft!.status).toBe('blocked');
    expect((await outbound())[0]!.n).toBe(0);
  });

  it('refuses to auto-send a discount the shop never authorised', async () => {
    await setMode('auto');
    const outcome = await run(() => ({
      reply: 'Saya kasih diskon khusus ya kak.',
      confidence: 0.95, intent: 'price', citedSkus: [], claimsInStock: false,
      needsHuman: false, handoverReason: null,
    }));
    expect(outcome.reasons).toContain('discount_not_allowed');
    expect((await outbound())[0]!.n).toBe(0);
  });

  it('hands an angry customer to a person', async () => {
    await setMode('auto');
    await customerAsks('saya mau komplain, barangnya rusak');
    const outcome = await run();

    expect(outcome.status).toBe('handover');
    expect(outcome.reasons).toContain('escalation_keyword');
    expect((await outbound())[0]!.n).toBe(0);
  });

  it('stays quiet when a colleague has already claimed the conversation', async () => {
    await setMode('auto');
    await withTenant(db, t.tenantId, async (tx) => {
      const user = await tx.query<{ id: string }>('select id from users limit 1');
      await tx.query('update conversations set assignee_id = $2 where tenant_id = $1',
        [t.tenantId, user[0]!.id]);
    });

    const outcome = await run();
    expect(outcome.status).toBe('skipped');
    expect(await drafts()).toHaveLength(0);
  });

  it('does nothing at all when the shop has Autopilot switched off', async () => {
    await setMode('off');
    expect((await run()).status).toBe('skipped');
    expect(await drafts()).toHaveLength(0);
  });

  it('bills one AI reply per generation, including the ones it blocks', async () => {
    await setMode('auto');
    await run(); // sent
    await customerAsks('kalau size L ada?');
    await run(() => ({
      reply: 'Size L masih ada kak.', confidence: 0.9, intent: 'stock',
      citedSkus: ['BTK-PRG-L'], claimsInStock: true, needsHuman: false, handoverReason: null,
    })); // blocked — out of stock

    const usage = await withTenant(db, t.tenantId, (tx) => currentUsage(tx, t.tenantId));
    expect(usage.usage.ai_replies).toBe(2);
    expect(usage.usage.messages_out).toBe(1); // only one actually went out
  });

  it('records why it held back, so a supervisor can tune the policy', async () => {
    await setMode('auto');
    await run(() => ({
      reply: 'Harga Rp 399.000 dan dijamin sampai besok.', confidence: 0.4,
      intent: 'price', citedSkus: [], claimsInStock: false, needsHuman: false, handoverReason: null,
    }));

    const [draft] = await drafts();
    const reasons = typeof draft!.reasons === 'string' ? JSON.parse(draft!.reasons) : draft!.reasons;
    expect(reasons).toEqual(expect.arrayContaining([
      'ungrounded_price', 'delivery_promise_not_allowed', 'low_confidence',
    ]));
  });
});

describe('how a conversation and the workspace combine', () => {
  it('lets a conversation be more cautious than the workspace, never bolder', async () => {
    const { narrowest } = await import('../apps/worker/src/processors/autopilotDraft.ts');
    expect(narrowest('inherit', 'auto')).toBe('auto');       // no opinion → workspace wins
    expect(narrowest('suggest', 'auto')).toBe('suggest');    // thread is cautious → thread wins
    expect(narrowest('auto', 'suggest')).toBe('suggest');    // thread cannot escalate
    expect(narrowest('off', 'auto')).toBe('off');
    expect(narrowest('auto', 'off')).toBe('off');
  });
});

describe('a question spread over several messages', () => {
  let db: Database;
  let t: TestTenant;

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'multi');
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `insert into knowledge_items (tenant_id, kind, title, body, sku, price_idr, stock, tags)
       values ($1,'product','Batik Parang size M','Katun','BTK-PRG-M',480000,7,'{batik,parang}')`, [t.tenantId]));
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `insert into autopilot_settings (tenant_id, mode) values ($1,'suggest')`, [t.tenantId]));
  });
  afterEach(async () => { await db.close(); });

  it('still finds the product when the last line alone does not name it', async () => {
    let conversationId = '';
    for (const text of ['Sis, batik parang size M masih ada?', 'Butuh hari Jumat soalnya']) {
      const res = await withTenant(db, t.tenantId, (tx) =>
        ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          channelId: t.channelId, from: '08123456789', body: text,
          providerMessageId: `wamid.${text.length}`, displayName: 'Bu Sari',
        }));
      conversationId = res.conversationId;
    }

    const outcome = await processAutopilotDraft(
      { db, kek: TEST_KEK, model: new ScriptedAutopilot(), dispatch: async () => {} },
      { tenantId: t.tenantId, conversationId },
    );

    expect(outcome.status).toBe('suggested');
    const rows = await withTenant(db, t.tenantId, async (tx) => {
      const r = await tx.query<{ body_enc: string }>('select body_enc from message_drafts');
      const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
      return r.map((x) => openField(keys, t.tenantId, x.body_enc));
    });
    expect(rows[0]).toContain('Rp 480.000');
  });
});

describe('the chatbot taking an order', () => {
  let db: Database;
  let t: TestTenant;
  let conversationId = '';

  const say = async (text: string) => {
    const res = await withTenant(db, t.tenantId, (tx) =>
      ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: t.channelId, from: '08123456789', body: text,
        providerMessageId: `wamid.${Math.random()}`, displayName: 'Pak Yusuf',
      }));
    conversationId = res.conversationId;
    return res;
  };

  const bot = (script?: (req: DraftRequest) => ModelDraft | Promise<ModelDraft>) =>
    processAutopilotDraft(
      { db, kek: TEST_KEK, model: new ScriptedAutopilot(script), dispatch: async () => {},
        publicBaseUrl: 'https://toko.example' },
      { tenantId: t.tenantId, conversationId },
    );

  const lastReply = async () => withTenant(db, t.tenantId, async (tx) => {
    const rows = await tx.query<{ body_enc: string; status: string }>(
      'select body_enc, status from message_drafts order by created_at desc limit 1');
    const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
    return { status: rows[0]!.status, body: openField(keys, t.tenantId, rows[0]!.body_enc) };
  });

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'orders');
    await withTenant(db, t.tenantId, async (tx) => {
      await tx.query(
        `insert into knowledge_items (tenant_id, kind, title, body, sku, price_idr, stock, tags)
         values ($1,'product','Kemeja Linen Pria','Lengan panjang','KML-01',320000,12,'{kemeja,linen}')`,
        [t.tenantId]);
      await tx.query(
        `insert into shipping_rates (tenant_id, area, cost_idr, eta_days) values ($1,'Bekasi',12000,2), ($1,'default',25000,4)`,
        [t.tenantId]);
      await tx.query(`insert into autopilot_settings (tenant_id, mode) values ($1,'auto')`, [t.tenantId]);
    });
  });
  afterEach(async () => { await db.close(); });

  it('asks how many before it builds anything', async () => {
    await say('kemeja linen pria masih ready? harganya berapa');
    expect((await bot()).status).toBe('sent');
    expect((await lastReply()).body).toMatch(/Rp 320\.000/);
    expect((await lastReply()).body).toMatch(/berapa/i);

    const orders = await withTenant(db, t.tenantId, (tx) => tx.query('select id from orders'));
    expect(orders).toHaveLength(0);
  });

  it('builds a basket priced by the server, then asks for the address', async () => {
    await say('kemeja linen pria masih ready?');
    await bot();
    await say('2 aja');
    expect((await bot()).status).toBe('sent');

    expect((await lastReply()).body).toContain('Rp 640.000');
    const order = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string; subtotal_micros: string; total_micros: string }>(
        'select status, subtotal_micros, total_micros from orders'));
    expect(order[0]!.status).toBe('draft');
    expect(Number(order[0]!.subtotal_micros)).toBe(640_000_000_000);
  });

  it('confirms the order, issues a checkout link and puts the deal on the board', async () => {
    await say('kemeja linen pria masih ready?'); await bot();
    await say('2 aja'); await bot();
    await say('kirim ke Jl. Melati 12, Bekasi');
    expect((await bot()).status).toBe('sent');

    const reply = (await lastReply()).body;
    expect(reply).toContain('Rp 652.000');                    // 640.000 + 12.000 ongkir
    expect(reply).toMatch(/https:\/\/toko\.example\/bayar\/[A-Za-z0-9_-]+/);
    expect(reply).toMatch(/INV-[A-Z0-9]{6}/);

    const state = await withTenant(db, t.tenantId, async (tx) => ({
      order: await tx.query<{ status: string; total_micros: string }>('select status, total_micros from orders'),
      links: await tx.query('select code from payment_links'),
      deals: await tx.query<{ title: string; amount_micros: string }>('select title, amount_micros from deals'),
      address: await tx.query<{ address_enc: string | null }>('select address_enc from orders'),
    }));

    expect(state.order[0]!.status).toBe('awaiting_payment');
    expect(Number(state.order[0]!.total_micros)).toBe(652_000_000_000);
    expect(state.links).toHaveLength(1);
    expect(state.deals[0]!.title).toMatch(/^Pesanan INV-/);
    expect(Number(state.deals[0]!.amount_micros)).toBe(652_000_000_000);
    // The address is personal data and is stored sealed, not in the clear.
    expect(state.address[0]!.address_enc).toMatch(/^v1\./);
  });

  it('will not confirm an order before it has somewhere to send it', async () => {
    await say('kemeja linen pria 2 pcs'); await bot();
    const result = await withTenant(db, t.tenantId, async (tx) => {
      const order = await tx.query<{ id: string }>(`select id from orders where status = 'draft'`);
      const { confirmOrder } = await import('@kirana/db');
      return confirmOrder({ tx, tenantId: t.tenantId, kek: TEST_KEK },
        { orderId: order[0]!.id, publicBaseUrl: 'https://toko.example' });
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem.code).toBe('no_address');
  });

  it('takes the stock off the shelf when the order is locked', async () => {
    await say('kemeja linen pria ready?'); await bot();
    await say('2 aja'); await bot();
    await say('kirim ke Jl. Melati 12, Bekasi'); await bot();

    const stock = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ stock: number }>(`select stock from knowledge_items where sku = 'KML-01'`));
    expect(stock[0]!.stock).toBe(10); // 12 − 2
  });

  it('does not sell the last item twice', async () => {
    await withTenant(db, t.tenantId, (tx) =>
      tx.query(`update knowledge_items set stock = 1 where tenant_id = $1 and sku = 'KML-01'`, [t.tenantId]));

    // Two turns, the way the conversation actually arrives: quantity first,
    // then the address.
    const buy = async (from: string) => {
      let conversationId = '';
      let outcome;
      for (const [n, text] of [['a', 'kemeja linen pria 1 pcs'], ['b', 'kirim ke Jl. Anggrek 3, Bekasi']]) {
        const res = await withTenant(db, t.tenantId, (tx) =>
          ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
            channelId: t.channelId, from, body: text!,
            providerMessageId: `wamid.${from}.${n}`, displayName: from,
          }));
        conversationId = res.conversationId;
        outcome = await processAutopilotDraft(
          { db, kek: TEST_KEK, model: new ScriptedAutopilot(), dispatch: async () => {},
            publicBaseUrl: 'https://toko.example' },
          { tenantId: t.tenantId, conversationId },
        );
      }
      return outcome!;
    };

    const first = await buy('08111111111');
    const second = await buy('08222222222');

    expect(first.status).toBe('sent');
    // The second customer is told the truth rather than sold thin air.
    expect(second.status).toBe('handover');

    const state = await withTenant(db, t.tenantId, async (tx) => ({
      stock: await tx.query<{ stock: number }>(`select stock from knowledge_items where sku = 'KML-01'`),
      locked: await tx.query<{ n: number }>(`select count(*)::int as n from orders where status = 'awaiting_payment'`),
    }));
    expect(state.stock[0]!.stock).toBe(0);   // never negative
    expect(state.locked[0]!.n).toBe(1);      // exactly one order got it
  });

  it('puts the stock back when an unpaid order is cancelled', async () => {
    await say('kemeja linen pria ready?'); await bot();
    await say('2 aja'); await bot();
    await say('kirim ke Jl. Melati 12, Bekasi'); await bot();

    const restored = await withTenant(db, t.tenantId, async (tx) => {
      const { releaseOrder } = await import('@kirana/db');
      const order = await tx.query<{ id: string }>(`select id from orders where status = 'awaiting_payment'`);
      return releaseOrder({ tx, tenantId: t.tenantId, kek: TEST_KEK },
        { orderId: order[0]!.id, reason: 'test' });
    });
    expect(restored).toEqual({ released: true, restored: 2 });

    const after = await withTenant(db, t.tenantId, async (tx) => ({
      stock: await tx.query<{ stock: number }>(`select stock from knowledge_items where sku = 'KML-01'`),
      order: await tx.query<{ status: string }>('select status from orders'),
      link: await tx.query<{ status: string }>('select status from payment_links'),
    }));
    expect(after.stock[0]!.stock).toBe(12);
    expect(after.order[0]!.status).toBe('cancelled');
    expect(after.link[0]!.status).toBe('cancelled');
  });

  it('blocks a reply that quotes a total the server never computed', async () => {
    await say('kemeja linen pria 2 pcs');
    const outcome = await bot(async (req) => {
      await req.tools!.run('susun_pesanan', { items: [{ sku: 'KML-01', jumlah: 2 }] });
      return {
        reply: 'Totalnya Rp 500.000 saja kak, spesial.', confidence: 0.99, intent: 'price',
        citedSkus: ['KML-01'], claimsInStock: false, needsHuman: false, handoverReason: null,
      };
    });

    expect(outcome.status).toBe('handover');
    expect(outcome.reasons).toContain('ungrounded_price');
    const drafts = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string }>('select status from message_drafts'));
    expect(drafts[0]!.status).toBe('blocked');
  });

  it('does not create a second order when the basket is revised', async () => {
    await say('kemeja linen pria 2 pcs'); await bot();
    await say('eh jadi 3 aja'); await bot();

    const orders = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ subtotal_micros: string }>('select subtotal_micros from orders'));
    expect(orders).toHaveLength(1);
    expect(Number(orders[0]!.subtotal_micros)).toBe(960_000_000_000); // 3 × 320.000
  });

  it('records what the bot actually did, tool by tool', async () => {
    await say('kemeja linen pria 2 pcs'); await bot();
    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ action: string; meta: unknown }>(
        `select action, meta from audit_events where action = 'autopilot.tools_used' order by id desc limit 1`));
    const meta = typeof rows[0]!.meta === 'string' ? JSON.parse(rows[0]!.meta as string) : rows[0]!.meta;
    expect((meta as { actions: { tool: string }[] }).actions.map((a) => a.tool))
      .toEqual(expect.arrayContaining(['cari_produk', 'susun_pesanan']));
  });
});

describe('unpaid orders give the stock back', () => {
  let db: Database;
  let t: TestTenant;

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'expiry');
    await withTenant(db, t.tenantId, async (tx) => {
      await tx.query(
        `insert into knowledge_items (tenant_id, kind, title, sku, price_idr, stock, tags)
         values ($1,'product','Kemeja Linen Pria','KML-01',320000,12,'{kemeja,linen}')`, [t.tenantId]);
      await tx.query(`insert into shipping_rates (tenant_id, area, cost_idr) values ($1,'Bekasi',12000)`, [t.tenantId]);
      await tx.query(`insert into autopilot_settings (tenant_id, mode) values ($1,'auto')`, [t.tenantId]);
    });
  });
  afterEach(async () => { await db.close(); });

  it('releases a reservation nobody paid for, and leaves fresh ones alone', async () => {
    const { expireUnpaidOrders } = await import('../apps/worker/src/processors/retention.ts');

    let conversationId = '';
    for (const [n, text] of [['a', 'kemeja linen pria 2 pcs'], ['b', 'kirim ke Jl. Melati 12, Bekasi']]) {
      const res = await withTenant(db, t.tenantId, (tx) =>
        ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          channelId: t.channelId, from: '08123456789', body: text!,
          providerMessageId: `wamid.exp.${n}`, displayName: 'Bu Sari',
        }));
      conversationId = res.conversationId;
      await processAutopilotDraft(
        { db, kek: TEST_KEK, model: new ScriptedAutopilot(), dispatch: async () => {},
          publicBaseUrl: 'https://toko.example' },
        { tenantId: t.tenantId, conversationId },
      );
    }

    const stockAfterOrder = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ stock: number }>(`select stock from knowledge_items where sku = 'KML-01'`));
    expect(stockAfterOrder[0]!.stock).toBe(10);

    // Fresh order: the sweeper must not touch it.
    expect(await expireUnpaidOrders(db, db, { hours: 24 })).toEqual([]);

    // Age it past the window.
    await withTenant(db, t.tenantId, (tx) =>
      tx.query(`update orders set updated_at = now() - interval '30 hours' where tenant_id = $1`, [t.tenantId]));

    const swept = await expireUnpaidOrders(db, db, { hours: 24 });
    expect(swept[0]).toMatchObject({ expired: 1, stockRestored: 2 });

    const after = await withTenant(db, t.tenantId, async (tx) => ({
      stock: await tx.query<{ stock: number }>(`select stock from knowledge_items where sku = 'KML-01'`),
      order: await tx.query<{ status: string }>('select status from orders'),
    }));
    expect(after.stock[0]!.stock).toBe(12);
    expect(after.order[0]!.status).toBe('cancelled');
  });
});

describe('the spend cap', () => {
  let db: Database;
  let t: TestTenant;

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'cap');
    await withTenant(db, t.tenantId, async (tx) => {
      await tx.query(
        `insert into knowledge_items (tenant_id, kind, title, sku, price_idr, stock, tags)
         values ($1,'product','Kemeja Linen Pria','KML-01',320000,12,'{kemeja,linen}')`, [t.tenantId]);
      await tx.query(
        `insert into autopilot_settings (tenant_id, mode, max_replies_per_hour) values ($1,'auto',1)`,
        [t.tenantId]);
    });
  });
  afterEach(async () => { await db.close(); });

  const ask = async (from: string, text: string) => {
    const res = await withTenant(db, t.tenantId, (tx) =>
      ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: t.channelId, from, body: text,
        providerMessageId: `wamid.${from}.${text.length}`, displayName: from,
      }));
    return processAutopilotDraft(
      { db, kek: TEST_KEK, model: new ScriptedAutopilot(), dispatch: async () => {} },
      { tenantId: t.tenantId, conversationId: res.conversationId },
    );
  };

  it('stops generating once the workspace hits its hourly limit', async () => {
    expect((await ask('08111111111', 'kemeja linen pria ready?')).status).toBe('sent');

    const second = await ask('08222222222', 'kemeja linen pria ready?');
    expect(second.status).toBe('skipped');
    expect(second.reasons).toContain('rate_limited');

    // The message is not lost — it is simply waiting for a person.
    const conversations = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>('select count(*)::int as n from conversations'));
    expect(conversations[0]!.n).toBe(2);

    const drafts = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>('select count(*)::int as n from message_drafts'));
    expect(drafts[0]!.n).toBe(1); // only one generation was ever paid for
  });

  it('does not cap at all when the limit is set to zero', async () => {
    await withTenant(db, t.tenantId, (tx) =>
      tx.query('update autopilot_settings set max_replies_per_hour = 0 where tenant_id = $1', [t.tenantId]));

    await ask('08111111111', 'kemeja linen pria ready?');
    expect((await ask('08222222222', 'kemeja linen pria ready?')).status).toBe('sent');
  });
});

describe('drafts are personal data too', () => {
  it('stores the draft sealed, exactly like the message it may become', async () => {
    const db = await freshDb();
    const t = await makeTenant(db, 'sealed');
    await withTenant(db, t.tenantId, async (tx) => {
      await tx.query(
        `insert into knowledge_items (tenant_id, kind, title, sku, price_idr, stock, tags)
         values ($1,'product','Kemeja Linen Pria','KML-01',320000,12,'{kemeja,linen}')`, [t.tenantId]);
      await tx.query(`insert into autopilot_settings (tenant_id, mode) values ($1,'suggest')`, [t.tenantId]);
    });

    const conv = await withTenant(db, t.tenantId, (tx) =>
      ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: t.channelId, from: '08123456789', body: 'kemeja linen pria ready?',
        providerMessageId: 'wamid.seal', displayName: 'Bu Sari',
      }));
    await processAutopilotDraft(
      { db, kek: TEST_KEK, model: new ScriptedAutopilot(), dispatch: async () => {} },
      { tenantId: t.tenantId, conversationId: conv.conversationId },
    );

    const stored = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ body_enc: string }>('select body_enc from message_drafts'));
    expect(stored[0]!.body_enc).toMatch(/^v1\./);
    expect(stored[0]!.body_enc).not.toContain('320.000');

    const opened = await withTenant(db, t.tenantId, async (tx) => {
      const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
      return openField(keys, t.tenantId, stored[0]!.body_enc);
    });
    expect(opened).toContain('Rp 320.000');
    await db.close();
  });
});

describe('the per-customer cap', () => {
  let db: Database;
  let t: TestTenant;

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'percontact');
    await withTenant(db, t.tenantId, async (tx) => {
      await tx.query(
        `insert into knowledge_items (tenant_id, kind, title, sku, price_idr, stock, tags)
         values ($1,'product','Kemeja Linen Pria','KML-01',320000,12,'{kemeja,linen}')`, [t.tenantId]);
      await tx.query(
        `insert into autopilot_settings (tenant_id, mode, max_replies_per_hour, max_replies_per_contact_per_hour)
         values ($1,'auto',100,2)`, [t.tenantId]);
    });
  });
  afterEach(async () => { await db.close(); });

  const ask = async (from: string, text: string) => {
    const res = await withTenant(db, t.tenantId, (tx) =>
      ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: t.channelId, from, body: text,
        providerMessageId: `wamid.${from}.${Math.random()}`, displayName: from,
      }));
    return processAutopilotDraft(
      { db, kek: TEST_KEK, model: new ScriptedAutopilot(), dispatch: async () => {} },
      { tenantId: t.tenantId, conversationId: res.conversationId },
    );
  };

  it('stops answering one customer who will not stop, and keeps serving everyone else', async () => {
    const pest = '08111111111';
    expect((await ask(pest, 'kemeja linen pria ready?')).status).toBe('sent');
    expect((await ask(pest, 'kemeja linen pria ready?')).status).toBe('sent');

    const third = await ask(pest, 'kemeja linen pria ready?');
    expect(third.status).toBe('skipped');
    expect(third.reasons).toContain('contact_rate_limited');

    // A different customer is unaffected — the workspace budget is untouched.
    expect((await ask('08222222222', 'kemeja linen pria ready?')).status).toBe('sent');
  });

  it('does not cap per customer when the limit is zero', async () => {
    await withTenant(db, t.tenantId, (tx) =>
      tx.query('update autopilot_settings set max_replies_per_contact_per_hour = 0 where tenant_id = $1',
        [t.tenantId]));
    for (let i = 0; i < 4; i += 1) {
      expect((await ask('08111111111', 'kemeja linen pria ready?')).status).toBe('sent');
    }
  });
});

describe('retrying a draft job', () => {
  let db: Database;
  let t: TestTenant;

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'retry');
    await withTenant(db, t.tenantId, async (tx) => {
      await tx.query(
        `insert into knowledge_items (tenant_id, kind, title, sku, price_idr, stock, tags)
         values ($1,'product','Kemeja Linen Pria','KML-01',320000,12,'{kemeja,linen}')`, [t.tenantId]);
      await tx.query(`insert into autopilot_settings (tenant_id, mode) values ($1,'auto')`, [t.tenantId]);
    });
  });
  afterEach(async () => { await db.close(); });

  it('is free: the second run neither drafts again nor bills again', async () => {
    const inbound = await withTenant(db, t.tenantId, (tx) =>
      ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: t.channelId, from: '08123456789', body: 'kemeja linen pria ready?',
        providerMessageId: 'wamid.retry.1', displayName: 'Bu Sari',
      }));

    let generations = 0;
    const counting = new ScriptedAutopilot((req) => {
      generations += 1;
      const product = req.knowledge.find((k) => k.kind === 'product')!;
      return {
        reply: `Stok ${product.title} masih ada ${product.stock} pcs.`,
        confidence: 0.9, intent: 'stock', citedSkus: [product.sku!],
        claimsInStock: true, needsHuman: false, handoverReason: null,
      };
    });

    const job = { tenantId: t.tenantId, conversationId: inbound.conversationId, messageId: inbound.messageId };
    const deps = { db, kek: TEST_KEK, model: counting, dispatch: async () => {} };

    const first = await processAutopilotDraft(deps, job);
    const retry = await processAutopilotDraft(deps, job);

    expect(first.status).toBe('sent');
    expect(retry.status).toBe('skipped');
    // The model is not called a second time — that is the whole point.
    expect(generations).toBe(1);

    const state = await withTenant(db, t.tenantId, async (tx) => ({
      drafts: await tx.query<{ n: number }>('select count(*)::int as n from message_drafts'),
      usage: await currentUsage(tx, t.tenantId),
    }));
    expect(state.drafts[0]!.n).toBe(1);
    expect(state.usage.usage.ai_replies).toBe(1);
  });

  it('lets the database settle a race two workers cannot see', async () => {
    const inbound = await withTenant(db, t.tenantId, (tx) =>
      ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: t.channelId, from: '08111222333', body: 'kemeja linen pria ready?',
        providerMessageId: 'wamid.race.1', displayName: 'Pak Budi',
      }));

    // Both read before either writes, so the pre-check passes for both and the
    // unique index is the only thing left holding the line.
    const job = { tenantId: t.tenantId, conversationId: inbound.conversationId, messageId: inbound.messageId };
    const deps = { db, kek: TEST_KEK, model: new ScriptedAutopilot(), dispatch: async () => {} };
    await Promise.all([processAutopilotDraft(deps, job), processAutopilotDraft(deps, job)]);

    const state = await withTenant(db, t.tenantId, async (tx) => ({
      drafts: await tx.query<{ n: number }>('select count(*)::int as n from message_drafts'),
      usage: await currentUsage(tx, t.tenantId),
    }));
    expect(state.drafts[0]!.n).toBe(1);
    expect(state.usage.usage.ai_replies).toBe(1);
  });
});
