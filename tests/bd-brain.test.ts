import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  withTenant, ingestInboundMessage, ingestInboundInstagramDmMessage, ensureInstagramBridgeChannel,
  recordIgComment, getIgComment, getBdConversationNode, seedBdConversationState, tenantKeys, openField,
  type Database,
} from '@kirana/db';
import type { BdBrainClient, BdStep } from '../apps/worker/src/bdBrain.ts';
import { processBdDraft, bdSourceOf } from '../apps/worker/src/processors/bdDraft.ts';
import { processIgCommentReply, NODE_AFTER_COMMENT_OPENER } from '../apps/worker/src/processors/igCommentReply.ts';
import type { IgBridgeClient } from '../apps/worker/src/igBridgeClient.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * The CRM's half of the BD brain contract (apps/bd-brain), against a real
 * database and a brain that only records what it was asked.
 *
 * Three things were wrong on this side before 25 Sep 2026, each pinned here:
 * `bd.draft` sent no `source`, so an Instagram DM was answered with the
 * WhatsApp form and could never be moved to WhatsApp; it sent no `history`,
 * so the brain could not tell whether "lebih ke sales" answered a question of
 * ours; and the comment processor sent the DM opener without telling the flow,
 * so the commenter's first reply got the qualification questions twice.
 */

/* ------------------------------------------------------------- fakes */

type StepArgs = Parameters<BdBrainClient['step']>[0];

/** A brain that answers every step with one short reply and remembers the
 * request. Shaped as the client, cast once, so a signature change surfaces
 * here as a type error rather than a runtime surprise. */
function recordingBrain(answer?: Partial<BdStep>): BdBrainClient & { steps: StepArgs[] } {
  const steps: StepArgs[] = [];
  const brain = {
    steps,
    async step(args: StepArgs): Promise<BdStep> {
      steps.push(args);
      return {
        intent: 'lead_iklan',
        conversation: { ...args.conversation, node: 'inbound_qualify', outcome: 'followup' },
        actions: [
          { type: 'cancel_timers' },
          { type: 'send', text: 'Halo, Kak — boleh isi data berikut?', key: 'INBOUND_QUALIFY',
            attach_company_profile: false, attach_opening: false, attach_case_study: false, attach_ads_deck: false },
          { type: 'set_node', node: 'inbound_qualify', outcome: 'followup' },
        ],
        ...answer,
      };
    },
    async book() { throw new Error('not expected in these tests'); },
    async proposeSlots() { throw new Error('not expected in these tests'); },
  };
  return brain as unknown as BdBrainClient & { steps: StepArgs[] };
}

function stubIgBridge(dm: { sent: boolean; alreadyThere?: boolean; threadId?: string; error?: string }): IgBridgeClient {
  return {
    async send() {},
    async replyToComment() {
      return { public: { sent: true }, dm };
    },
  } as unknown as IgBridgeClient;
}

const commentTexts = async () => ({
  publicReply: 'Halo Kak, siap 😊 Detailnya sudah kami kirim lewat DM ya, Kak 🙏',
  dmOpener: 'Halo Kak 😊 Terima kasih sudah komen di postingan kami ya. Boleh diinfokan nama brand?',
});

/* --------------------------------------------------------------- setup */

