import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env, bridgeSessionKey, type Env } from '@kirana/core';
import {
  withTenant, ensureMessengerBridgeChannel, ensureInstagramBridgeChannel, setFbBridgeConnection,
  setIgBridgeConnection, queueOutboundMessage, listFacebookComments,
  type Database,
} from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { facebookExternalId } from '../apps/api/src/routes/webhooks.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { facebookMessageKey } from '../apps/worker/src/processors/facebookInbound.ts';
import { processOutbound } from '../apps/worker/src/processors/outboundSend.ts';
import { processCommentPublicReply, type CommentEnv } from '../apps/worker/src/processors/facebookComments.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * Provider events route by the bridge session they came off, never by which
 * division somebody has open in a browser. One tenant, two divisions, two
 * Facebook Pages (and two Instagram accounts): everything a Marketing session
 * reports lands in Marketing, everything an AI session reports lands in AI,
 * and a bridge that predates divisions — sending no session key at all — is
 * still Marketing's, under exactly the dedupe keys it always used.
 */

const PAGE_MARKETING = { id: '900000000000101', name: 'Toko Demo Marketing' };
const PAGE_AI = { id: '900000000000102', name: 'Toko Demo AI' };
const CUSTOMER = { id: '100000000000321', name: 'Rina Wijaya' };

const COMMENT_ENV: CommentEnv = {
  FB_COMMENT_AUTO_DM: false, FB_COMMENT_COOLDOWN_MS: 0, FB_COMMENT_BATCH: 10, FB_COMMENT_MAX_ATTEMPTS: 3,
  FB_COMMENT_AUTO_REPLY_TEXT: 'Check DM ya kak', FB_COMMENT_AUTO_DM_TEXT: 'Halo kak',
};

