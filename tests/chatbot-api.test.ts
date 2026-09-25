import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '@kirana/core';
import {
  withTenant, createWaBridgeChannel, ingestInboundMessage, queueOutboundMessage, setHandling, tenantKeys, sealField,
  type Ctx, type Database,
} from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

const PASSWORD = 'correct horse battery staple';
const AGENT_PASSWORD = 'agent password long enough';

type Division = 'marketing' | 'ai';

interface Settings {
  enabled: boolean;
  channels: { id: string; kind: string; displayName: string; status: string; chatbotEnabled: boolean }[];
  counts: { bot: number; human: number; needs_human: number };
  brainNotConfiguredRecently: boolean;
}

interface Detail {
  conversation: {
    handling: string; chatbot_owned: boolean; opt_out: boolean; last_escalation_reason: string | null;
    assignee_id: string | null;
  };
  draft: { id: string; body: string } | null;
  messages: { id: string; senderType: string; senderId: string | null; status: string; body: string | null }[];
}

/**
 * The trained-cb chatbot as the console drives it: the division switch, each
 * DM account's opt-in, and taking a conversation from the bot and handing it
 * back — with the division header the console sends.
 */
describe('trained-cb chatbot through the API', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let ownerToken: string;
  let agentToken: string;
  let ownerId: string;
  let agentId: string;
  let waWeb: string;
  let aiWaWeb: string;
  let phoneSeq = 0;
  const jobs: { queue: string; payload: unknown }[] = [];

  const login = async (email: string, password: string) => {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { workspace: 'cbapi', email, password },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  };

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string,
    opts: { division?: Division; payload?: unknown; as?: string } = {},
  ) => app.inject({
    method, url, payload: opts.payload as never,
    headers: {
      authorization: `Bearer ${opts.as ?? ownerToken}`,
      ...(opts.division ? { 'x-division': opts.division } : {}),
    },
  });

  const inDivision = <T>(division: Division, fn: (ctx: Ctx) => Promise<T>) =>
    withTenant(db, t.tenantId, (tx) => fn({ tx, tenantId: t.tenantId, kek: TEST_KEK }), {
      divisionId: t.divisions[division],
    });

  /** A fresh conversation with one inbound message. */
  const inbound = async (channelId: string, division: Division = 'marketing') => {
    phoneSeq += 1;
    return inDivision(division, (ctx) => ingestInboundMessage(ctx, {
      channelId, from: `08144400${String(phoneSeq).padStart(4, '0')}`, body: 'halo kak',
      providerMessageId: `wamid.cbapi.${phoneSeq}`, displayName: 'Gabe',
    }));
  };

  const settings = async (division?: Division) => (await call('GET', '/v1/chatbot', { division })).json() as Settings;
  const detail = async (id: string) => (await call('GET', `/v1/conversations/${id}`)).json() as Detail;
  const conversation = async (id: string) => (await withTenant(db, t.tenantId, (tx) =>
    tx.query<{ handling: string; assignee_id: string | null }>(
      'select handling, assignee_id from conversations where id = $1', [id])))[0]!;
  const bdState = (conversationId: string, node: string, stoppedReason = '') =>
    withTenant(db, t.tenantId, (tx) => tx.query(
      `insert into bd_conversation_state (tenant_id, conversation_id, node, stopped_reason)
       values ($1, $2, $3, $4)`, [t.tenantId, conversationId, node, stoppedReason]));
  const run = (conversationId: string, inboundMessageId: string, fields: {
    status: string; skipReason?: string; escalationReason?: string; startedAgo?: string; intent?: string;
  }) => withTenant(db, t.tenantId, (tx) => tx.query(
    `insert into chatbot_runs
       (tenant_id, conversation_id, inbound_message_id, status, skip_reason, escalation_reason, intent,
        started_at, finished_at)
     values ($1, $2, $3, $4, $5, $6, $8, now() - $7::interval, now())`,
    [t.tenantId, conversationId, inboundMessageId, fields.status, fields.skipReason ?? null,
     fields.escalationReason ?? null, fields.startedAgo ?? '0 seconds', fields.intent ?? null]));

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'cbapi');
    app = buildApp({
      db, control: db, kek: TEST_KEK, env: env(),
      dispatch: async ({ queue, payload }) => { jobs.push({ queue, payload }); },
    });
    await app.ready();

    ownerToken = await login('owner@cbapi.test', PASSWORD);
    const created = await call('POST', '/v1/members', {
      payload: { email: 'agent@cbapi.test', name: 'Agent', role: 'agent', password: AGENT_PASSWORD },
    });
    expect(created.statusCode).toBe(201);
    agentId = (created.json() as { id: string }).id;
    agentToken = await login('agent@cbapi.test', AGENT_PASSWORD);
    ownerId = ((await call('GET', '/v1/me')).json() as { user: { id: string } }).user.id;

    waWeb = (await inDivision('marketing', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web' }))).channelId;
    aiWaWeb = (await inDivision('ai', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web AI' }))).channelId;
  });

  afterAll(async () => { await app.close(); await db.close(); });
  beforeEach(() => { jobs.length = 0; });

  /* -------------------------------------------------------------- settings */

  it('starts with the chatbot on in Marketing, off in AI, and every account off', async () => {
    expect(await settings()).toEqual({
      enabled: true,
      channels: [{ id: waWeb, kind: 'whatsapp_web', displayName: 'WA Web', status: 'connecting', chatbotEnabled: false }],
      counts: { bot: 0, human: 0, needs_human: 0 },
      brainNotConfiguredRecently: false,
    });
    expect(await settings('ai')).toMatchObject({
      enabled: false, channels: [{ id: aiWaWeb, chatbotEnabled: false }],
    });

    const me = async (division?: Division) =>
      ((await call('GET', '/v1/me', { division })).json() as { division: { key: string; chatbotEnabled: boolean } }).division;
    expect(await me()).toMatchObject({ key: 'marketing', chatbotEnabled: true });
    expect(await me('ai')).toMatchObject({ key: 'ai', chatbotEnabled: false });
  });

  it('flips the division switch under autopilot:manage, in its own division only', async () => {
    expect((await call('PUT', '/v1/chatbot', { as: agentToken, payload: { enabled: true } })).statusCode).toBe(403);
    expect((await call('PUT', '/v1/chatbot', { payload: { enabled: 'yes' } })).statusCode).toBe(422);

    const on = await call('PUT', '/v1/chatbot', { division: 'ai', payload: { enabled: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ enabled: true });
    expect((await settings('ai')).enabled).toBe(true);
    expect((await settings()).enabled).toBe(true);

    const off = await call('PUT', '/v1/chatbot', { division: 'ai', payload: { enabled: false } });
    expect(off.json()).toEqual({ enabled: false });
    expect((await settings('ai')).enabled).toBe(false);
    expect((await settings()).enabled).toBe(true);
  });

  it('switches a DM account under channel:manage, and refuses Meta channels and other divisions\' accounts', async () => {
    const toggle = (id: string, opts: { division?: Division; as?: string; enabled?: unknown } = {}) =>
      call('PATCH', `/v1/channels/${id}/chatbot`, { ...opts, payload: { enabled: opts.enabled ?? true } });

    expect((await toggle(waWeb, { as: agentToken })).statusCode).toBe(403);
    expect((await toggle(waWeb, { enabled: 'on' })).statusCode).toBe(422);

    const on = await toggle(waWeb);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ id: waWeb, chatbotEnabled: true });

    expect((await toggle(t.channelId)).statusCode).toBe(422);
    expect((await toggle(aiWaWeb)).statusCode).toBe(404);
    expect((await toggle(randomUUID())).statusCode).toBe(404);

    expect((await settings()).channels).toEqual([expect.objectContaining({ id: waWeb, chatbotEnabled: true })]);
    expect((await settings('ai')).channels).toEqual([expect.objectContaining({ id: aiWaWeb, chatbotEnabled: false })]);
  });

  /* ---------------------------------------------------------- inbox fields */

  it('shows who handles each conversation in the inbox and the thread', async () => {
    const owned = await inbound(waWeb);
    const meta = await inbound(t.channelId);
    const replies = await inDivision('marketing', async (ctx) => ({
      bot: (await queueOutboundMessage(ctx, { conversationId: owned.conversationId, body: 'dari bot', senderType: 'bot' })).messageId,
      agent: (await queueOutboundMessage(ctx, {
        conversationId: owned.conversationId, body: 'dari agen', senderType: 'agent', senderId: ownerId,
      })).messageId,
    }));

    const list = (await call('GET', '/v1/conversations')).json() as { id: string; handling: string; chatbot_owned: boolean }[];
    expect(list.find((c) => c.id === owned.conversationId)).toMatchObject({ handling: 'bot', chatbot_owned: true });
    expect(list.find((c) => c.id === meta.conversationId)).toMatchObject({ handling: 'bot', chatbot_owned: false });

    const thread = await detail(owned.conversationId);
    expect(thread.conversation).toMatchObject({
      handling: 'bot', chatbot_owned: true, opt_out: false, last_escalation_reason: null,
    });
    const byId = Object.fromEntries(thread.messages.map((m) => [m.id, m]));
    expect(byId[replies.bot]).toMatchObject({ senderType: 'bot', senderId: null, status: 'queued', body: 'dari bot' });
    expect(byId[replies.agent]).toMatchObject({ senderType: 'agent', senderId: ownerId, status: 'queued' });
    expect((await detail(meta.conversationId)).conversation.chatbot_owned).toBe(false);

    await run(owned.conversationId, owned.messageId, { status: 'replied', escalationReason: 'price_negotiation' });
    expect((await detail(owned.conversationId)).conversation.last_escalation_reason).toBe('price_negotiation');

    expect((await settings()).counts).toEqual({ bot: 1, human: 0, needs_human: 0 });
  });

  it('names why the bot asked for a person from its latest word only, whoever holds the thread', async () => {
    phoneSeq += 1;
    const phone = `08144400${String(phoneSeq).padStart(4, '0')}`;
    const message = async () => (await inDivision('marketing', (ctx) => ingestInboundMessage(ctx, {
      channelId: waWeb, from: phone, body: 'halo', providerMessageId: `wamid.cbapi.reason.${randomUUID()}`,
    })));
    const first = await message();
    const reasonOf = async () => (await detail(first.conversationId)).conversation.last_escalation_reason;

    // The flow escalated and kept answering: the reason shows while the bot has the thread.
    await run(first.conversationId, first.messageId, {
      status: 'replied', intent: 'nego_harga', escalationReason: 'price negotiation', startedAgo: '5 minutes',
    });
    expect((await detail(first.conversationId)).conversation.handling).toBe('bot');
    expect(await reasonOf()).toBe('price negotiation');

    // A message skipped before the brain saw it says nothing new.
    await run(first.conversationId, (await message()).messageId, {
      status: 'skipped', skipReason: 'human_active', startedAgo: '4 minutes',
    });
    expect(await reasonOf()).toBe('price negotiation');

    // A later hand-over the retries caused carries no reason, and shows none.
    await run(first.conversationId, (await message()).messageId, {
      status: 'failed', skipReason: 'exhausted', startedAgo: '3 minutes',
    });
    await inDivision('marketing', (ctx) =>
      setHandling(ctx, { conversationId: first.conversationId, handling: 'needs_human' }));
    expect(await reasonOf()).toBeNull();

    // A booking recorded while a person was taking over is named to them.
    await run(first.conversationId, (await message()).messageId, {
      status: 'skipped', skipReason: 'human_active', intent: 'isi_email',
      escalationReason: 'booked_during_takeover', startedAgo: '2 minutes',
    });
    expect(await reasonOf()).toBe('booked_during_takeover');
  });

  /* -------------------------------------------------------------- takeover */

  it('takes a conversation over: the bot stops, its queued replies are cancelled, the taker is assigned', async () => {
    const m = await inbound(waWeb);
    const queued = await inDivision('marketing', async (ctx) => ({
      bot1: (await queueOutboundMessage(ctx, { conversationId: m.conversationId, body: 'bot 1', senderType: 'bot' })).messageId,
      bot2: (await queueOutboundMessage(ctx, { conversationId: m.conversationId, body: 'bot 2', senderType: 'bot' })).messageId,
      agent: (await queueOutboundMessage(ctx, {
        conversationId: m.conversationId, body: 'agen', senderType: 'agent', senderId: ownerId,
      })).messageId,
    }));

    const res = await call('POST', `/v1/conversations/${m.conversationId}/takeover`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ handling: 'human', cancelled: 2 });
    expect(await conversation(m.conversationId)).toEqual({ handling: 'human', assignee_id: ownerId });

    const outbox = await withTenant(db, t.tenantId, (tx) => tx.query<{ message_id: string }>(
      'select message_id from message_outbox where message_id = any($1::uuid[])',
      [[queued.bot1, queued.bot2, queued.agent]]));
    expect(outbox.map((o) => o.message_id)).toEqual([queued.agent]);

    const thread = await detail(m.conversationId);
    expect(thread.conversation).toMatchObject({ handling: 'human', chatbot_owned: true });
    const status = Object.fromEntries(thread.messages.map((msg) => [msg.id, msg.status]));
    expect(status).toMatchObject({ [queued.bot1]: 'failed', [queued.bot2]: 'failed', [queued.agent]: 'queued' });

    const audits = await withTenant(db, t.tenantId, (tx) => tx.query<{ actor_id: string }>(
      `select actor_id from audit_events where action = 'chatbot.takeover' and resource_id = $1`, [m.conversationId]));
    expect(audits).toEqual([{ actor_id: ownerId }]);

    // Taking over again is harmless.
    expect((await call('POST', `/v1/conversations/${m.conversationId}/takeover`)).json())
      .toEqual({ handling: 'human', cancelled: 0 });
    expect(jobs).toEqual([]);
  });

  it('lets an agent claim an unassigned thread by taking it over, but not someone else\'s', async () => {
    const free = await inbound(waWeb);
    const claimed = await call('POST', `/v1/conversations/${free.conversationId}/takeover`, { as: agentToken });
    expect(claimed.statusCode).toBe(200);
    expect(await conversation(free.conversationId)).toEqual({ handling: 'human', assignee_id: agentId });

    const owners = await inbound(waWeb);
    expect((await call('POST', `/v1/conversations/${owners.conversationId}/assign`, {
      payload: { assigneeId: ownerId },
    })).statusCode).toBe(200);
    expect((await call('POST', `/v1/conversations/${owners.conversationId}/takeover`, { as: agentToken })).statusCode)
      .toBe(403);
    expect((await call('POST', `/v1/conversations/${owners.conversationId}/bot/resume`, { as: agentToken })).statusCode)
      .toBe(403);
    expect(await conversation(owners.conversationId)).toEqual({ handling: 'bot', assignee_id: ownerId });

    expect((await call('POST', `/v1/conversations/${randomUUID()}/takeover`)).statusCode).toBe(404);
  });

  /* ---------------------------------------------------------------- resume */

  it('hands a conversation back to the bot, releasing a handover the way the engine does', async () => {
    const taken = await inbound(waWeb);
    await call('POST', `/v1/conversations/${taken.conversationId}/takeover`);
    const resumed = await call('POST', `/v1/conversations/${taken.conversationId}/bot/resume`);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toEqual({ handling: 'bot' });
    expect((await conversation(taken.conversationId)).handling).toBe('bot');

    const handedOver = await inbound(waWeb);
    await bdState(handedOver.conversationId, 'handover');
    await inDivision('marketing', (ctx) =>
      setHandling(ctx, { conversationId: handedOver.conversationId, handling: 'needs_human' }));
    expect((await detail(handedOver.conversationId)).conversation.handling).toBe('needs_human');

    expect((await call('POST', `/v1/conversations/${handedOver.conversationId}/bot/resume`)).statusCode).toBe(200);
    const [state] = await withTenant(db, t.tenantId, (tx) => tx.query<{ node: string; handling: string }>(
      `select s.node, c.handling from bd_conversation_state s join conversations c on c.id = s.conversation_id
        where s.conversation_id = $1`, [handedOver.conversationId]));
    expect(state).toEqual({ node: 'qna', handling: 'bot' });

    expect((await call('POST', `/v1/conversations/${randomUUID()}/bot/resume`)).statusCode).toBe(404);
  });

  it('refuses to hand a contact who opted out back to the bot', async () => {
    const m = await inbound(waWeb);
    await bdState(m.conversationId, 'stopped', 'opt_out');
    await inDivision('marketing', (ctx) => setHandling(ctx, { conversationId: m.conversationId, handling: 'human' }));

    const res = await call('POST', `/v1/conversations/${m.conversationId}/bot/resume`);
    expect(res.statusCode).toBe(409);
    expect((await detail(m.conversationId)).conversation).toMatchObject({ handling: 'human', opt_out: true });
  });

  /* ------------------------------------------------------ one owner, drafts */

  it('hides a pending Autopilot draft on a chatbot conversation and refuses to send it', async () => {
    const owned = await inbound(waWeb);
    const meta = await inbound(t.channelId);
    const draftOn = (conversationId: string) => withTenant(db, t.tenantId, async (tx) => {
      const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
      return (await tx.query<{ id: string }>(
        `insert into message_drafts (tenant_id, conversation_id, body_enc) values ($1, $2, $3) returning id`,
        [t.tenantId, conversationId, sealField(keys, t.tenantId, 'draf lama')]))[0]!.id;
    });
    const ownedDraft = await draftOn(owned.conversationId);
    const metaDraft = await draftOn(meta.conversationId);

    expect((await detail(owned.conversationId)).draft).toBeNull();
    expect((await detail(meta.conversationId)).draft).toMatchObject({ id: metaDraft, body: 'draf lama' });

    const refused = await call('POST', `/v1/conversations/${owned.conversationId}/drafts/${ownedDraft}`, {
      payload: { action: 'use' },
    });
    expect(refused.statusCode).toBe(409);
    expect(jobs).toEqual([]);
    const [kept] = await withTenant(db, t.tenantId, (tx) => tx.query<{ status: string }>(
      'select status from message_drafts where id = $1', [ownedDraft]));
    expect(kept!.status).toBe('pending');

    // Legacy Autopilot keeps working where trained-cb does not answer.
    const used = await call('POST', `/v1/conversations/${meta.conversationId}/drafts/${metaDraft}`, {
      payload: { action: 'use' },
    });
    expect(used.statusCode).toBe(202);
    expect(jobs.map((j) => j.queue)).toEqual(['outbound.send']);
  });

  it('never lets a client write as the bot', async () => {
    const m = await inbound(waWeb);
    const res = await call('POST', `/v1/conversations/${m.conversationId}/messages`, {
      payload: { body: 'menyamar jadi bot', senderType: 'bot' },
    });
    expect(res.statusCode).toBe(422);
    expect(jobs).toEqual([]);
  });

  /* --------------------------------------------------------- brain warning */

  it('warns when the brain was missing for a run in the last day, per division', async () => {
    const recent = await inbound(waWeb);
    const aiOld = await inbound(aiWaWeb, 'ai');
    await run(aiOld.conversationId, aiOld.messageId, {
      status: 'skipped', skipReason: 'brain_not_configured', startedAgo: '2 days',
    });
    expect((await settings()).brainNotConfiguredRecently).toBe(false);
    expect((await settings('ai')).brainNotConfiguredRecently).toBe(false);

    await run(recent.conversationId, recent.messageId, { status: 'skipped', skipReason: 'brain_not_configured' });
    expect((await settings()).brainNotConfiguredRecently).toBe(true);
    expect((await settings('ai')).brainNotConfiguredRecently).toBe(false);
  });
});