describe('bd.draft → the brain', () => {
  let db: Database;
  let t: TestTenant;
  const dispatched: { queue: string; payload: unknown }[] = [];

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'bdbrain');
    dispatched.length = 0;
  });
  afterEach(async () => { await db.close(); });

  const waMessage = (text: string) => withTenant(db, t.tenantId, (tx) =>
    ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
      channelId: t.channelId, from: '08123456789', body: text,
      providerMessageId: `wamid.${Math.random()}`, displayName: 'Cika',
    }));

  const igDm = async (text: string) => {
    const { channelId } = await withTenant(db, t.tenantId, (tx) =>
      ensureInstagramBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { username: 'mcnasia.biz' }));
    return withTenant(db, t.tenantId, (tx) =>
      ingestInboundInstagramDmMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId, username: 'budi.brand', threadId: '3401', body: text,
        providerMessageId: `ig.${Math.random()}`, displayName: 'budi.brand',
      }));
  };

  const run = (brain: BdBrainClient, conversationId: string, text: string) =>
    processBdDraft(
      { db, kek: TEST_KEK, brain, dispatch: async (j) => { dispatched.push(j); } },
      { tenantId: t.tenantId, conversationId, text },
    );

  it('maps the channel kind to the flow\'s source', () => {
    expect(bdSourceOf('whatsapp')).toBe('');
    expect(bdSourceOf('whatsapp_web')).toBe('');
    expect(bdSourceOf('instagram')).toBe('instagram');
    expect(bdSourceOf('instagram_bridge')).toBe('instagram');
    expect(bdSourceOf('messenger_bridge')).toBe('facebook');
    expect(bdSourceOf(null)).toBe('');
  });

  it('sends source "" for a WhatsApp thread and "instagram" for a DM', async () => {
    const brain = recordingBrain();
    const wa = await waMessage('Halo! Bisa minta info lebih lanjut tentang ini?');
    await run(brain, wa.conversationId, 'Halo! Bisa minta info lebih lanjut tentang ini?');
    expect(brain.steps[0]!.conversation.source).toBe('');

    const ig = await igDm('Info kak');
    await run(brain, ig.conversationId, 'Info kak');
    expect(brain.steps[1]!.conversation.source).toBe('instagram');
    // The rest of the state still travels as before.
    expect(brain.steps[1]!.conversation.node).toBe('new');
    expect(brain.steps[1]!.conversation.jid).toBe(ig.conversationId);
  });

  it('sends the recent turns with timestamps, oldest first, on every step', async () => {
    const brain = recordingBrain();
    const first = await waMessage('Halo! Bisa minta info lebih lanjut tentang ini?');
    const outcome = await run(brain, first.conversationId, 'Halo! Bisa minta info lebih lanjut tentang ini?');
    expect(outcome.status).toBe('replied');

    // The first step already saw the message it was answering — the CRM
    // records before it asks — and nothing else.
    expect(brain.steps[0]!.history).toEqual([
      expect.objectContaining({ direction: 'in', body: 'Halo! Bisa minta info lebih lanjut tentang ini?' }),
    ]);

    await waMessage('Nama Brand: Kopi Uji');
    await run(brain, first.conversationId, 'Nama Brand: Kopi Uji');
    const history = brain.steps[1]!.history!;
    expect(history.map((h) => h.direction)).toEqual(['in', 'out', 'in']);
    expect(history[1]!.body).toBe('Halo, Kak — boleh isi data berikut?');
    for (const turn of history) expect(() => new Date(turn.at!).toISOString()).not.toThrow();
    // Oldest first: the reply we queued sits between the two inbound turns.
    expect(new Date(history[0]!.at!).getTime()).toBeLessThanOrEqual(new Date(history[2]!.at!).getTime());
  });

  it('a booking moves the state to scheduled, queues the confirmation and creates the meeting task', async () => {
    const brain = recordingBrain({
      intent: 'unknown',
      actions: [{ type: 'cancel_timers' }, { type: 'book_meeting', preferred: '' }],
    });
    // What `/v1/book` answers when the calendar had the slot: the flow's
    // `on_meeting_booked` has already moved the conversation to SCHEDULED.
    (brain as unknown as { book: BdBrainClient['book'] }).book = async (args) => ({
      booked: true,
      meeting_at: '2026-09-26T03:00:00.000Z',
      meet_link: 'https://meet.google.com/sim-ulasi-aja',
      event_id: 'evt-1',
      html_link: 'https://calendar.google.com/event?eid=evt-1',
      messages: ['Baik, Kak. Jadwal meeting kita sudah saya konfirmasi: 10.00 WIB, https://meet.google.com/sim-ulasi-aja'],
      conversation: { ...args.conversation, node: 'scheduled', outcome: 'acceptance',
        meeting_at: '2026-09-26T03:00:00.000Z', meet_link: 'https://meet.google.com/sim-ulasi-aja' },
    });
    const m = await waMessage('email saya cika@contoh.id');
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `insert into bd_conversation_state (tenant_id, conversation_id, node, outcome) values ($1, $2, 'scheduling', 'acceptance')`,
      [t.tenantId, m.conversationId]));

    const outcome = await run(brain, m.conversationId, 'email saya cika@contoh.id');
    expect(outcome.status).toBe('replied');

    const row = await withTenant(db, t.tenantId, (tx) => tx.query<{ node: string; outcome: string; meet_link: string; meeting_at: Date | null }>(
      `select node, outcome, meet_link, meeting_at from bd_conversation_state where tenant_id = $1 and conversation_id = $2`,
      [t.tenantId, m.conversationId]).then((r) => r[0]!));
    expect(row.node).toBe('scheduled');
    expect(row.outcome).toBe('acceptance');
    expect(row.meet_link).toBe('https://meet.google.com/sim-ulasi-aja');
    expect(row.meeting_at?.toISOString()).toBe('2026-09-26T03:00:00.000Z');

    const tasks = await withTenant(db, t.tenantId, (tx) => tx.query<{ kind: string; calendar_event_id: string | null }>(
      `select kind, calendar_event_id from tasks where tenant_id = $1 and conversation_id = $2`, [t.tenantId, m.conversationId]));
    expect(tasks).toEqual([{ kind: 'meeting', calendar_event_id: 'evt-1' }]);
    expect(dispatched.filter((j) => j.queue === 'outbound.send')).toHaveLength(1);
  });

  it('keeps the node the brain returned, and the new wa_handoff node is storable', async () => {
    const brain = recordingBrain({
      intent: 'fokus_campaign',
      actions: [
        { type: 'cancel_timers' },
        { type: 'send', text: 'Ini nomor WhatsApp kami: +62 800', key: 'DM_TO_WA',
          attach_company_profile: false, attach_opening: false, attach_case_study: false, attach_ads_deck: false },
        { type: 'set_node', node: 'wa_handoff', outcome: 'followup' },
        { type: 'escalate', reason: 'lead DM diarahkan ke WhatsApp', inbound_text: '' },
      ],
    });
    const ig = await igDm('lebih ke sales kak');
    const outcome = await run(brain, ig.conversationId, 'lebih ke sales kak');
    expect(outcome.status).toBe('handover');
    const node = await withTenant(db, t.tenantId, (tx) =>
      getBdConversationNode({ tx, tenantId: t.tenantId, kek: TEST_KEK }, ig.conversationId));
    expect(node).toBe('wa_handoff');
  });
});

