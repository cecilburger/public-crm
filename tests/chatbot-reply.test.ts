import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { env, type Env } from '@kirana/core';
import {
  withTenant, createWaBridgeChannel, ingestInboundMessage, queueOutboundMessage,
  ensureInstagramBridgeChannel, ensureMessengerBridgeChannel, ingestInboundMessengerMessage,
  setChatbotEnabled, setChannelChatbotEnabled, setHandling, takeoverConversation, resumeBot,
  claimChatbotRun, finishChatbotRun, markBookingAttempted, tenantKeys, openField,
  type Ctx, type Database, type Handling,
} from '@kirana/db';
import { processFbBridgeEvent } from '../apps/worker/src/processors/facebookInbound.ts';
import { buildApp } from '../apps/api/src/app.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { processOutbound } from '../apps/worker/src/processors/outboundSend.ts';
import { processAutopilotDraft } from '../apps/worker/src/processors/autopilotDraft.ts';
import {
  processChatbotReply, chatbotDispatch, markChatbotExhausted, LeaseLostError, CHATBOT_REPLY_QUEUE,
  type ChatbotBrain, type ChatbotDeps, type ChatbotJob,
} from '../apps/worker/src/processors/chatbotReply.ts';
import { processLegacyBdDraft, LEGACY_BD_DRAFT_QUEUE } from '../apps/worker/src/processors/bdDraft.ts';
import {
  deferWhileBusy, handOverFailedChatbotJob, CHATBOT_BUSY_DELAY_MS,
} from '../apps/worker/src/processors/chatbotQueue.ts';
import {
  BdBrainClient, bdBrainFromEnv, DEFAULT_BD_BRAIN_TIMEOUT_MS, MAX_BD_BRAIN_TIMEOUT_MS,
  type BdAction, type BdBooking, type BdConversation, type BdStep,
} from '../apps/worker/src/bdBrain.ts';
import { FbBridgeClient, type FbBridgeError } from '../apps/worker/src/fbBridgeClient.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

type Division = 'marketing' | 'ai';
type StepArgs = { conversation: BdConversation; text: string; now: Date };
type StepFn = (args: StepArgs) => BdStep | Promise<BdStep>;

/**
 * The trained-cb DM chatbot end to end, minus the brain: a scripted stand-in
 * answers `/v1/step`, `/v1/book` and `/v1/propose-slots`, and everything
 * around it — the run ledger, the lease, the hand-offs, the outbox and the
 * bridges' ingress — is the real code against a real migrated database.
 */

const send = (text: string, key = 'REPLY'): BdAction => ({
  type: 'send', text, key,
  attach_company_profile: false, attach_opening: false, attach_case_study: false, attach_ads_deck: false,
});

const stepOf = (intent: string, actions: BdAction[], node?: string): StepFn => (args) => ({
  intent,
  conversation: { ...args.conversation },
  actions: node ? [...actions, { type: 'set_node', node, outcome: 'followup' }] : actions,
});

const GREETING = stepOf('greeting', [send('Halo kak, ada yang bisa dibantu?')], 'qna');

function fakeBrain(script: { step?: StepFn; book?: () => Promise<BdBooking>; slots?: () => Promise<string[]> } = {}) {
  const calls = { step: [] as { conversation: BdConversation; text: string; now: Date }[], book: 0, proposeSlots: 0 };
  const brain: ChatbotBrain = {
    step: async (args) => {
      calls.step.push({ conversation: args.conversation, text: args.text, now: args.now });
      return (script.step ?? GREETING)(args);
    },
    book: async () => {
      calls.book += 1;
      if (!script.book) throw new Error('book was not expected');
      return script.book();
    },
    proposeSlots: async (args) => {
      calls.proposeSlots += 1;
      const messages = script.slots ? await script.slots() : [args.fallbackText];
      return { messages, conversation: args.conversation };
    },
  };
  return { brain, calls };
}

const never = () => { throw new Error('this reply must not reach this provider client'); };

