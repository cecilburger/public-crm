import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  withTenant, ingestInboundMessage, ingestInboundInstagramDmMessage, ensureInstagramBridgeChannel,
  tenantKeys, openField, getBdConversationNode, type Database,
} from '@kirana/db';
import { BdBrainClient } from '../apps/worker/src/bdBrain.ts';
import { processBdDraft } from '../apps/worker/src/processors/bdDraft.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * End to end against a RUNNING brain: the worker's own processor, the real
 * `BdBrainClient`, a real database, and `apps/bd-brain` serving on the other
 * side of a socket. Nothing here is faked except the calendar (the brain runs
 * with BD_BRAIN_SIMULATE_CALENDAR=true) — and nothing reaches WhatsApp or
 * Instagram, because the outbox is never drained.
 *
 * Skipped unless a brain is up, so `npm test` stays hermetic:
 *
 *   BD_BRAIN_SECRET=smoke BD_BRAIN_SIMULATE_CALENDAR=true BD_WHATSAPP_NUMBER='+62 800-0000-0000' \
 *     npm run dev:bd-brain
 *   BD_BRAIN_SMOKE_URL=http://127.0.0.1:4321 BD_BRAIN_SMOKE_SECRET=smoke npx vitest run tests/bd-brain-smoke.test.ts
 *
 * The transcript of each conversation is printed — that is the point of a
 * smoke: a person reads what the bot said.
 */

const URL_ = process.env.BD_BRAIN_SMOKE_URL;
const SECRET = process.env.BD_BRAIN_SMOKE_SECRET ?? process.env.BD_BRAIN_SECRET ?? '';