describe('bridge events route by division', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let e: Env;
  let ownerId: string;
  let aiKey: string;
  const published: { tenantId: string; divisionId?: string; conversationId: string }[] = [];

  const post = (url: string, body: unknown, secret: string) => app.inject({
    method: 'POST', url,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  const fbEvent = (over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => ({
    event: 'message', tenantId: t.tenantId, at: new Date().toISOString(),
    message: {
      threadId: CUSTOMER.id, externalMessageId: null, senderId: CUSTOMER.id, senderName: CUSTOMER.name,
      text: 'halo, masih ready?', sentAt: null, direction: 'inbound', seq: 0, ...message,
    },
    ...over,
  });

  const conversationsOn = (kind: string) => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ id: string; division_id: string; channel_id: string }>(
      `select c.id, c.division_id, c.channel_id
         from conversations c join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
        where c.tenant_id = $1 and ch.kind = $2
        order by c.created_at`,
      [t.tenantId, kind]));

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'divroute');
    e = env();

    app = buildApp({
      db, control: db, kek: TEST_KEK, env: e,
      dispatch: async ({ queue, payload }) => {
        if (queue !== 'inbound.normalise') return;
        await processInboundWebhook(
          {
            db, control: db, kek: TEST_KEK, dispatch: async () => {},
            publish: (tenantId, event) => { published.push({ tenantId, ...event }); },
          },
          (payload as { webhookEventId: string }).webhookEventId,
        );
      },
    });
    await app.ready();

    ownerId = (await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ id: string }>('select id from users where tenant_id = $1 limit 1', [t.tenantId])))[0]!.id;

    // Marketing: connected the way every Page was before divisions — no
    // division named, so it lands in Marketing by default.
    await withTenant(db, t.tenantId, async (tx) => {
      const ctx = { tx, tenantId: t.tenantId, kek: TEST_KEK };
      await ensureMessengerBridgeChannel(ctx, { pageId: PAGE_MARKETING.id, pageName: PAGE_MARKETING.name, status: 'connected' });
      await setFbBridgeConnection(ctx, { status: 'ready', pageId: PAGE_MARKETING.id, pageName: PAGE_MARKETING.name, actorId: null });
    });

    // AI: a different Page, connected inside the AI division.
    aiKey = await withTenant(db, t.tenantId, async (tx) => {
      const ctx = { tx, tenantId: t.tenantId, kek: TEST_KEK, divisionId: t.divisions.ai };
      await ensureMessengerBridgeChannel(ctx, { pageId: PAGE_AI.id, pageName: PAGE_AI.name, status: 'connected' });
      const { sessionKey } = await setFbBridgeConnection(ctx, {
        status: 'ready', pageId: PAGE_AI.id, pageName: PAGE_AI.name, actorId: null,
      });
      return sessionKey;
    }, { divisionId: t.divisions.ai });
  });

  afterAll(async () => { await app.close(); await db.close(); });

  it('issues session keys that keep Marketing on its existing profile', async () => {
    const marketing = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ session_key: string; division_id: string }>(
        'select session_key, division_id from fb_bridge_connections where tenant_id = $1 order by session_key',
        [t.tenantId]));

    expect(marketing.map((r) => r.session_key)).toEqual([t.tenantId, `${t.tenantId}-ai`]);
    expect(aiKey).toBe(`${t.tenantId}-ai`);
    expect(bridgeSessionKey(t.tenantId, 'marketing')).toBe(t.tenantId);
    expect(bridgeSessionKey(t.tenantId, 'ai')).toBe(aiKey);
  });

  it('files the two Pages\' channels in their own divisions', async () => {
    const channels = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ external_id: string; division_id: string }>(
        `select external_id, division_id from channels
          where tenant_id = $1 and kind = 'messenger_bridge' order by external_id`,
        [t.tenantId]));

    expect(channels).toEqual([
      { external_id: PAGE_MARKETING.id, division_id: t.divisions.marketing },
      { external_id: PAGE_AI.id, division_id: t.divisions.ai },
    ]);
  });

  it('routes an event with no session key to Marketing, as before divisions', async () => {
    const res = await post('/v1/webhooks/fb-bridge', fbEvent(), e.FB_BRIDGE_SECRET);
    expect(res.statusCode).toBe(200);

    const convs = await conversationsOn('messenger_bridge');
    expect(convs).toHaveLength(1);
    expect(convs[0]!.division_id).toBe(t.divisions.marketing);
    expect(published.at(-1)).toMatchObject({ tenantId: t.tenantId, divisionId: t.divisions.marketing });
  });

  it('routes an AI session\'s event to AI, and gives the same person a second contact there', async () => {
    const res = await post('/v1/webhooks/fb-bridge', fbEvent({ sessionKey: aiKey }, { seq: 0 }), e.FB_BRIDGE_SECRET);
    expect(res.statusCode).toBe(200);

    const convs = await conversationsOn('messenger_bridge');
    expect(convs.map((c) => c.division_id).sort()).toEqual([t.divisions.ai, t.divisions.marketing].sort());
    expect(published.at(-1)).toMatchObject({ tenantId: t.tenantId, divisionId: t.divisions.ai });

    // One Facebook user, two divisions, two contacts — never merged.
    const contacts = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ division_id: string; n: number }>(
        `select division_id, count(*)::int as n from contacts
          where tenant_id = $1 and fb_user_id_bidx is not null group by division_id`,
        [t.tenantId]));
    expect(contacts.map((c) => c.n)).toEqual([1, 1]);
    expect(new Set(contacts.map((c) => c.division_id))).toEqual(new Set([t.divisions.marketing, t.divisions.ai]));
  });

  it('sends a reply through the session of the conversation\'s own division', async () => {
    const convs = await conversationsOn('messenger_bridge');
    const marketing = convs.find((c) => c.division_id === t.divisions.marketing)!;
    const ai = convs.find((c) => c.division_id === t.divisions.ai)!;

    const sent: string[] = [];
    const never = () => { throw new Error('a Facebook reply must never reach another provider client'); };
    const deps = {
      db, kek: TEST_KEK,
      meta: { send: never } as never, waBridge: { send: never } as never, igBridge: { send: never } as never,
      fbBridge: { send: async (args: { sessionKey: string }) => { sent.push(args.sessionKey); } } as never,
      accessTokenFor: never as never,
    };

    for (const [conv, divisionId] of [[ai, t.divisions.ai], [marketing, t.divisions.marketing]] as const) {
      const queued = await withTenant(db, t.tenantId, (tx) =>
        queueOutboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK, divisionId }, {
          conversationId: conv.id, body: 'baik kak', senderType: 'agent',
        }), { divisionId });
      await processOutbound(deps, { tenantId: t.tenantId, messageId: queued.messageId });
    }

    expect(sent).toEqual([aiKey, t.tenantId]);
  });

  it('answers a comment on the AI Page from the AI session', async () => {
    const res = await post('/v1/webhooks/fb-bridge', {
      event: 'comment', tenantId: t.tenantId, sessionKey: aiKey, at: new Date().toISOString(),
      comment: {
        commentId: '700100', postId: '998877', authorId: '100000000000909', authorName: 'Dewi',
        text: 'harga berapa?', commentedAt: null, pageId: PAGE_AI.id, pageName: PAGE_AI.name,
      },
    }, e.FB_BRIDGE_SECRET);
    expect(res.statusCode).toBe(200);

    const inAi = await withTenant(db, t.tenantId, (tx) =>
      listFacebookComments({ tx, tenantId: t.tenantId, kek: TEST_KEK }), { divisionId: t.divisions.ai });
    const inMarketing = await withTenant(db, t.tenantId, (tx) =>
      listFacebookComments({ tx, tenantId: t.tenantId, kek: TEST_KEK }), { divisionId: t.divisions.marketing });
    expect(inAi.map((c) => c.commentId)).toEqual(['700100']);
    expect(inMarketing).toHaveLength(0);
    expect(inAi[0]!.divisionId).toBe(t.divisions.ai);

    const replies: string[] = [];
    const outcome = await processCommentPublicReply({
      db, kek: TEST_KEK, dispatch: async () => {}, env: COMMENT_ENV,
      fbBridge: {
        replyToComment: async (args) => { replies.push(args.sessionKey); },
        privateReplyToComment: async () => ({ threadId: 'x' }),
      },
    }, { tenantId: t.tenantId, commentId: inAi[0]!.id, text: 'Check DM ya kak' });

    expect(outcome.status).toBe('replied');
    expect(replies).toEqual([aiKey]);
  });

  it('routes an AI Instagram session\'s DM to the AI channel', async () => {
    await withTenant(db, t.tenantId, async (tx) => {
      const ctx = { tx, tenantId: t.tenantId, kek: TEST_KEK, divisionId: t.divisions.ai };
      await ensureInstagramBridgeChannel(ctx, { username: 'toko.demo.ai' });
      const { sessionKey } = await setIgBridgeConnection(ctx, {
        status: 'ready', username: 'toko.demo.ai', challengeType: null, lastError: null, actorId: ownerId,
      });
      expect(sessionKey).toBe(aiKey);
    }, { divisionId: t.divisions.ai });

    const res = await post('/v1/webhooks/ig-bridge', {
      tenantId: t.tenantId, sessionKey: aiKey, event: 'message',
      message: {
        threadId: '340282366841710300949128', participantUsername: 'rina.w', senderUsername: 'rina.w',
        text: 'kak, ini masih ada?', direction: 'inbound', index: 0,
      },
    }, e.IG_BRIDGE_SECRET);
    expect(res.statusCode).toBe(200);

    const convs = await conversationsOn('instagram_bridge');
    expect(convs).toHaveLength(1);
    expect(convs[0]!.division_id).toBe(t.divisions.ai);
  });

  it('keeps the legacy dedupe key byte-identical between the API and the worker', () => {
    const message = {
      threadId: CUSTOMER.id, externalMessageId: null, senderId: CUSTOMER.id, seq: 3, text: 'halo lagi',
    };
    expect(facebookExternalId(t.tenantId, 'message', message, null)).toBe(facebookMessageKey(t.tenantId, message));
    expect(facebookExternalId(t.tenantId, 'message', { ...message, externalMessageId: 'mid.$1' }, null))
      .toBe(`fb_dm:${t.tenantId}:mid.$1`);
    // Two divisions, two keys: the same message on the AI Page is a different event.
    expect(facebookMessageKey(aiKey, message)).not.toBe(facebookMessageKey(t.tenantId, message));
  });

  it('rejects an event for a session nobody issued', async () => {
    const bogus = await post('/v1/webhooks/fb-bridge', fbEvent({ sessionKey: 'not-a-session-key' }), e.FB_BRIDGE_SECRET);
    expect(bogus.statusCode).toBe(400);

    const stranger = '00000000-0000-4000-8000-000000000000';
    const unknownTenant = await post(
      '/v1/webhooks/fb-bridge', fbEvent({ tenantId: stranger, sessionKey: `${stranger}-ai` }), e.FB_BRIDGE_SECRET);
    expect(unknownTenant.statusCode).toBe(400);

    // A key that belongs to a real tenant but is claimed for another one.
    const mismatch = await post('/v1/webhooks/fb-bridge', fbEvent({ tenantId: stranger, sessionKey: aiKey }), e.FB_BRIDGE_SECRET);
    expect(mismatch.statusCode).toBe(400);
  });
});