describe('an Instagram comment → the DM opener → the flow knows', () => {
  let db: Database;
  let t: TestTenant;

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'igcomment');
    await withTenant(db, t.tenantId, (tx) =>
      ensureInstagramBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { username: 'mcnasia.biz' }));
  });
  afterEach(async () => { await db.close(); });

  const comment = (commenter = 'budi.brand') => withTenant(db, t.tenantId, (tx) =>
    recordIgComment({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
      postRef: 'post-1', commentRef: `c-${Math.random()}`, commenter, text: 'info kak',
    }));

  const nodeOf = (conversationId: string) => withTenant(db, t.tenantId, (tx) =>
    getBdConversationNode({ tx, tenantId: t.tenantId, kek: TEST_KEK }, conversationId));

  it('parks a new commenter at inbound_qualify once the opener is sent, and links the comment', async () => {
    const { id } = await comment();
    const outcome = await processIgCommentReply(
      { db, kek: TEST_KEK, igBridge: stubIgBridge({ sent: true, threadId: '3401' }), commentTexts },
      { tenantId: t.tenantId, commentId: id },
    );
    expect(outcome.status).toBe('replied');

    const row = (await withTenant(db, t.tenantId, (tx) =>
      getIgComment({ tx, tenantId: t.tenantId, kek: TEST_KEK }, id)))!;
    expect(row.dmStatus).toBe('sent');
    expect(row.conversationId).not.toBeNull();
    expect(await nodeOf(row.conversationId!)).toBe(NODE_AFTER_COMMENT_OPENER);

    // The opener is on the transcript as our message — the brain will see
    // it as the last thing we said — and it was never queued for sending.
    const messages = await withTenant(db, t.tenantId, async (tx) => {
      const rows = await tx.query<{ direction: string; status: string; body_enc: string }>(
        `select direction, status, body_enc from messages where tenant_id = $1 and conversation_id = $2`,
        [t.tenantId, row.conversationId]);
      const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
      return rows.map((r) => ({ ...r, body: openField(keys, t.tenantId, r.body_enc) }));
    });
    expect(messages).toEqual([expect.objectContaining({ direction: 'outbound', status: 'sent' })]);
    expect(messages[0]!.body).toContain('nama brand');

    // The commenter's reply lands on that same conversation, at that node —
    // which is the whole point: bd.draft steps it from inbound_qualify.
    const { channelId } = await withTenant(db, t.tenantId, (tx) =>
      ensureInstagramBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { username: 'mcnasia.biz' }));
    const reply = await withTenant(db, t.tenantId, (tx) =>
      ingestInboundInstagramDmMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId, username: 'budi.brand', threadId: '3401', body: 'Nama brand: Baju Uji',
        providerMessageId: 'ig.reply.1',
      }));
    expect(reply.conversationId).toBe(row.conversationId);
  });

  it('never rewinds someone who already has state', async () => {
    // They talked to us before and are mid-way through booking.
    const { channelId } = await withTenant(db, t.tenantId, (tx) =>
      ensureInstagramBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { username: 'mcnasia.biz' }));
    const earlier = await withTenant(db, t.tenantId, (tx) =>
      ingestInboundInstagramDmMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId, username: 'budi.brand', threadId: '3401', body: 'boleh, besok jam 10',
        providerMessageId: 'ig.old.1',
      }));
    await withTenant(db, t.tenantId, (tx) =>
      seedBdConversationState({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        conversationId: earlier.conversationId, node: 'scheduling',
      }));

    const { id } = await comment();
    await processIgCommentReply(
      { db, kek: TEST_KEK, igBridge: stubIgBridge({ sent: true, threadId: '3401' }), commentTexts },
      { tenantId: t.tenantId, commentId: id },
    );
    expect(await nodeOf(earlier.conversationId)).toBe('scheduling');
  });

  it('seeds when the opener was already in their DMs, and not when the DM failed', async () => {
    const already = await comment('sudah.punya');
    await processIgCommentReply(
      { db, kek: TEST_KEK, igBridge: stubIgBridge({ sent: false, alreadyThere: true, threadId: '3402' }), commentTexts },
      { tenantId: t.tenantId, commentId: already.id },
    );
    const alreadyRow = (await withTenant(db, t.tenantId, (tx) =>
      getIgComment({ tx, tenantId: t.tenantId, kek: TEST_KEK }, already.id)))!;
    expect(alreadyRow.dmStatus).toBe('skipped');
    expect(await nodeOf(alreadyRow.conversationId!)).toBe(NODE_AFTER_COMMENT_OPENER);

    const failed = await comment('tidak.terkirim');
    await processIgCommentReply(
      { db, kek: TEST_KEK, igBridge: stubIgBridge({ sent: false, error: 'no message button' }), commentTexts },
      { tenantId: t.tenantId, commentId: failed.id },
    );
    const failedRow = (await withTenant(db, t.tenantId, (tx) =>
      getIgComment({ tx, tenantId: t.tenantId, kek: TEST_KEK }, failed.id)))!;
    expect(failedRow.dmStatus).toBe('failed');
    expect(failedRow.conversationId).toBeNull();
  });
});