describe.skipIf(!URL_)('BD brain, end to end over HTTP', () => {
  let db: Database;
  let t: TestTenant;
  let brain: BdBrainClient;
  let igChannelId: string;
  const dispatched: { queue: string; payload: unknown }[] = [];

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'bdsmoke');
    brain = new BdBrainClient(URL_!, SECRET);
    ({ channelId: igChannelId } = await withTenant(db, t.tenantId, (tx) =>
      ensureInstagramBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { username: 'mcnasia.biz' })));
  });
  afterAll(async () => { await db?.close(); });

  const transcript = (conversationId: string) => withTenant(db, t.tenantId, async (tx) => {
    const rows = await tx.query<{ direction: string; body_enc: string | null; template_name: string | null }>(
      `select direction, body_enc, template_name from messages
        where tenant_id = $1 and conversation_id = $2 order by created_at asc, id asc`,
      [t.tenantId, conversationId]);
    const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
    return rows.map((r) => ({
      who: r.direction === 'inbound' ? 'brand' : 'bot',
      key: r.template_name ?? '',
      text: r.body_enc ? openField(keys, t.tenantId, r.body_enc) : '',
    }));
  });

  const state = (conversationId: string) => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ node: string; outcome: string; price_stage: number; meet_link: string; meeting_at: Date | null; email_enc: string | null }>(
      `select node, outcome, price_stage, meet_link, meeting_at, email_enc from bd_conversation_state
        where tenant_id = $1 and conversation_id = $2`, [t.tenantId, conversationId]).then((r) => r[0]));

  const print = (label: string, lines: { who: string; key: string; text: string }[]) => {
    console.log(`\n===== ${label} =====`);
    for (const l of lines) {
      const head = l.who === 'brand' ? 'brand>' : `bot  > [${l.key || '-'}]`;
      console.log(`${head} ${l.text.replace(/\n+/g, ' / ').slice(0, 220)}`);
    }
  };

  it('WhatsApp: ad text → form → price → focus → accept → email → booking', async () => {
    const say = async (text: string) => {
      const m = await withTenant(db, t.tenantId, (tx) =>
        ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          channelId: t.channelId, from: '08120000001', body: text,
          providerMessageId: `wamid.${Math.random()}`, displayName: 'Cika',
        }));
      const out = await processBdDraft(
        { db, kek: TEST_KEK, brain, dispatch: async (j) => { dispatched.push(j); } },
        { tenantId: t.tenantId, conversationId: m.conversationId, text },
      );
      return { conversationId: m.conversationId, out };
    };

    const steps = [
      'Halo! Bisa minta info lebih lanjut tentang ini?',
      'Nama Brand: Kopi Uji\nPosisi: owner\nLink TikTok Shop: -\nLink Shopee: -',
      'harganya berapa ya kak?',
      'lebih ke sales kak',
      'boleh, besok jam 10 bisa?',
      'email saya cika@contoh.id',
    ];
    const intents: string[] = [];
    let conversationId = '';
    for (const text of steps) {
      const { conversationId: id, out } = await say(text);
      conversationId = id;
      intents.push(out.intent ?? '?');
      expect(out.status).not.toBe('skipped');
    }
    expect(intents).toEqual(['lead_iklan', 'isi_form', 'tanya_harga', 'fokus_campaign', 'setuju', 'unknown']);

    const lines = await transcript(conversationId);
    print('WhatsApp', lines);
    const keys = lines.filter((l) => l.who === 'bot').map((l) => l.key);
    expect(keys.slice(0, 4)).toEqual(['INBOUND_QUALIFY', 'INBOUND_SERVICE_MENU', 'REPLY_TANYA_HARGA', 'REPLY_FOKUS_SALES']);
    expect(lines.some((l) => l.text.includes('jam 10.00 saya catat'))).toBe(true);   // propose-slots honoured the hour
    expect(lines.at(-1)!.text).toContain('meet.google.com');                        // the booking confirmation

    const s = (await state(conversationId))!;
    expect(s).toBeDefined();
    expect(s.node).toBe('scheduled');
    expect(s.meet_link).toContain('meet.google.com');
    expect(s.meeting_at).not.toBeNull();
    const tasks = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ title: string; kind: string; meeting_link: string | null }>(
        `select title, kind, meeting_link from tasks where tenant_id = $1 and conversation_id = $2`, [t.tenantId, conversationId]));
    expect(tasks).toEqual([expect.objectContaining({ kind: 'meeting', title: 'Meeting Kopi Uji x MCN Asia' })]);
    console.log(`state: node=${s.node} meeting_at=${s.meeting_at?.toISOString()} link=${s.meet_link} task="${tasks[0]!.title}"`);
  });

  it('Instagram DM: opener → form → focus answer → handed to WhatsApp', async () => {
    const say = async (text: string) => {
      const m = await withTenant(db, t.tenantId, (tx) =>
        ingestInboundInstagramDmMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          channelId: igChannelId, username: 'budi.brand', threadId: '3401', body: text,
          providerMessageId: `ig.${Math.random()}`, displayName: 'budi.brand',
        }));
      const out = await processBdDraft(
        { db, kek: TEST_KEK, brain, dispatch: async (j) => { dispatched.push(j); } },
        { tenantId: t.tenantId, conversationId: m.conversationId, text },
      );
      return { conversationId: m.conversationId, out };
    };

    let conversationId = '';
    const intents: string[] = [];
    for (const text of ['Info kak', 'Nama brand: Baju Uji, posisi owner, link shopee: -', 'lebih ke sales kak']) {
      const { conversationId: id, out } = await say(text);
      conversationId = id;
      intents.push(out.intent ?? '?');
    }
    expect(intents).toEqual(['minta_info', 'isi_form', 'fokus_campaign']);

    const lines = await transcript(conversationId);
    print('Instagram DM', lines);
    const keys = lines.filter((l) => l.who === 'bot').map((l) => l.key);
    expect(keys).toEqual(['INBOUND_QUALIFY_DM', 'DM_SERVICE_PITCH', 'DM_TO_WA']);
    expect(lines.at(-1)!.text).toContain('WhatsApp');
    expect(await withTenant(db, t.tenantId, (tx) =>
      getBdConversationNode({ tx, tenantId: t.tenantId, kek: TEST_KEK }, conversationId))).toBe('wa_handoff');
  });
});
