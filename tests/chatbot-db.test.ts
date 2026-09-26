import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  withTenant, createWaBridgeChannel, ingestInboundMessage, queueOutboundMessage, listInbox, listWaBridgeChannels,
  listChatbotChannels, chatbotOwnership,
  claimChatbotRun, releaseStalledRuns, finishChatbotRun, markBookingAttempted, setHandling,
  takeoverConversation, resumeBot, chatbotHandlingCounts, markChatbotRunExhausted, unsentChatbotReplies,
  CHATBOT_LEASE_STALE_MS,
  type Ctx, type Database,
} from '@kirana/db';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

type Division = 'marketing' | 'ai';

/** `audit_events.meta` comes back parsed from PGlite and as JSON text from node-postgres. */
const metaOf = <T>(meta: unknown): T => (typeof meta === 'string' ? JSON.parse(meta) : meta) as T;

/**
 * The trained-cb chatbot's database layer (0061): which conversations it
 * owns, the run ledger that makes a redelivered job harmless and serialises
 * a thread, and the takeover / resume hand-offs between the bot and a human.
 */
describe('trained-cb chatbot rows', () => {
  let db: Database;
  let t: TestTenant;
  let other: TestTenant;
  let ownerId: string;
  let waWeb: string;
  let aiWaWeb: string;
  let phoneSeq = 0;

  const inDivision = <T>(division: Division, fn: (ctx: Ctx) => Promise<T>, tenant: TestTenant = t) =>
    withTenant(db, tenant.tenantId, (tx) => fn({ tx, tenantId: tenant.tenantId, kek: TEST_KEK }), {
      divisionId: tenant.divisions[division],
    });

  /** A fresh conversation with one inbound message on the given channel. */
  const inbound = async (channelId: string, division: Division = 'marketing') => {
    phoneSeq += 1;
    const phone = `08133300${String(phoneSeq).padStart(4, '0')}`;
    const result = await inDivision(division, (ctx) => ingestInboundMessage(ctx, {
      channelId, from: phone, body: 'halo', providerMessageId: `wamid.cb.${phoneSeq}`, displayName: 'Gabe',
    }));
    return { ...result, phone };
  };

  /** A second inbound message on an existing conversation's contact. */
  const another = async (channelId: string, phone: string) =>
    inDivision('marketing', (ctx) => ingestInboundMessage(ctx, {
      channelId, from: phone, body: 'lagi', providerMessageId: `wamid.cb.${randomUUID()}`,
    }));

  const run = (id: string) => withTenant(db, t.tenantId, async (tx) =>
    (await tx.query<{ status: string; attempts: number; error: string | null; booking_attempted_at: Date | null }>(
      'select status, attempts, error, booking_attempted_at from chatbot_runs where id = $1', [id]))[0]);

  const claim = (conversationId: string, inboundMessageId: string) =>
    claimChatbotRun(db, { tenantId: t.tenantId, divisionId: t.divisions.marketing, conversationId, inboundMessageId });

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'cbdb');
    other = await makeTenant(db, 'cbother');
    ownerId = await withTenant(db, t.tenantId, async (tx) =>
      (await tx.query<{ id: string }>('select id from users limit 1'))[0]!.id);
    waWeb = (await inDivision('marketing', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web' }))).channelId;
    aiWaWeb = (await inDivision('ai', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web AI' }))).channelId;
  });

  afterAll(async () => { await db.close(); });

  /* ------------------------------------------------------------- accounts */

  it('lists a division\'s own DM accounts, never another division\'s', async () => {
    const listed = await inDivision('marketing', listChatbotChannels);
    expect(listed).toEqual([
      { id: waWeb, kind: 'whatsapp_web', display_name: 'WA Web', status: 'connecting' },
    ]);
    const [ai] = await inDivision('ai', listChatbotChannels);
    expect(ai).toMatchObject({ id: aiWaWeb });
  });

  it('owns a conversation on any DM bridge, in any division, never a Meta channel', async () => {
    const onWaWeb = await inbound(waWeb);
    const onMeta = await inbound(t.channelId);
    const onAi = await inbound(aiWaWeb, 'ai');

    const owned = await inDivision('marketing', (ctx) => chatbotOwnership(ctx, onWaWeb.conversationId));
    expect(owned).toMatchObject({
      owned: true, channelKind: 'whatsapp_web', handling: 'bot', optOut: false, divisionId: t.divisions.marketing,
    });
    expect((await inDivision('marketing', (ctx) => chatbotOwnership(ctx, onMeta.conversationId)))?.owned).toBe(false);
    expect((await inDivision('ai', (ctx) => chatbotOwnership(ctx, onAi.conversationId)))?.owned).toBe(true);
    // Tenant-wide callers read the conversation's own division, not a default.
    const tenantWide = await withTenant(db, t.tenantId, (tx) =>
      chatbotOwnership({ tx, tenantId: t.tenantId }, onAi.conversationId));
    expect(tenantWide).toMatchObject({ owned: true, divisionId: t.divisions.ai });
    // And across the division boundary the conversation does not exist.
    expect(await inDivision('marketing', (ctx) => chatbotOwnership(ctx, onAi.conversationId))).toBeNull();

    const inbox = await inDivision('marketing', (ctx) => listInbox(ctx));
    const byId = Object.fromEntries(inbox.map((r) => [r.id, r]));
    expect(byId[onWaWeb.conversationId]).toMatchObject({ handling: 'bot', chatbot_owned: true });
    expect(byId[onMeta.conversationId]).toMatchObject({ handling: 'bot', chatbot_owned: false });
  });

  /* ------------------------------------------------------------------ runs */

  it('claims an inbound message once, and calls a redelivery a duplicate', async () => {
    const m = await inbound(waWeb);
    const first = await claim(m.conversationId, m.messageId);
    expect(first).toMatchObject({ outcome: 'claimed', attempts: 1, bookingAttemptedAt: null });

    // Same message again while the first is still running: not a duplicate yet.
    expect((await claim(m.conversationId, m.messageId)).outcome).toBe('busy');

    const finished = await inDivision('marketing', (ctx) => finishChatbotRun(ctx, {
      runId: first.runId!, status: 'replied', intent: 'greeting',
      actions: [{ type: 'send' }], replyMessageIds: [],
    }));
    expect(finished).toBe(true);
    expect(await claim(m.conversationId, m.messageId)).toEqual({ outcome: 'duplicate', runId: first.runId });
    // A finished run cannot be finished twice.
    expect(await inDivision('marketing', (ctx) =>
      finishChatbotRun(ctx, { runId: first.runId!, status: 'skipped' }))).toBe(false);
  });

  it('holds one lease per conversation, and releases it when the run ends', async () => {
    const m1 = await inbound(waWeb);
    const m2 = await another(waWeb, m1.phone);
    expect(m2.conversationId).toBe(m1.conversationId);

    const first = await claim(m1.conversationId, m1.messageId);
    expect(first.outcome).toBe('claimed');
    expect(await claim(m2.conversationId, m2.messageId)).toEqual({ outcome: 'busy' });

    // Another conversation is not held up by this one.
    const elsewhere = await inbound(waWeb);
    expect((await claim(elsewhere.conversationId, elsewhere.messageId)).outcome).toBe('claimed');

    await inDivision('marketing', (ctx) => finishChatbotRun(ctx, { runId: first.runId!, status: 'skipped', skipReason: 'test' }));
    expect((await claim(m2.conversationId, m2.messageId)).outcome).toBe('claimed');
  });

  it('reclaims a failed run with its attempt count and its booking marker', async () => {
    const m = await inbound(waWeb);
    const first = await claim(m.conversationId, m.messageId);
    expect(await inDivision('marketing', (ctx) => markBookingAttempted(ctx, first.runId!))).toBe(true);
    expect(await inDivision('marketing', (ctx) => markBookingAttempted(ctx, first.runId!))).toBe(false);
    await inDivision('marketing', (ctx) => finishChatbotRun(ctx, { runId: first.runId!, status: 'failed', error: 'brain 503' }));

    const again = await claim(m.conversationId, m.messageId);
    expect(again).toMatchObject({ outcome: 'reclaimed', runId: first.runId, attempts: 2 });
    expect(again.bookingAttemptedAt).toBeInstanceOf(Date);
    expect(await run(first.runId!)).toMatchObject({ status: 'running', attempts: 2, error: null });
  });

  it('does not reclaim a failed run while another message holds the thread', async () => {
    const m1 = await inbound(waWeb);
    const m2 = await another(waWeb, m1.phone);
    const r1 = await claim(m1.conversationId, m1.messageId);
    await inDivision('marketing', (ctx) => finishChatbotRun(ctx, { runId: r1.runId!, status: 'failed', error: 'x' }));
    // Given up on by the queue, so it no longer holds the next message back.
    expect(await inDivision('marketing', (ctx) =>
      markChatbotRunExhausted(ctx, { runId: r1.runId!, error: 'attempts spent' }))).toBe(true);
    const r2 = await claim(m2.conversationId, m2.messageId);
    expect(r2.outcome).toBe('claimed');

    expect(await claim(m1.conversationId, m1.messageId)).toEqual({ outcome: 'busy' });
    expect(await run(r1.runId!)).toMatchObject({ status: 'failed', error: 'x' });
  });

  it('answers the messages on a thread in the order they arrived', async () => {
    const m1 = await inbound(waWeb);
    const m2 = await another(waWeb, m1.phone);

    // The later message reached a worker first: it waits for the earlier one.
    expect(await claim(m2.conversationId, m2.messageId)).toEqual({ outcome: 'busy' });
    const r1 = await claim(m1.conversationId, m1.messageId);
    expect(r1.outcome).toBe('claimed');

    // The earlier one failed and is waiting for its retry: still first.
    await inDivision('marketing', (ctx) =>
      finishChatbotRun(ctx, { runId: r1.runId!, status: 'failed', error: 'brain 503' }));
    expect(await claim(m2.conversationId, m2.messageId)).toEqual({ outcome: 'busy' });
    expect((await claim(m1.conversationId, m1.messageId)).outcome).toBe('reclaimed');
    await inDivision('marketing', (ctx) => finishChatbotRun(ctx, { runId: r1.runId!, status: 'replied' }));
    const r2 = await claim(m2.conversationId, m2.messageId);
    expect(r2.outcome).toBe('claimed');
    await inDivision('marketing', (ctx) => finishChatbotRun(ctx, { runId: r2.runId!, status: 'replied' }));

    // A message with no run at all — its job was lost between ingest and the
    // queue — stops holding the next one back once the wait is over.
    const unanswered = await another(waWeb, m1.phone);
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `update messages set created_at = now() - ($2::int * interval '1 millisecond') - interval '1 minute'
        where id = $1`, [unanswered.messageId, CHATBOT_LEASE_STALE_MS]));
    const m4 = await another(waWeb, m1.phone);
    expect((await claim(m4.conversationId, m4.messageId)).outcome).toBe('claimed');
  });

  it('sweeps a stalled lease, and the message it held still goes before the next one', async () => {
    const m1 = await inbound(waWeb);
    const m2 = await another(waWeb, m1.phone);
    const stuck = await claim(m1.conversationId, m1.messageId);
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `update chatbot_runs set started_at = now() - interval '3 minutes' where id = $1`, [stuck.runId]));

    // The claim itself sweeps the thread's stalled lease first; the swept
    // message is then waiting for its retry, so it keeps its turn.
    expect(await claim(m2.conversationId, m2.messageId)).toEqual({ outcome: 'busy' });
    expect(await run(stuck.runId!)).toMatchObject({ status: 'failed', error: 'stalled' });
    expect(await inDivision('marketing', (ctx) =>
      finishChatbotRun(ctx, { runId: stuck.runId!, status: 'replied' }))).toBe(false);

    expect(await claim(m1.conversationId, m1.messageId)).toMatchObject({ outcome: 'reclaimed', attempts: 2 });
    await inDivision('marketing', (ctx) => finishChatbotRun(ctx, { runId: stuck.runId!, status: 'replied' }));
    expect((await claim(m2.conversationId, m2.messageId)).outcome).toBe('claimed');

    // And the tenant-wide sweep does the same for threads nobody writes to.
    const idle = await inbound(waWeb);
    const idleRun = await claim(idle.conversationId, idle.messageId);
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `update chatbot_runs set started_at = now() - interval '3 minutes' where id = $1`, [idleRun.runId]));
    expect(await withTenant(db, t.tenantId, (tx) => releaseStalledRuns({ tx, tenantId: t.tenantId }))).toBe(1);
    expect(await withTenant(db, t.tenantId, (tx) => releaseStalledRuns({ tx, tenantId: t.tenantId }))).toBe(0);
  });

  /* ------------------------------------------------------------- handling */

  it('takeover stops the bot, assigns the agent and cancels only queued bot replies', async () => {
    const m = await inbound(waWeb);
    const conversationId = m.conversationId;
    const queued = await inDivision('marketing', async (ctx) => ({
      bot1: (await queueOutboundMessage(ctx, { conversationId, body: 'bot 1', senderType: 'bot' })).messageId,
      bot2: (await queueOutboundMessage(ctx, { conversationId, body: 'bot 2', senderType: 'bot' })).messageId,
      botSent: (await queueOutboundMessage(ctx, { conversationId, body: 'bot sent', senderType: 'bot' })).messageId,
      agent: (await queueOutboundMessage(ctx, { conversationId, body: 'agent', senderType: 'agent', senderId: ownerId })).messageId,
      autopilot: (await queueOutboundMessage(ctx, { conversationId, body: 'legacy', senderType: 'autopilot' })).messageId,
    }));
    await withTenant(db, t.tenantId, async (tx) => {
      await tx.query(`update messages set status = 'sent' where id = $1`, [queued.botSent]);
      await tx.query('delete from message_outbox where message_id = $1', [queued.botSent]);
    });

    const result = await inDivision('marketing', (ctx) =>
      takeoverConversation(ctx, { conversationId, actorId: ownerId }));
    expect(result?.assigneeId).toBe(ownerId);
    expect(result?.cancelledMessageIds.sort()).toEqual([queued.bot1, queued.bot2].sort());

    const rows = await withTenant(db, t.tenantId, (tx) => tx.query<{
      id: string; status: string; error: { reason: string } | null; outbox: number;
    }>(
      `select m.id, m.status, m.error,
              (select count(*)::int from message_outbox o where o.message_id = m.id) as outbox
         from messages m where m.conversation_id = $1 and m.direction = 'outbound'`, [conversationId]));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    for (const id of [queued.bot1, queued.bot2]) {
      expect(byId[id]).toMatchObject({ status: 'failed', error: { reason: 'bot_cancelled_by_takeover' }, outbox: 0 });
    }
    expect(byId[queued.botSent]).toMatchObject({ status: 'sent', outbox: 0 });
    expect(byId[queued.agent]).toMatchObject({ status: 'queued', error: null, outbox: 1 });
    expect(byId[queued.autopilot]).toMatchObject({ status: 'queued', error: null, outbox: 1 });

    const owned = await inDivision('marketing', (ctx) => chatbotOwnership(ctx, conversationId));
    expect(owned).toMatchObject({ owned: true, handling: 'human' });
  });

  it('takeover keeps an existing assignee', async () => {
    const m = await inbound(waWeb);
    const agent = await withTenant(db, t.tenantId, async (tx) => (await tx.query<{ id: string }>(
      `insert into users (tenant_id, email, name, role) values ($1, 'agent@cbdb.test', 'Agent', 'agent') returning id`,
      [t.tenantId]))[0]!.id);
    await withTenant(db, t.tenantId, (tx) => tx.query(
      'update conversations set assignee_id = $2 where id = $1', [m.conversationId, agent]));

    const result = await inDivision('marketing', (ctx) =>
      takeoverConversation(ctx, { conversationId: m.conversationId, actorId: ownerId }));
    expect(result).toEqual({ assigneeId: agent, cancelledMessageIds: [] });
    expect(await inDivision('marketing', (ctx) =>
      takeoverConversation(ctx, { conversationId: randomUUID(), actorId: ownerId }))).toBeNull();
  });

  it('resumes after a handover the way the engine releases it, keeping the rest of its state', async () => {
    const m = await inbound(waWeb);
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `insert into bd_conversation_state
         (tenant_id, conversation_id, node, outcome, gadget_loops, unknown_streak, price_stage, meet_link)
       values ($1, $2, 'handover', 'acceptance', 2, 3, 1, 'https://meet.example/abc')`,
      [t.tenantId, m.conversationId]));
    expect(await inDivision('marketing', (ctx) =>
      setHandling(ctx, { conversationId: m.conversationId, handling: 'needs_human' }))).toBe(true);

    expect(await inDivision('marketing', (ctx) =>
      resumeBot(ctx, { conversationId: m.conversationId, actorId: ownerId }))).toBe('resumed');

    const state = await withTenant(db, t.tenantId, async (tx) => (await tx.query<{
      handling: string; node: string; outcome: string; unknown_streak: number; gadget_loops: number;
      price_stage: number; meet_link: string;
    }>(
      `select c.handling, s.node, s.outcome, s.unknown_streak, s.gadget_loops, s.price_stage, s.meet_link
         from conversations c join bd_conversation_state s on s.conversation_id = c.id
        where c.id = $1`, [m.conversationId]))[0]);
    expect(state).toEqual({
      handling: 'bot', node: 'qna', outcome: 'followup', unknown_streak: 0,
      gadget_loops: 2, price_stage: 1, meet_link: 'https://meet.example/abc',
    });

    const audits = await withTenant(db, t.tenantId, (tx) => tx.query<{ meta: unknown }>(
      `select meta from audit_events where action = 'chatbot.resumed' and resource_id = $1`, [m.conversationId]));
    expect(audits.map((a) => metaOf<{ releasedNode: string }>(a.meta).releasedNode)).toEqual(['handover']);
  });

  it('leaves the engine state alone when resuming a plain takeover', async () => {
    const m = await inbound(waWeb);
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `insert into bd_conversation_state (tenant_id, conversation_id, node, unknown_streak)
       values ($1, $2, 'scheduling', 1)`, [t.tenantId, m.conversationId]));
    await inDivision('marketing', (ctx) => takeoverConversation(ctx, { conversationId: m.conversationId, actorId: ownerId }));

    expect(await inDivision('marketing', (ctx) =>
      resumeBot(ctx, { conversationId: m.conversationId, actorId: ownerId }))).toBe('resumed');
    const [row] = await withTenant(db, t.tenantId, (tx) => tx.query<{ handling: string; node: string; unknown_streak: number }>(
      `select c.handling, s.node, s.unknown_streak from conversations c
         join bd_conversation_state s on s.conversation_id = c.id where c.id = $1`, [m.conversationId]));
    expect(row).toEqual({ handling: 'bot', node: 'scheduling', unknown_streak: 1 });
  });

  it('keeps a contact\'s opt-out on the next conversation, once the thread it was said on is resolved', async () => {
    const m = await inbound(waWeb);
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `insert into bd_conversation_state (tenant_id, conversation_id, node, stopped_reason)
       values ($1, $2, 'stopped', 'opt_out')`, [t.tenantId, m.conversationId]));
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `update conversations set status = 'resolved' where id = $1`, [m.conversationId]));

    const next = await another(waWeb, m.phone);
    expect(next.conversationId).not.toBe(m.conversationId);
    expect(await inDivision('marketing', (ctx) => chatbotOwnership(ctx, next.conversationId)))
      .toMatchObject({ owned: true, handling: 'bot', optOut: true });
    await inDivision('marketing', (ctx) => setHandling(ctx, { conversationId: next.conversationId, handling: 'human' }));
    expect(await inDivision('marketing', (ctx) =>
      resumeBot(ctx, { conversationId: next.conversationId, actorId: ownerId }))).toBe('opt_out');

    // Another contact on the same account is not touched by it.
    const stranger = await inbound(waWeb);
    expect((await inDivision('marketing', (ctx) => chatbotOwnership(ctx, stranger.conversationId)))?.optOut).toBe(false);
  });

  it('never resumes a contact who opted out', async () => {
    const m = await inbound(waWeb);
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `insert into bd_conversation_state (tenant_id, conversation_id, node, stopped_reason)
       values ($1, $2, 'stopped', 'opt_out')`, [t.tenantId, m.conversationId]));
    await inDivision('marketing', (ctx) => setHandling(ctx, { conversationId: m.conversationId, handling: 'human' }));

    expect(await inDivision('marketing', (ctx) =>
      resumeBot(ctx, { conversationId: m.conversationId, actorId: ownerId }))).toBe('opt_out');
    const owned = await inDivision('marketing', (ctx) => chatbotOwnership(ctx, m.conversationId));
    expect(owned).toMatchObject({ handling: 'human', optOut: true });
    const [state] = await withTenant(db, t.tenantId, (tx) => tx.query<{ node: string }>(
      'select node from bd_conversation_state where conversation_id = $1', [m.conversationId]));
    expect(state!.node).toBe('stopped');

    expect(await inDivision('marketing', (ctx) =>
      resumeBot(ctx, { conversationId: randomUUID(), actorId: ownerId }))).toBe('not_found');
  });

  it('lists a finished run\'s replies the outbound worker has not taken yet, in order', async () => {
    const m = await inbound(waWeb);
    const r = await claim(m.conversationId, m.messageId);
    const ids = await inDivision('marketing', async (ctx) => [
      (await queueOutboundMessage(ctx, { conversationId: m.conversationId, body: 'satu', senderType: 'bot' })).messageId,
      (await queueOutboundMessage(ctx, { conversationId: m.conversationId, body: 'dua', senderType: 'bot' })).messageId,
      (await queueOutboundMessage(ctx, { conversationId: m.conversationId, body: 'tiga', senderType: 'bot' })).messageId,
    ]);
    // Still running: nothing is handed over twice while the first attempt works.
    expect(await inDivision('marketing', (ctx) => unsentChatbotReplies(ctx, r.runId!))).toEqual([]);

    await inDivision('marketing', (ctx) =>
      finishChatbotRun(ctx, { runId: r.runId!, status: 'replied', replyMessageIds: ids }));
    await withTenant(db, t.tenantId, (tx) => tx.query(`update messages set status = 'sent' where id = $1`, [ids[1]]));
    expect(await inDivision('marketing', (ctx) => unsentChatbotReplies(ctx, r.runId!))).toEqual([ids[0], ids[2]]);
  });

  it('changes handling only from the states the caller names', async () => {
    const m = await inbound(waWeb);
    await inDivision('marketing', (ctx) => setHandling(ctx, { conversationId: m.conversationId, handling: 'human' }));
    expect(await inDivision('marketing', (ctx) => setHandling(ctx, {
      conversationId: m.conversationId, handling: 'needs_human', onlyFrom: ['bot'],
    }))).toBe(false);
    expect((await inDivision('marketing', (ctx) => chatbotOwnership(ctx, m.conversationId)))?.handling).toBe('human');
  });

  it('counts open chatbot conversations by who is handling them, per division', async () => {
    const counts = await inDivision('marketing', chatbotHandlingCounts);
    const direct = await withTenant(db, t.tenantId, (tx) => tx.query<{ handling: string; n: number }>(
      `select c.handling, count(*)::int as n from conversations c join channels ch on ch.id = c.channel_id
        where c.division_id = $1 and ch.kind = 'whatsapp_web' and c.status <> 'resolved' group by c.handling`,
      [t.divisions.marketing]));
    const expected = { bot: 0, human: 0, needs_human: 0, ...Object.fromEntries(direct.map((r) => [r.handling, r.n])) };
    expect(counts).toEqual(expected);
    expect(counts.human).toBeGreaterThan(0);
    expect(await inDivision('ai', chatbotHandlingCounts)).toEqual({ bot: 1, human: 0, needs_human: 0 });
  });

  it('labels a trained-cb reply as the bot on the WhatsApp Web status funnel', async () => {
    const m = await inbound(waWeb);
    await inDivision('marketing', (ctx) =>
      queueOutboundMessage(ctx, { conversationId: m.conversationId, body: 'halo dari bot', senderType: 'bot' }));
    const before = await inDivision('marketing', (ctx) => listWaBridgeChannels(ctx));
    expect(before.find((c) => c.id === waWeb)!.chat_bot).toBeGreaterThanOrEqual(1);
  });

  /* ------------------------------------------------------------ isolation */

  it('keeps settings and runs inside their division and their tenant', async () => {
    // Nothing seeds chatbot_settings any more — the division switch it once
    // held is gone — so this row is written here, purely to exercise the RLS
    // policy the table still carries.
    await inDivision('ai', (ctx) => ctx.tx.query(
      `insert into chatbot_settings (tenant_id, division_id, enabled) values ($1, $2, true)`,
      [t.tenantId, t.divisions.ai]));
    await inDivision('marketing', (ctx) => ctx.tx.query(
      `insert into chatbot_settings (tenant_id, division_id, enabled) values ($1, $2, true)`,
      [other.tenantId, other.divisions.marketing]), other);

    const aiSees = await inDivision('ai', async (ctx) => ({
      settings: await ctx.tx.query<{ division_id: string }>('select division_id from chatbot_settings'),
      runs: await ctx.tx.query<{ id: string }>('select id from chatbot_runs'),
    }));
    expect(aiSees.settings.map((r) => r.division_id)).toEqual([t.divisions.ai]);
    expect(aiSees.runs).toEqual([]);

    const marketingRuns = await inDivision('marketing', (ctx) =>
      ctx.tx.query<{ n: number }>('select count(*)::int as n from chatbot_runs'));
    expect(marketingRuns[0]!.n).toBeGreaterThan(0);

    await expect(inDivision('ai', (ctx) => ctx.tx.query(
      `update chatbot_settings set enabled = true where division_id = $1 returning division_id`,
      [t.divisions.marketing]))).resolves.toEqual([]);
    await expect(inDivision('ai', (ctx) => ctx.tx.query(
      `insert into chatbot_settings (tenant_id, division_id, enabled) values ($1, $2, true)
       on conflict (tenant_id, division_id) do update set enabled = true`,
      [t.tenantId, t.divisions.marketing]))).rejects.toThrow(/row-level security/i);

    const otherSees = await inDivision('marketing', async (ctx) => ({
      settings: await ctx.tx.query('select 1 from chatbot_settings'),
      runs: await ctx.tx.query('select 1 from chatbot_runs'),
    }), other);
    expect(otherSees.settings).toHaveLength(1);
    expect(otherSees.runs).toEqual([]);
  });
});