describe('the trained-cb chatbot', () => {
  let db: Database;
  let t: TestTenant;
  let ownerId: string;
  let waWeb: string;
  let waWebOff: string;
  let aiWaWeb: string;
  let seq = 0;
  const dispatched: { queue: string; payload: unknown }[] = [];

  const inDivision = <T>(division: Division, fn: (ctx: Ctx) => Promise<T>, tenant: TestTenant = t) =>
    withTenant(db, tenant.tenantId, (tx) =>
      fn({ tx, tenantId: tenant.tenantId, kek: TEST_KEK, divisionId: tenant.divisions[division] }),
    { divisionId: tenant.divisions[division] });

  const deps = (brain: ChatbotBrain | null): ChatbotDeps => ({
    db, kek: TEST_KEK, brain, dispatch: async (job) => { dispatched.push(job); },
  });

  /** One inbound WhatsApp Web message; a new contact unless `phone` names an existing one. */
  const inbound = async (channelId: string, opts: { phone?: string; body?: string; division?: Division } = {}) => {
    seq += 1;
    const division = opts.division ?? 'marketing';
    const phone = opts.phone ?? `08135550${String(seq).padStart(4, '0')}`;
    const r = await inDivision(division, (ctx) => ingestInboundMessage(ctx, {
      channelId, from: phone, body: opts.body ?? 'halo kak', providerMessageId: `wamid.reply.${seq}`, displayName: 'Rina',
    }));
    const job: ChatbotJob = {
      tenantId: t.tenantId, divisionId: t.divisions[division], conversationId: r.conversationId, messageId: r.messageId,
    };
    return { ...r, phone, job };
  };

  const outboundOf = (conversationId: string) => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ id: string; status: string; sender_type: string; template_name: string | null; error: unknown }>(
      `select id, status, sender_type, template_name, error from messages
        where tenant_id = $1 and conversation_id = $2 and direction = 'outbound'
        order by created_at`,
      [t.tenantId, conversationId]));

  const runOf = (messageId: string) => withTenant(db, t.tenantId, async (tx) =>
    (await tx.query<{
      id: string; status: string; skip_reason: string | null; escalation_reason: string | null; attempts: number;
      reply_message_ids: string[]; actions: unknown; booking_attempted_at: Date | null; error: string | null;
    }>(
      `select id, status, skip_reason, escalation_reason, attempts, reply_message_ids, actions,
              booking_attempted_at, error
         from chatbot_runs where tenant_id = $1 and inbound_message_id = $2`,
      [t.tenantId, messageId]))[0]);

  const handlingOf = (conversationId: string) => withTenant(db, t.tenantId, async (tx) =>
    (await tx.query<{ handling: Handling }>(
      'select handling from conversations where tenant_id = $1 and id = $2', [t.tenantId, conversationId]))[0]!.handling);

  const outboxHas = (messageId: string) => withTenant(db, t.tenantId, async (tx) =>
    (await tx.query<{ n: number }>(
      'select count(*)::int as n from message_outbox where tenant_id = $1 and message_id = $2',
      [t.tenantId, messageId]))[0]!.n > 0);

  const sendDeps = (sent: string[] = []) => ({
    db, kek: TEST_KEK,
    meta: { send: never } as never, igBridge: { send: never } as never, fbBridge: { send: never } as never,
    waBridge: { send: async (args: { body: string }) => { sent.push(args.body); return { providerMessageId: `wamid.out.${sent.length}.${seq}` }; } } as never,
    accessTokenFor: never as never,
  });

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'cbreply');
    ownerId = await withTenant(db, t.tenantId, async (tx) =>
      (await tx.query<{ id: string }>('select id from users limit 1'))[0]!.id);
    waWeb = (await inDivision('marketing', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web' }))).channelId;
    waWebOff = (await inDivision('marketing', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web (off)' }))).channelId;
    aiWaWeb = (await inDivision('ai', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web AI' }))).channelId;
    await inDivision('marketing', (ctx) =>
      setChannelChatbotEnabled(ctx, { channelId: waWeb, enabled: true, actorId: ownerId }));
    // AI's account is switched on; AI's division is not, which is how a new tenant starts.
    await inDivision('ai', (ctx) =>
      setChannelChatbotEnabled(ctx, { channelId: aiWaWeb, enabled: true, actorId: ownerId }));
  });

  afterAll(async () => { await db.close(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /* ------------------------------------------------------------ answering */

  it('answers one message with one bot reply, through the outbox', async () => {
    const m = await inbound(waWeb, { body: 'kak mau tanya kerja sama' });
    const { brain, calls } = fakeBrain();

    const outcome = await processChatbotReply(deps(brain), m.job);

    expect(outcome).toMatchObject({ status: 'replied', intent: 'greeting', handling: 'bot' });
    expect(calls.step).toHaveLength(1);
    expect(calls.step[0]!.text).toBe('kak mau tanya kerja sama');
    // The conversation id stands in for the phone number on the wire.
    expect(calls.step[0]!.conversation.jid).toBe(m.conversationId);

    const out = await outboundOf(m.conversationId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sender_type: 'bot', status: 'queued', template_name: null });
    expect(await outboxHas(out[0]!.id)).toBe(true);
    expect(dispatched).toContainEqual({ queue: 'outbound.send', payload: { tenantId: t.tenantId, messageId: out[0]!.id } });

    const run = await runOf(m.messageId);
    expect(run).toMatchObject({ status: 'replied', attempts: 1, reply_message_ids: [out[0]!.id] });
    // The ledger records what the flow did, never what anybody said.
    expect(JSON.stringify(run!.actions)).not.toContain('Halo kak');
    expect(JSON.stringify(run!.actions)).toContain('REPLY');
  });

  it('answers a message delivered twice at once exactly once', async () => {
    const m = await inbound(waWeb);
    const { brain, calls } = fakeBrain();

    const outcomes = await Promise.all([
      processChatbotReply(deps(brain), m.job), processChatbotReply(deps(brain), m.job),
    ]);

    // Which one the loser sees depends on timing: the winner still running
    // (busy — PGlite serialises transactions, so it always is), or already
    // done (a duplicate). Either way the message is answered once.
    const statuses = outcomes.map((o) => (o.status === 'skipped' ? o.reason : o.status)).sort();
    expect([['busy', 'replied'], ['duplicate', 'replied']]).toContainEqual(statuses);
    expect(calls.step).toHaveLength(1);
    expect(await outboundOf(m.conversationId)).toHaveLength(1);
  });

  it('calls a redelivery after the answer a duplicate, without asking the brain again', async () => {
    const m = await inbound(waWeb);
    const { brain, calls } = fakeBrain();
    await processChatbotReply(deps(brain), m.job);

    const again = await processChatbotReply(deps(brain), m.job);

    expect(again).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(calls.step).toHaveLength(1);
    expect(await outboundOf(m.conversationId)).toHaveLength(1);
  });

  it('defers a message while another one on the thread holds the lease', async () => {
    const first = await inbound(waWeb);
    const second = await inbound(waWeb, { phone: first.phone });
    const held = await claimChatbotRun(db, {
      tenantId: t.tenantId, divisionId: t.divisions.marketing,
      conversationId: first.conversationId, inboundMessageId: first.messageId,
    });
    expect(held.outcome).toBe('claimed');
    const { brain, calls } = fakeBrain();

    let deferrals = 0;
    const outcome = await processChatbotReply(deps(brain), second.job, { onBusy: async () => { deferrals += 1; } });
    expect(outcome).toEqual({ status: 'busy' });
    expect(deferrals).toBe(1);
    expect(calls.step).toHaveLength(0);

    // The worker's own onBusy puts the job back and ends it with DelayedError.
    await expect(processChatbotReply(deps(brain), second.job, {
      onBusy: async () => { throw new DelayedError(); },
    })).rejects.toBeInstanceOf(DelayedError);

    await inDivision('marketing', (ctx) => finishChatbotRun(ctx, { runId: held.runId!, status: 'replied' }));
    expect((await processChatbotReply(deps(brain), second.job)).status).toBe('replied');
  });

  it('answers a message that failed before a later one on the same thread', async () => {
    const first = await inbound(waWeb, { body: 'pertama' });
    const second = await inbound(waWeb, { phone: first.phone, body: 'kedua' });
    let down = true;
    const { brain, calls } = fakeBrain({
      step: (args) => {
        if (down) throw new Error('bd-brain step failed: 503');
        return GREETING(args);
      },
    });

    await expect(processChatbotReply(deps(brain), first.job)).rejects.toThrow(/503/);
    down = false;
    // The queue retries the first message later; the second waits for it.
    let deferrals = 0;
    expect(await processChatbotReply(deps(brain), second.job, { onBusy: async () => { deferrals += 1; } }))
      .toEqual({ status: 'busy' });
    expect(deferrals).toBe(1);

    expect((await processChatbotReply(deps(brain), first.job)).status).toBe('replied');
    expect((await processChatbotReply(deps(brain), second.job)).status).toBe('replied');
    expect(calls.step.map((c) => c.text)).toEqual(['pertama', 'pertama', 'kedua']);
  });

  it('finishes handing its replies to the outbound worker when a redelivery finds the run done', async () => {
    const m = await inbound(waWeb);
    const { brain, calls } = fakeBrain();
    const redisDown: ChatbotDeps = {
      ...deps(brain), dispatch: async () => { throw new Error('Connection is closed.'); },
    };

    await expect(processChatbotReply(redisDown, m.job)).rejects.toThrow(/Connection is closed/);
    const [reply] = await outboundOf(m.conversationId);
    expect(reply).toMatchObject({ status: 'queued' });
    expect(await runOf(m.messageId)).toMatchObject({ status: 'replied', reply_message_ids: [reply!.id] });

    const before = dispatched.length;
    expect(await processChatbotReply(deps(brain), m.job)).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(dispatched.slice(before)).toEqual([
      { queue: 'outbound.send', payload: { tenantId: t.tenantId, messageId: reply!.id } },
    ]);
    expect(calls.step).toHaveLength(1);

    // Handed over twice, sent once.
    const sent: string[] = [];
    await Promise.all([
      processOutbound(sendDeps(sent), { tenantId: t.tenantId, messageId: reply!.id }),
      processOutbound(sendDeps(sent), { tenantId: t.tenantId, messageId: reply!.id }),
    ]);
    expect(sent).toEqual(['Halo kak, ada yang bisa dibantu?']);
    const again = dispatched.length;
    await processChatbotReply(deps(brain), m.job);
    expect(dispatched.length).toBe(again);
  });

  it('sweeps a run whose worker died and answers the message', async () => {
    const m = await inbound(waWeb);
    const stalled = await claimChatbotRun(db, {
      tenantId: t.tenantId, divisionId: t.divisions.marketing,
      conversationId: m.conversationId, inboundMessageId: m.messageId,
    });
    await inDivision('marketing', (ctx) => ctx.tx.query(
      `update chatbot_runs set started_at = now() - interval '5 minutes' where tenant_id = $1 and id = $2`,
      [t.tenantId, stalled.runId]));
    const { brain } = fakeBrain();

    const outcome = await processChatbotReply(deps(brain), m.job);

    expect(outcome.status).toBe('replied');
    expect(await runOf(m.messageId)).toMatchObject({ id: stalled.runId, status: 'replied', attempts: 2 });
    expect(await outboundOf(m.conversationId)).toHaveLength(1);
  });

  it('lets only one answer land when a stalled worker comes back after its run was taken over', async () => {
    const m = await inbound(waWeb);
    const { brain: second } = fakeBrain();
    let secondOutcome: unknown;
    const { brain: first } = fakeBrain({
      step: async (args) => {
        // This worker stalls; its lease is swept and the redelivered job answers.
        await withTenant(db, t.tenantId, (tx) => tx.query(
          `update chatbot_runs set started_at = now() - interval '5 minutes' where inbound_message_id = $1`,
          [m.messageId]));
        secondOutcome = await processChatbotReply(deps(second), m.job);
        return GREETING(args);
      },
    });

    await expect(processChatbotReply(deps(first), m.job)).rejects.toBeInstanceOf(LeaseLostError);

    expect(secondOutcome).toMatchObject({ status: 'replied' });
    expect(await outboundOf(m.conversationId)).toHaveLength(1);
    expect(await runOf(m.messageId)).toMatchObject({ status: 'replied', attempts: 2 });
    // The stalled worker's retry finds the message answered.
    expect(await processChatbotReply(deps(first), m.job)).toMatchObject({ status: 'skipped', reason: 'duplicate' });
  });

  /* ------------------------------------------------------- not the bot's */

  it('does not ask the brain when the account or the division has the chatbot off', async () => {
    const { brain, calls } = fakeBrain();

    const offAccount = await inbound(waWebOff);
    expect(await processChatbotReply(deps(brain), offAccount.job)).toMatchObject({ status: 'skipped', reason: 'disabled' });

    const aiDivision = await inbound(aiWaWeb, { division: 'ai' });
    expect(await processChatbotReply(deps(brain), aiDivision.job)).toMatchObject({ status: 'skipped', reason: 'disabled' });

    expect(calls.step).toHaveLength(0);
    expect(await runOf(offAccount.messageId)).toMatchObject({ status: 'skipped', skip_reason: 'disabled' });
    expect(await outboundOf(offAccount.conversationId)).toHaveLength(0);
  });

  it('stays quiet on a conversation a person is handling', async () => {
    const m = await inbound(waWeb);
    await inDivision('marketing', (ctx) => setHandling(ctx, { conversationId: m.conversationId, handling: 'human' }));
    const { brain, calls } = fakeBrain();

    const outcome = await processChatbotReply(deps(brain), m.job);

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'human_active' });
    expect(calls.step).toHaveLength(0);
    expect(await runOf(m.messageId)).toMatchObject({ status: 'skipped', skip_reason: 'human_active' });
  });

  it('answers the first message after a hand-back at once, not held behind the one a person had', async () => {
    const held = await inbound(waWeb);
    await inDivision('marketing', (ctx) =>
      takeoverConversation(ctx, { conversationId: held.conversationId, actorId: ownerId }));
    const { brain, calls } = fakeBrain();
    expect(await chatbotDispatch(deps(brain), { ...held.job, channelId: waWeb })).toBe('skipped_human_active');
    expect(await runOf(held.messageId)).toMatchObject({ status: 'skipped', skip_reason: 'human_active' });

    await inDivision('marketing', (ctx) =>
      resumeBot(ctx, { conversationId: held.conversationId, actorId: ownerId }));
    const next = await inbound(waWeb, { phone: held.phone });
    let deferrals = 0;
    const outcome = await processChatbotReply(deps(brain), next.job, { onBusy: async () => { deferrals += 1; } });

    expect(outcome.status).toBe('replied');
    expect(deferrals).toBe(0);
    expect(calls.step.map((c) => c.text)).toEqual(['halo kak']);
  });

  it('answers the first message after an account is switched on at once', async () => {
    const channelId = (await inDivision('marketing', (ctx) =>
      createWaBridgeChannel(ctx, { displayName: 'WA Web (switched on later)' }))).channelId;
    const before = await inbound(channelId);
    const { brain } = fakeBrain();
    expect(await chatbotDispatch(deps(brain), { ...before.job, channelId })).toBe('skipped_disabled');
    expect(await runOf(before.messageId)).toMatchObject({ status: 'skipped', skip_reason: 'disabled' });

    await inDivision('marketing', (ctx) => setChannelChatbotEnabled(ctx, { channelId, enabled: true, actorId: ownerId }));
    const after = await inbound(channelId, { phone: before.phone });
    let deferrals = 0;
    const outcome = await processChatbotReply(deps(brain), after.job, { onBusy: async () => { deferrals += 1; } });

    expect(outcome.status).toBe('replied');
    expect(deferrals).toBe(0);
  });

  it('lets a takeover that lands while the brain is thinking win', async () => {
    const m = await inbound(waWeb);
    const { brain } = fakeBrain({
      step: async (args) => {
        await inDivision('marketing', (ctx) =>
          takeoverConversation(ctx, { conversationId: m.conversationId, actorId: ownerId }));
        return GREETING(args);
      },
    });

    const outcome = await processChatbotReply(deps(brain), m.job);

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'human_active' });
    expect(await outboundOf(m.conversationId)).toHaveLength(0);
    expect(await handlingOf(m.conversationId)).toBe('human');
    expect(await runOf(m.messageId)).toMatchObject({ status: 'skipped', skip_reason: 'human_active' });
  });

  it('records a run as skipped, and does not throw, when no brain is configured', async () => {
    const m = await inbound(waWeb);

    const outcome = await processChatbotReply(deps(null), m.job);

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'brain_not_configured' });
    expect(await runOf(m.messageId)).toMatchObject({ status: 'skipped', skip_reason: 'brain_not_configured' });
    expect(await handlingOf(m.conversationId)).toBe('bot');
  });

  /* ------------------------------------------------------------ hand-offs */

  describe('a hand-over, and handing back', () => {
    let first: Awaited<ReturnType<typeof inbound>>;

    it('hands the conversation to a person and still sends the closing message', async () => {
      first = await inbound(waWeb);
      const { brain } = fakeBrain({
        step: stepOf('minta_manusia', [send('Baik kak, tim kami akan menghubungi', 'HANDOVER'),
          { type: 'escalate', reason: 'asked for a human', inbound_text: 'mau bicara dengan orang' }], 'handover'),
      });

      const outcome = await processChatbotReply(deps(brain), first.job);

      expect(outcome).toMatchObject({ status: 'handover', handling: 'needs_human' });
      expect(await handlingOf(first.conversationId)).toBe('needs_human');
      expect(await runOf(first.messageId)).toMatchObject({ status: 'handover', escalation_reason: 'asked for a human' });

      // The bot's own closing words are not a takeover to cancel.
      const [closing] = await outboundOf(first.conversationId);
      const sent: string[] = [];
      await processOutbound(sendDeps(sent), { tenantId: t.tenantId, messageId: closing!.id });
      expect(sent).toEqual(['Baik kak, tim kami akan menghubungi']);
    });

    it('does not answer later messages while it waits for a person', async () => {
      const { brain, calls } = fakeBrain();

      // A job that got past the dispatch check is stopped at the run…
      const queued = await inbound(waWeb, { phone: first.phone });
      expect(await processChatbotReply(deps(brain), queued.job)).toMatchObject({ status: 'skipped', reason: 'human_active' });

      // …and a message arriving now is never queued at all.
      const later = await inbound(waWeb, { phone: first.phone });
      expect(await chatbotDispatch(deps(brain), {
        ...later.job, channelId: waWeb,
      })).toBe('skipped_human_active');
      expect(await runOf(later.messageId)).toMatchObject({ status: 'skipped', skip_reason: 'human_active' });
      expect(calls.step).toHaveLength(0);
    });

    it('answers again once a person hands it back, from Q&A', async () => {
      expect(await inDivision('marketing', (ctx) =>
        resumeBot(ctx, { conversationId: first.conversationId, actorId: ownerId }))).toBe('resumed');
      const next = await inbound(waWeb, { phone: first.phone });
      const { brain, calls } = fakeBrain();

      const outcome = await processChatbotReply(deps(brain), next.job);

      expect(outcome.status).toBe('replied');
      expect(calls.step[0]!.conversation.node).toBe('qna');
      expect(await handlingOf(first.conversationId)).toBe('bot');
    });
  });

  it('keeps an opted-out contact with a person on their next conversation', async () => {
    const m = await inbound(waWeb, { body: 'stop' });
    await processChatbotReply(deps(fakeBrain({
      step: stepOf('opt_out', [send('Baik kak', 'REPLY_OPT_OUT')], 'stopped'),
    }).brain), m.job);
    // An agent tidies the inbox; weeks later the contact writes again.
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `update conversations set status = 'resolved' where tenant_id = $1 and id = $2`, [t.tenantId, m.conversationId]));
    const later = await inbound(waWeb, { phone: m.phone, body: 'halo' });
    expect(later.conversationId).not.toBe(m.conversationId);
    const { brain, calls } = fakeBrain();

    expect(await chatbotDispatch(deps(brain), { ...later.job, channelId: waWeb })).toBe('skipped_human_active');
    expect(await handlingOf(later.conversationId)).toBe('human');

    // A job that got past the dispatch check is stopped at the run.
    await inDivision('marketing', (ctx) => setHandling(ctx, { conversationId: later.conversationId, handling: 'bot' }));
    const again = await inbound(waWeb, { phone: m.phone, body: 'halo lagi' });
    expect(again.conversationId).toBe(later.conversationId);
    expect(await processChatbotReply(deps(brain), again.job)).toMatchObject({ status: 'skipped', reason: 'human_active' });
    expect(await handlingOf(later.conversationId)).toBe('human');

    expect(calls.step).toHaveLength(0);
    expect(await outboundOf(later.conversationId)).toHaveLength(0);
    expect(await inDivision('marketing', (ctx) =>
      resumeBot(ctx, { conversationId: later.conversationId, actorId: ownerId }))).toBe('opt_out');
  });

  it('honours an opt-out permanently, and still says goodbye', async () => {
    const m = await inbound(waWeb, { body: 'stop, jangan hubungi lagi' });
    const { brain } = fakeBrain({ step: stepOf('opt_out', [send('Baik kak, tidak akan kami hubungi lagi', 'REPLY_OPT_OUT')], 'stopped') });

    const outcome = await processChatbotReply(deps(brain), m.job);

    expect(outcome).toMatchObject({ status: 'handover', handling: 'human' });
    expect(await handlingOf(m.conversationId)).toBe('human');
    const state = await withTenant(db, t.tenantId, async (tx) =>
      (await tx.query<{ node: string; stopped_reason: string }>(
        'select node, stopped_reason from bd_conversation_state where tenant_id = $1 and conversation_id = $2',
        [t.tenantId, m.conversationId]))[0]);
    expect(state).toEqual({ node: 'stopped', stopped_reason: 'opt_out' });
    expect(await inDivision('marketing', (ctx) =>
      resumeBot(ctx, { conversationId: m.conversationId, actorId: ownerId }))).toBe('opt_out');

    const [goodbye] = await outboundOf(m.conversationId);
    const sent: string[] = [];
    await processOutbound(sendDeps(sent), { tenantId: t.tenantId, messageId: goodbye!.id });
    expect(sent).toHaveLength(1);
  });

  /* -------------------------------------------------------------- booking */

  describe('booking a meeting', () => {
    const BOOK: StepFn = stepOf('isi_email', [{ type: 'book_meeting', preferred: '' }]);

    it('books once and puts the meeting where the team looks', async () => {
      const m = await inbound(waWeb, { body: 'email saya rina@brand.id, jam 14 ya' });
      const meetingAt = '2026-10-01T07:00:00.000Z';
      const { brain, calls } = fakeBrain({
        step: BOOK,
        book: async () => ({
          booked: true, meeting_at: meetingAt, meet_link: 'https://meet.google.com/abc-defg-hij',
          event_id: 'evt-1', html_link: 'https://calendar.google.com/evt-1',
          messages: ['Sudah saya jadwalkan ya kak'], conversation: { jid: m.conversationId },
        }),
      });

      const outcome = await processChatbotReply(deps(brain), m.job);

      expect(outcome).toMatchObject({ status: 'replied', handling: 'bot' });
      expect(calls.book).toBe(1);
      expect(await outboundOf(m.conversationId)).toHaveLength(1);
      const task = await withTenant(db, t.tenantId, async (tx) =>
        (await tx.query<{ kind: string; meeting_link: string; calendar_event_id: string }>(
          'select kind, meeting_link, calendar_event_id from tasks where tenant_id = $1 and conversation_id = $2',
          [t.tenantId, m.conversationId]))[0]);
      expect(task).toMatchObject({ kind: 'meeting', meeting_link: 'https://meet.google.com/abc-defg-hij', calendar_event_id: 'evt-1' });
      expect((await runOf(m.messageId))!.booking_attempted_at).not.toBeNull();
    });

    it('hands over instead of booking again when an earlier attempt already reached the calendar', async () => {
      const m = await inbound(waWeb);
      const crashed = await claimChatbotRun(db, {
        tenantId: t.tenantId, divisionId: t.divisions.marketing,
        conversationId: m.conversationId, inboundMessageId: m.messageId,
      });
      await inDivision('marketing', (ctx) => markBookingAttempted(ctx, crashed.runId!));
      await inDivision('marketing', (ctx) =>
        finishChatbotRun(ctx, { runId: crashed.runId!, status: 'failed', error: 'worker died mid-booking' }));
      const { brain, calls } = fakeBrain({
        step: stepOf('isi_email', [{ type: 'book_meeting', preferred: '' },
          { type: 'propose_slots', fallback_text: 'Jadwalnya sedang saya siapkan ya kak', fallback_key: 'REPLY_SETUJU' }]),
      });

      const outcome = await processChatbotReply(deps(brain), m.job);

      expect(calls.book).toBe(0);
      expect(calls.proposeSlots).toBe(0);
      expect(outcome).toMatchObject({ status: 'handover', handling: 'needs_human' });
      expect(await runOf(m.messageId)).toMatchObject({ status: 'handover', escalation_reason: 'verify_booking', attempts: 2 });
      expect((await outboundOf(m.conversationId)).map((o) => o.sender_type)).toEqual(['bot']);
    });

    it('records a meeting booked while a person was taking over, and says nothing', async () => {
      const m = await inbound(waWeb);
      const { brain, calls } = fakeBrain({
        step: BOOK,
        book: async () => {
          await inDivision('marketing', (ctx) =>
            takeoverConversation(ctx, { conversationId: m.conversationId, actorId: ownerId }));
          return {
            booked: true, meeting_at: '2026-10-02T07:00:00.000Z', meet_link: 'https://meet.google.com/tko-over-now',
            event_id: 'evt-takeover', html_link: 'https://calendar.google.com/evt-takeover',
            messages: ['Sudah saya jadwalkan ya kak'], conversation: { jid: m.conversationId },
          };
        },
      });

      const outcome = await processChatbotReply(deps(brain), m.job);

      expect(outcome).toMatchObject({ status: 'skipped', reason: 'human_active' });
      expect(calls.book).toBe(1);
      expect(await outboundOf(m.conversationId)).toHaveLength(0);
      expect(await handlingOf(m.conversationId)).toBe('human');
      expect(await runOf(m.messageId)).toMatchObject({
        status: 'skipped', skip_reason: 'human_active', escalation_reason: 'booked_during_takeover',
      });
      const recorded = await withTenant(db, t.tenantId, async (tx) => ({
        task: (await tx.query<{ meeting_link: string; calendar_event_id: string }>(
          'select meeting_link, calendar_event_id from tasks where tenant_id = $1 and conversation_id = $2',
          [t.tenantId, m.conversationId]))[0],
        state: (await tx.query<{ meet_link: string; meeting_at: Date }>(
          'select meet_link, meeting_at from bd_conversation_state where tenant_id = $1 and conversation_id = $2',
          [t.tenantId, m.conversationId]))[0],
      }));
      expect(recorded.task).toEqual({ meeting_link: 'https://meet.google.com/tko-over-now', calendar_event_id: 'evt-takeover' });
      expect(recorded.state?.meet_link).toBe('https://meet.google.com/tko-over-now');
      expect(new Date(recorded.state!.meeting_at).toISOString()).toBe('2026-10-02T07:00:00.000Z');
    });

    it('names an unsure booking on the run when a person took over during it', async () => {
      const m = await inbound(waWeb);
      const { brain } = fakeBrain({
        step: BOOK,
        book: async () => {
          await inDivision('marketing', (ctx) =>
            takeoverConversation(ctx, { conversationId: m.conversationId, actorId: ownerId }));
          throw new Error('bd-brain book failed: timeout');
        },
      });

      expect(await processChatbotReply(deps(brain), m.job)).toMatchObject({ status: 'skipped', reason: 'human_active' });
      expect(await runOf(m.messageId)).toMatchObject({ status: 'skipped', escalation_reason: 'verify_booking' });
      expect(await handlingOf(m.conversationId)).toBe('human');
    });

    it('retries a run that lost its lease mid-booking, and hands the booking to a person', async () => {
      const m = await inbound(waWeb);
      const { brain, calls } = fakeBrain({
        step: BOOK,
        book: async () => {
          // Swept as stalled while the calendar was answering.
          await withTenant(db, t.tenantId, (tx) => tx.query(
            `update chatbot_runs set status = 'failed', error = 'stalled', finished_at = now()
              where inbound_message_id = $1`, [m.messageId]));
          return {
            booked: true, meeting_at: '2026-10-03T07:00:00.000Z', meet_link: 'https://meet.google.com/lst-leas-eee',
            event_id: 'evt-lost', html_link: null, messages: ['Sudah saya jadwalkan ya kak'],
            conversation: { jid: m.conversationId },
          };
        },
      });

      await expect(processChatbotReply(deps(brain), m.job)).rejects.toBeInstanceOf(LeaseLostError);
      expect(await outboundOf(m.conversationId)).toHaveLength(0);
      expect(await runOf(m.messageId)).toMatchObject({ status: 'failed', error: 'stalled' });

      const retried = await processChatbotReply(deps(brain), m.job);

      expect(calls.book).toBe(1);
      expect(retried).toMatchObject({ status: 'handover', handling: 'needs_human' });
      expect(await runOf(m.messageId)).toMatchObject({ status: 'handover', escalation_reason: 'verify_booking', attempts: 2 });
    });

    it('never calls the booking endpoint twice for one message', async () => {
      const m = await inbound(waWeb);
      const { brain, calls } = fakeBrain({
        step: BOOK,
        book: async () => { throw new Error('bd-brain book failed: timeout'); },
      });

      const outcome = await processChatbotReply(deps(brain), m.job);
      expect(outcome).toMatchObject({ status: 'handover', handling: 'needs_human' });
      expect(await runOf(m.messageId)).toMatchObject({ escalation_reason: 'verify_booking' });

      await inDivision('marketing', (ctx) =>
        resumeBot(ctx, { conversationId: m.conversationId, actorId: ownerId }));
      expect((await processChatbotReply(deps(brain), m.job)).status).toBe('skipped');
      expect(calls.book).toBe(1);
    });
  });

  /* ------------------------------------------------------------- failures */

  describe('the brain over HTTP', () => {
    it('sends "now" as Jakarta time and stops retrying on a 400', async () => {
      const bodies: { now: string }[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as { now: string });
        return new Response('bad payload', { status: 400 });
      }));
      const m = await inbound(waWeb);
      const client = new BdBrainClient('http://brain.test', 's3cret', 1_000);

      await expect(processChatbotReply(deps(client), { ...m.job, now: new Date('2026-09-25T03:00:00.000Z') }))
        .rejects.toBeInstanceOf(UnrecoverableError);

      expect(bodies[0]!.now).toBe('2026-09-25T10:00:00.000+07:00');
      expect(await runOf(m.messageId)).toMatchObject({ status: 'failed' });
      expect((await runOf(m.messageId))!.error).toContain('400');

      // The queue's final failure hands the conversation to a person.
      await markChatbotExhausted(db, m.job, 'bd-brain step failed: 400');
      expect(await handlingOf(m.conversationId)).toBe('needs_human');
      expect(await runOf(m.messageId)).toMatchObject({ status: 'failed', skip_reason: 'exhausted' });
    });

    it('holds BD_BRAIN_TIMEOUT_MS under the thread\'s lease', () => {
      const timeoutFor = (value?: string) =>
        bdBrainFromEnv({ BD_BRAIN_URL: 'http://brain.test', BD_BRAIN_TIMEOUT_MS: value })!.timeoutMs;
      expect(timeoutFor('600000')).toBe(MAX_BD_BRAIN_TIMEOUT_MS);
      expect(timeoutFor('5000')).toBe(5_000);
      expect(timeoutFor(undefined)).toBe(DEFAULT_BD_BRAIN_TIMEOUT_MS);
      expect(timeoutFor('soon')).toBe(DEFAULT_BD_BRAIN_TIMEOUT_MS);
      expect(bdBrainFromEnv({})).toBeNull();
    });

    it('leaves a 5xx to the queue\'s retries', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
      const client = new BdBrainClient('http://brain.test', 's3cret', 1_000);

      const err = await client.step({ conversation: { jid: 'x' }, text: 'halo', now: new Date() }).catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
    });
  });

  it('does not hand over a conversation whose message was already answered', async () => {
    const m = await inbound(waWeb);
    await processChatbotReply(deps(fakeBrain().brain), m.job);

    await markChatbotExhausted(db, m.job, 'late failure');

    expect(await handlingOf(m.conversationId)).toBe('bot');
  });

  describe('the worker\'s queues', () => {
    const failedJob = (data: unknown, attemptsMade: number) => ({ data, attemptsMade, opts: { attempts: 8 } });

    it('puts a busy job back for a few seconds without spending an attempt', async () => {
      const moves: { at: number; token: string | undefined }[] = [];
      const job = { moveToDelayed: async (at: number, token?: string) => { moves.push({ at, token }); } };
      const before = Date.now();

      await expect(deferWhileBusy(job, 'lock-token')()).rejects.toBeInstanceOf(DelayedError);

      expect(moves).toHaveLength(1);
      expect(moves[0]!.token).toBe('lock-token');
      expect(moves[0]!.at).toBeGreaterThanOrEqual(before + CHATBOT_BUSY_DELAY_MS);
      expect(moves[0]!.at).toBeLessThanOrEqual(Date.now() + CHATBOT_BUSY_DELAY_MS);
    });

    it('hands the conversation over on the last attempt only', async () => {
      const m = await inbound(waWeb);
      const err = new Error('bd-brain step failed: 503');

      expect(await handOverFailedChatbotJob(db, CHATBOT_REPLY_QUEUE, failedJob(m.job, 3), err)).toBe(false);
      expect(await handlingOf(m.conversationId)).toBe('bot');
      expect(await handOverFailedChatbotJob(db, 'outbound.send', failedJob(m.job, 8), err)).toBe(false);
      expect(await handlingOf(m.conversationId)).toBe('bot');

      expect(await handOverFailedChatbotJob(db, CHATBOT_REPLY_QUEUE, failedJob(m.job, 8), err)).toBe(true);
      expect(await handlingOf(m.conversationId)).toBe('needs_human');

      const unrecoverable = await inbound(waWeb);
      expect(await handOverFailedChatbotJob(
        db, CHATBOT_REPLY_QUEUE, failedJob(unrecoverable.job, 1), new UnrecoverableError('bd-brain step failed: 401'),
      )).toBe(true);
      expect(await handlingOf(unrecoverable.conversationId)).toBe('needs_human');
    });

    it('hands over a conversation whose old bd.draft job failed for good', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('wrong secret', { status: 401 })));
      const m = await inbound(waWeb);
      const legacy = { tenantId: t.tenantId, conversationId: m.conversationId, text: 'halo' };
      const client = new BdBrainClient('http://brain.test', 'wrong', 1_000);

      const err = await processLegacyBdDraft(deps(client), legacy).catch((e: Error) => e);
      expect(err).toBeInstanceOf(UnrecoverableError);

      expect(await handOverFailedChatbotJob(db, LEGACY_BD_DRAFT_QUEUE, failedJob(legacy, 1), err as Error)).toBe(true);
      expect(await handlingOf(m.conversationId)).toBe('needs_human');
      expect(await runOf(m.messageId)).toMatchObject({ status: 'failed', skip_reason: 'exhausted' });
    });
  });

  it('drains an old bd.draft job through the new processor, once', async () => {
    const m = await inbound(waWeb);
    const { brain, calls } = fakeBrain();

    const first = await processLegacyBdDraft(deps(brain), { tenantId: t.tenantId, conversationId: m.conversationId, text: 'halo' });
    const again = await processLegacyBdDraft(deps(brain), { tenantId: t.tenantId, conversationId: m.conversationId, text: 'halo' });

    expect(first.status).toBe('replied');
    expect(again).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(calls.step).toHaveLength(1);
    expect(await runOf(m.messageId)).toMatchObject({ status: 'replied' });
  });

  /* ------------------------------------------------------------ outbound */

  it('cancels a queued bot reply once a person has the conversation, and nothing else', async () => {
    const m = await inbound(waWeb);
    await processChatbotReply(deps(fakeBrain().brain), m.job);
    const [bot] = await outboundOf(m.conversationId);
    const others = await inDivision('marketing', async (ctx) => [
      await queueOutboundMessage(ctx, { conversationId: m.conversationId, body: 'dari agen', senderType: 'agent', senderId: ownerId }),
      await queueOutboundMessage(ctx, { conversationId: m.conversationId, body: 'dari autopilot', senderType: 'autopilot' }),
    ]);
    // Straight to `human`, not through the takeover that would have cancelled it already.
    await inDivision('marketing', (ctx) => setHandling(ctx, { conversationId: m.conversationId, handling: 'human' }));

    const sent: string[] = [];
    for (const id of [bot!.id, ...others.map((o) => o.messageId)]) {
      await processOutbound(sendDeps(sent), { tenantId: t.tenantId, messageId: id });
    }

    expect(sent).toEqual(['dari agen', 'dari autopilot']);
    const after = await outboundOf(m.conversationId);
    expect(after[0]).toMatchObject({ id: bot!.id, status: 'failed' });
    expect(JSON.stringify(after[0]!.error)).toContain('bot_cancelled_by_takeover');
    expect(await outboxHas(bot!.id)).toBe(false);
    expect(after.slice(1).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('keeps Autopilot off a bridge conversation whether or not the chatbot is on', async () => {
    const m = await inbound(waWebOff);
    const model = { draft: async () => { throw new Error('Autopilot must never draft for a bridge DM'); } };

    const outcome = await processAutopilotDraft(
      { db, kek: TEST_KEK, model, dispatch: async () => {} },
      { tenantId: t.tenantId, conversationId: m.conversationId, messageId: m.messageId },
    );

    expect(outcome.status).toBe('skipped');
    const drafts = await withTenant(db, t.tenantId, async (tx) =>
      (await tx.query<{ n: number }>(
        'select count(*)::int as n from message_drafts where tenant_id = $1 and conversation_id = $2',
        [t.tenantId, m.conversationId]))[0]!.n);
    expect(drafts).toBe(0);
  });
});

/* ------------------------------------------------------------- ingress */

describe('which inbound DMs reach the chatbot', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let e: Env;
  let ownerId: string;
  let waWeb: string;
  let waWebOff: string;
  let aiWaWeb: string;
  let igChannel: string;
  let fbChannel: string;
  let seq = 0;
  const jobs: { queue: string; payload: unknown }[] = [];

  const inDivision = <T>(division: Division, fn: (ctx: Ctx) => Promise<T>) =>
    withTenant(db, t.tenantId, (tx) =>
      fn({ tx, tenantId: t.tenantId, kek: TEST_KEK, divisionId: t.divisions[division] }),
    { divisionId: t.divisions[division] });

  const post = (url: string, body: unknown, secret: string) => app.inject({
    method: 'POST', url,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  /** Posts one event and returns the jobs it dispatched past `inbound.normalise`. */
  const deliver = async (url: string, body: unknown, secret: string) => {
    const before = jobs.length;
    expect((await post(url, body, secret)).statusCode).toBe(200);
    return jobs.slice(before);
  };

  const waEvent = (channelId: string, over: Record<string, unknown> = {}) => {
    seq += 1;
    return {
      channelId, event: 'message', at: new Date().toISOString(),
      message: {
        id: `wamid.ingress.${seq}`, from: `08135560${String(seq).padStart(4, '0')}@c.us`, to: '6281100000000@c.us',
        body: 'halo kak', type: 'chat', timestampSec: Math.floor(Date.now() / 1000), fromMe: false,
        displayName: 'Rina', ...over,
      },
    };
  };

  const fbEvent = (message: Record<string, unknown> = {}) => {
    seq += 1;
    return {
      event: 'message', tenantId: t.tenantId, at: new Date().toISOString(),
      message: {
        threadId: '100000000000777', externalMessageId: `mid.$ingress${seq}`, senderId: '100000000000777',
        senderName: 'Budi', text: 'halo, masih ready?', sentAt: null, direction: 'inbound', seq, ...message,
      },
    };
  };

  const chatbotJobs = (list: { queue: string }[]) => list.filter((j) => j.queue === CHATBOT_REPLY_QUEUE);

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'cbingress');
    e = env();
    ownerId = await withTenant(db, t.tenantId, async (tx) =>
      (await tx.query<{ id: string }>('select id from users limit 1'))[0]!.id);

    app = buildApp({
      db, control: db, kek: TEST_KEK, env: e,
      dispatch: async ({ queue, payload }) => {
        if (queue !== 'inbound.normalise') return;
        await processInboundWebhook(
          { db, control: db, kek: TEST_KEK, dispatch: async (job) => { jobs.push(job); } },
          (payload as { webhookEventId: string }).webhookEventId,
        );
      },
    });
    await app.ready();

    waWeb = (await inDivision('marketing', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web' }))).channelId;
    waWebOff = (await inDivision('marketing', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web off' }))).channelId;
    aiWaWeb = (await inDivision('ai', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web AI' }))).channelId;
    igChannel = (await inDivision('marketing', (ctx) => ensureInstagramBridgeChannel(ctx, { username: 'toko.cb' }))).channelId;
    fbChannel = (await inDivision('marketing', (ctx) =>
      ensureMessengerBridgeChannel(ctx, { pageId: '900000000000777', pageName: 'Toko CB', status: 'connected' }))).channelId;
    for (const [division, channelId] of [['marketing', waWeb], ['marketing', igChannel], ['ai', aiWaWeb]] as const) {
      await inDivision(division, (ctx) => setChannelChatbotEnabled(ctx, { channelId, enabled: true, actorId: ownerId }));
    }
  });

  afterAll(async () => { await app.close(); await db.close(); });

  it('queues one chatbot job for a WhatsApp Web message, and no Autopilot draft', async () => {
    const event = waEvent(waWeb);
    const queued = await deliver('/v1/webhooks/wa-bridge', event, e.WA_BRIDGE_SECRET);

    expect(queued.map((j) => j.queue)).toEqual([CHATBOT_REPLY_QUEUE]);
    const payload = queued[0]!.payload as ChatbotJob;
    expect(payload).toMatchObject({ tenantId: t.tenantId, divisionId: t.divisions.marketing });
    const message = await inDivision('marketing', async (ctx) =>
      (await ctx.tx.query<{ conversation_id: string }>(
        'select conversation_id from messages where tenant_id = $1 and id = $2', [t.tenantId, payload.messageId]))[0]);
    expect(message?.conversation_id).toBe(payload.conversationId);

    // A redelivery is stopped at the spool and queues nothing.
    expect(await deliver('/v1/webhooks/wa-bridge', event, e.WA_BRIDGE_SECRET)).toEqual([]);
  });

  it('queues nothing for an account with the chatbot off, the phone\'s own reply, or a human-held thread', async () => {
    expect(await deliver('/v1/webhooks/wa-bridge', waEvent(waWebOff), e.WA_BRIDGE_SECRET)).toEqual([]);
    expect(await deliver('/v1/webhooks/wa-bridge', waEvent(waWeb, { fromMe: true }), e.WA_BRIDGE_SECRET)).toEqual([]);

    const first = waEvent(waWeb);
    const queued = await deliver('/v1/webhooks/wa-bridge', first, e.WA_BRIDGE_SECRET);
    const { conversationId } = queued[0]!.payload as ChatbotJob;
    await inDivision('marketing', (ctx) => setHandling(ctx, { conversationId, handling: 'human' }));
    const followUp = waEvent(waWeb, { from: first.message.from });
    expect(chatbotJobs(await deliver('/v1/webhooks/wa-bridge', followUp, e.WA_BRIDGE_SECRET))).toEqual([]);
  });

  it('queues nothing in the AI division, which starts with the chatbot off', async () => {
    expect(await deliver('/v1/webhooks/wa-bridge', waEvent(aiWaWeb), e.WA_BRIDGE_SECRET)).toEqual([]);
  });

  it('queues a chatbot job for an inbound Instagram DM, never for our own reply', async () => {
    const message = (index: number, direction: 'inbound' | 'outbound') => ({
      tenantId: t.tenantId, event: 'message',
      message: {
        threadId: '340282366841710300949999', participantUsername: 'rina.cb',
        senderUsername: direction === 'inbound' ? 'rina.cb' : 'toko.cb', text: `pesan ${index}`, direction, index,
      },
    });

    const inbound = await deliver('/v1/webhooks/ig-bridge', message(0, 'inbound'), e.IG_BRIDGE_SECRET);
    expect(inbound.map((j) => j.queue)).toEqual([CHATBOT_REPLY_QUEUE]);
    expect(inbound[0]!.payload).toMatchObject({ tenantId: t.tenantId, divisionId: t.divisions.marketing });

    expect(await deliver('/v1/webhooks/ig-bridge', message(1, 'outbound'), e.IG_BRIDGE_SECRET)).toEqual([]);
  });

  it('answers Messenger only once the Page\'s channel is switched on', async () => {
    expect(await deliver('/v1/webhooks/fb-bridge', fbEvent(), e.FB_BRIDGE_SECRET)).toEqual([]);

    await inDivision('marketing', (ctx) =>
      setChannelChatbotEnabled(ctx, { channelId: fbChannel, enabled: true, actorId: ownerId }));
    const queued = await deliver('/v1/webhooks/fb-bridge', fbEvent(), e.FB_BRIDGE_SECRET);
    expect(queued.map((j) => j.queue)).toEqual([CHATBOT_REPLY_QUEUE]);
    expect(queued[0]!.payload).toMatchObject({ tenantId: t.tenantId, divisionId: t.divisions.marketing });

    expect(await deliver('/v1/webhooks/fb-bridge', fbEvent({ direction: 'outbound' }), e.FB_BRIDGE_SECRET)).toEqual([]);
  });
});

/* ------------------------------------------------------------ Messenger */

describe('a bot reply on Messenger', () => {
  let db: Database;
  let t: TestTenant;
  let ownerId: string;
  let conversationId: string;
  let messageId: string;

  const inAi = <T>(fn: (ctx: Ctx) => Promise<T>) =>
    withTenant(db, t.tenantId, (tx) =>
      fn({ tx, tenantId: t.tenantId, kek: TEST_KEK, divisionId: t.divisions.ai }), { divisionId: t.divisions.ai });

  const statusOf = (id: string) => withTenant(db, t.tenantId, async (tx) =>
    (await tx.query<{ status: string; error: unknown }>(
      'select status, error from messages where tenant_id = $1 and id = $2', [t.tenantId, id]))[0]!);

  const fbDeps = (fbBridge: unknown) => ({
    db, kek: TEST_KEK,
    meta: { send: never } as never, waBridge: { send: never } as never, igBridge: { send: never } as never,
    fbBridge: fbBridge as never, accessTokenFor: never as never,
  });

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'cbmessenger');
    ownerId = await withTenant(db, t.tenantId, async (tx) =>
      (await tx.query<{ id: string }>('select id from users limit 1'))[0]!.id);
    // The AI division's own Page, with the chatbot switched on for both.
    await inAi((ctx) => setChatbotEnabled(ctx, { enabled: true, actorId: ownerId }));
    const { channelId } = await inAi((ctx) =>
      ensureMessengerBridgeChannel(ctx, { pageId: '900000000000888', pageName: 'Toko AI', status: 'connected' }));
    await inAi((ctx) => setChannelChatbotEnabled(ctx, { channelId, enabled: true, actorId: ownerId }));
    ({ conversationId, messageId } = await inAi((ctx) => ingestInboundMessengerMessage(ctx, {
      channelId, fbUserId: '100000000000888', threadId: '100000000000888', body: 'halo kak',
      providerMessageId: 'fb_dm:test:1', displayName: 'Budi',
    })));
  });

  afterAll(async () => { await db.close(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reaches the bridge through the AI division\'s own Page session', async () => {
    const outcome = await processChatbotReply(
      { db, kek: TEST_KEK, brain: fakeBrain().brain, dispatch: async () => {} },
      { tenantId: t.tenantId, divisionId: t.divisions.ai, conversationId, messageId },
    );
    expect(outcome.status).toBe('replied');
    const replyId = outcome.status === 'replied' ? outcome.messageIds[0]! : '';

    const sent: { sessionKey: string; threadId: string; body: string }[] = [];
    await processOutbound(fbDeps({
      send: async (args: { sessionKey: string; threadId: string; body: string }) => { sent.push(args); },
    }), { tenantId: t.tenantId, messageId: replyId });

    expect(sent).toEqual([{
      sessionKey: `${t.tenantId}-ai`, threadId: '100000000000888', body: 'Halo kak, ada yang bisa dibantu?',
    }]);
    expect((await statusOf(replyId)).status).toBe('sent');
  });

  it('fails an unconfirmed send instead of typing it again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'typed, not seen', code: 'send_not_confirmed' }), { status: 502 })));
    const queued = await inAi((ctx) => queueOutboundMessage(ctx, { conversationId, body: 'halo lagi', senderType: 'bot' }));

    const result = await processOutbound(fbDeps(new FbBridgeClient('http://fb.test', 'secret')),
      { tenantId: t.tenantId, messageId: queued.messageId });

    expect(result.status).toBe('failed');
    const row = await statusOf(queued.messageId);
    expect(row.status).toBe('failed');
    expect(JSON.stringify(row.error)).toContain('unconfirmed');
  });

  /* A reconcile reads the Page's own side of the thread back: whitespace
   * collapsed, the emoji gone, and now carrying Facebook's message id. */
  const pageHistory = (externalMessageId: string, text: string) => processFbBridgeEvent(
    { db, control: db, kek: TEST_KEK, dispatch: async () => { throw new Error('history must not dispatch'); } },
    {
      tenantId: t.tenantId, sessionKey: `${t.tenantId}-ai`, event: 'message',
      message: {
        threadId: '100000000000888', externalMessageId, senderId: '100000000000888', senderName: 'Toko AI',
        text, sentAt: null, direction: 'outbound', seq: 1,
      },
    },
    async (reason) => { throw new Error(reason); },
  );

  const outboundNow = () => withTenant(db, t.tenantId, async (tx) => {
    const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
    const rows = await tx.query<{
      id: string; sender_type: string; status: string; provider_message_id: string | null; body_enc: string; error: unknown;
    }>(
      `select id, sender_type, status, provider_message_id, body_enc, error from messages
        where tenant_id = $1 and conversation_id = $2 and direction = 'outbound' order by created_at, id`,
      [t.tenantId, conversationId]);
    return rows.map(({ body_enc, ...r }) => ({ ...r, body: openField(keys, t.tenantId, body_enc) }));
  });

  it('takes the Page\'s own copy of a bot reply as that reply, not as a second one', async () => {
    const sent = 'Halo, Kak 😊\nSaya Grace dari MCNAsia.biz — boleh dibantu isi datanya?';
    const queued = await inAi((ctx) => queueOutboundMessage(ctx, { conversationId, body: sent, senderType: 'bot' }));
    await processOutbound(fbDeps({ send: async () => {} }), { tenantId: t.tenantId, messageId: queued.messageId });
    const before = (await outboundNow()).length;

    await pageHistory('mid.$echo0001', 'Halo, Kak Saya Grace dari MCNAsia.biz — boleh dibantu isi datanya?');
    await pageHistory('mid.$echo0001', 'Halo, Kak Saya Grace dari MCNAsia.biz — boleh dibantu isi datanya?');

    const after = await outboundNow();
    expect(after).toHaveLength(before);
    expect(after.find((r) => r.id === queued.messageId)).toMatchObject({
      sender_type: 'bot', status: 'sent', provider_message_id: `fb_dm:${t.tenantId}-ai:mid.$echo0001`,
    });

    // Something the Page said from Facebook itself is still history to import.
    await pageHistory('mid.$echo0002', 'Sudah kami balas lewat Facebook langsung ya kak');
    const imported = (await outboundNow()).filter((r) => r.body === 'Sudah kami balas lewat Facebook langsung ya kak');
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ sender_type: 'agent', status: 'sent' });
  });

  it('marks a reply the bridge could not confirm as sent once the Page\'s history shows it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'typed, not seen', code: 'send_not_confirmed' }), { status: 502 })));
    const queued = await inAi((ctx) =>
      queueOutboundMessage(ctx, { conversationId, body: 'Baik kak, jadwalnya kami cek dulu ya', senderType: 'bot' }));
    await processOutbound(fbDeps(new FbBridgeClient('http://fb.test', 'secret')), { tenantId: t.tenantId, messageId: queued.messageId });
    expect((await statusOf(queued.messageId)).status).toBe('failed');
    const before = (await outboundNow()).length;

    await pageHistory('mid.$echo0003', 'Baik kak, jadwalnya kami cek dulu ya');

    expect(await outboundNow()).toHaveLength(before);
    expect(await statusOf(queued.messageId)).toMatchObject({ status: 'sent', error: null });
  });

  it('never takes a reply a takeover cancelled for one the Page sent', async () => {
    const words = 'Tim kami akan menghubungi Kakak sebentar lagi';
    const queued = await inAi((ctx) => queueOutboundMessage(ctx, { conversationId, body: words, senderType: 'bot' }));
    await inAi((ctx) => takeoverConversation(ctx, { conversationId, actorId: ownerId }));
    const before = (await outboundNow()).length;

    // The same words did appear on the Page — typed there by a person.
    await pageHistory('mid.$echo0004', words);

    expect(await statusOf(queued.messageId)).toMatchObject({ status: 'failed' });
    const rows = (await outboundNow()).filter((r) => r.body === words);
    expect(await outboundNow()).toHaveLength(before + 1);
    expect(rows.find((r) => r.id !== queued.messageId)).toMatchObject({
      sender_type: 'agent', provider_message_id: `fb_dm:${t.tenantId}-ai:mid.$echo0004`,
    });
    await inAi((ctx) => resumeBot(ctx, { conversationId, actorId: ownerId }));
  });

  it('keeps every other bridge answer as it was', async () => {
    const client = new FbBridgeClient('http://fb.test', 'secret');
    const answer = (status: number, body: unknown) =>
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
    const target = { sessionKey: 's', threadId: '1', body: 'x' };

    answer(502, { error: 'bridge hiccup' });
    expect(await client.send(target).catch((err: FbBridgeError) => err)).toMatchObject({ permanent: false, status: 502 });

    // Given up on before anything was typed: nothing reached Facebook, so a
    // retry cannot send it twice.
    answer(503, { error: 'not typed', code: 'send_not_attempted' });
    expect(await client.send(target).catch((err: FbBridgeError) => err)).toMatchObject({ permanent: false, status: 503 });

    answer(409, { error: 'message request', code: 'thread_requires_acceptance' });
    expect(await client.send(target).catch((err: FbBridgeError) => err)).toMatchObject({ permanent: true, status: 409 });

    // The comment private reply decides for itself what an unconfirmed send means.
    answer(502, { error: 'typed, not seen', code: 'send_not_confirmed' });
    expect(await client.privateReplyToComment({ sessionKey: 's', postId: 'p', commentId: 'c', text: 'x' })
      .catch((err: FbBridgeError) => err)).toMatchObject({ permanent: false, code: 'send_not_confirmed' });
  });
});
