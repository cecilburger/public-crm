import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env } from '@kirana/core';
import {
  withTenant, addChannel, ingestInboundMessage, recordFacebookComment, recordIgComment,
  saveGoogleCalendarConnection, createWaBridgeChannel, setFbBridgeConnection, ensureMessengerBridgeChannel,
  getFbBridgeConnection, type Ctx, type Database,
} from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

const PASSWORD = 'correct horse battery staple';
/** One customer who writes to both divisions' WhatsApp numbers. */
const SAME_PHONE = '081234500001';

type Division = 'marketing' | 'ai';

/**
 * Marketing and AI through the real API — the requests the console makes,
 * with the division header the console sends.
 *
 * The rule under test: a request acts in exactly one division, lists show
 * only that division, and a record from the other division is "not found" —
 * by list, by id, and as the target of a write — however its id was obtained.
 */
describe('Marketing and AI are isolated at the API', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let token: string;
  let otherToken: string;
  let ownerId: string;
  let aiChannelId: string;
  const jobs: { queue: string; payload: unknown }[] = [];

  const login = async (workspace: string) => {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace, email: `owner@${workspace}.test`, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  };

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string,
    opts: { division?: string; payload?: unknown; as?: string } = {},
  ) => app.inject({
    method, url, payload: opts.payload as never,
    headers: {
      authorization: `Bearer ${opts.as ?? token}`,
      ...(opts.division ? { 'x-division': opts.division } : {}),
    },
  });

  /** Writes straight through the repository, inside one division. */
  const inDivision = <T>(division: Division, fn: (ctx: Ctx) => Promise<T>) =>
    withTenant(db, t.tenantId, (tx) => fn({ tx, tenantId: t.tenantId, kek: TEST_KEK }), {
      divisionId: t.divisions[division],
    });

  const ids = (res: { json(): unknown }) => (res.json() as { id: string }[]).map((r) => r.id);

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'divapi');
    other = await makeTenant(db, 'divother');

    app = buildApp({
      db, control: db, kek: TEST_KEK, env: env(),
      dispatch: async ({ queue, payload }) => { jobs.push({ queue, payload }); },
    });
    await app.ready();

    token = await login('divapi');
    otherToken = await login('divother');
    ownerId = (((await call('GET', '/v1/me')).json()) as { user: { id: string } }).user.id;

    aiChannelId = (await addChannel(db, t.tenantId, {
      kind: 'whatsapp', displayName: 'WA AI', externalId: 'wa-divapi-ai', phoneE164: '+628110000009',
    }, { divisionId: t.divisions.ai })).id;

    await inDivision('marketing', (ctx) => ingestInboundMessage(ctx, {
      channelId: t.channelId, from: SAME_PHONE, body: 'halo marketing', providerMessageId: 'wamid.divapi.m',
      displayName: 'Gabe',
    }));
    await inDivision('ai', (ctx) => ingestInboundMessage(ctx, {
      channelId: aiChannelId, from: SAME_PHONE, body: 'halo ai', providerMessageId: 'wamid.divapi.a',
      displayName: 'Gabe',
    }));
  });

  afterAll(async () => { await app.close(); await db.close(); });
  afterEach(() => { vi.unstubAllGlobals(); jobs.length = 0; });

  /* ------------------------------------------------------- the division */

  it('acts in Marketing when a request names no division', async () => {
    const plain = (await call('GET', '/v1/me')).json() as {
      division: { key: string }; divisions: { key: string; name: string }[];
    };
    expect(plain.division.key).toBe('marketing');
    expect(plain.divisions.map((d) => d.key)).toEqual(['marketing', 'ai']);

    const ai = (await call('GET', '/v1/me', { division: 'ai' })).json() as { division: { key: string; name: string } };
    expect(ai.division).toMatchObject({ key: 'ai', name: 'AI' });

    const back = (await call('GET', '/v1/me', { division: 'marketing' })).json() as { division: { key: string } };
    expect(back.division.key).toBe('marketing');
  });

  it('refuses a division it does not know, and never accepts an id in its place', async () => {
    expect((await call('GET', '/v1/me', { division: 'sales' })).statusCode).toBe(422);
    // A division id — even the tenant's own, even another tenant's — is not a key.
    expect((await call('GET', '/v1/me', { division: t.divisions.ai })).statusCode).toBe(422);
    expect((await call('GET', '/v1/conversations', { division: other.divisions.marketing })).statusCode).toBe(422);
  });

  /* ------------------------------------------------------------- inbox */

  it('keeps conversations apart, by list and by id', async () => {
    const marketing = ids(await call('GET', '/v1/conversations'));
    const ai = ids(await call('GET', '/v1/conversations', { division: 'ai' }));
    expect(marketing).toHaveLength(1);
    expect(ai).toHaveLength(1);
    expect(marketing[0]).not.toBe(ai[0]);

    // The example the requirement names: AI active, a Marketing conversation's id.
    expect((await call('GET', `/v1/conversations/${marketing[0]}`, { division: 'ai' })).statusCode).toBe(404);
    expect((await call('GET', `/v1/conversations/${ai[0]}`)).statusCode).toBe(404);
    expect((await call('GET', `/v1/conversations/${ai[0]}`, { division: 'ai' })).statusCode).toBe(200);
  });

  it('refuses every action on the other division\'s conversation', async () => {
    const [marketingConversation] = ids(await call('GET', '/v1/conversations'));
    const asAi = { division: 'ai' };

    const reply = await call('POST', `/v1/conversations/${marketingConversation}/messages`, {
      ...asAi, payload: { body: 'tidak boleh terkirim' },
    });
    expect(reply.statusCode).toBe(404);
    expect(jobs.filter((j) => j.queue === 'outbound.send')).toHaveLength(0);

    expect((await call('POST', `/v1/conversations/${marketingConversation}/assign`, {
      ...asAi, payload: { assigneeId: ownerId },
    })).statusCode).toBe(404);
    expect((await call('POST', `/v1/conversations/${marketingConversation}/resolve`, asAi)).statusCode).toBe(404);

    // Still open and unassigned in Marketing.
    const [row] = await withTenant(db, t.tenantId, (tx) => tx.query<{ status: string; assignee_id: string | null }>(
      'select status, assignee_id from conversations where id = $1', [marketingConversation]));
    expect(row).toEqual({ status: 'open', assignee_id: null });
  });

  it('refuses to discard or use the other division\'s Autopilot draft', async () => {
    const [marketingConversation] = ids(await call('GET', '/v1/conversations'));
    const [draft] = await inDivision('marketing', (ctx) => ctx.tx.query<{ id: string }>(
      `insert into message_drafts (tenant_id, conversation_id, body_enc) values ($1, $2, 'sealed') returning id`,
      [t.tenantId, marketingConversation]));

    // Discarding touches only the draft row — the division has to hold there
    // too, not just on the conversation.
    for (const action of ['discard', 'use'] as const) {
      const res = await call('POST', `/v1/conversations/${marketingConversation}/drafts/${draft!.id}`, {
        division: 'ai', payload: { action },
      });
      expect(res.statusCode, action).toBe(404);
    }

    const [row] = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string }>('select status from message_drafts where id = $1', [draft!.id]));
    expect(row!.status).toBe('pending');
  });

  /* --------------------------------------------------- contacts, clients */

  it('keeps the same customer as a separate contact in each division', async () => {
    const marketing = ids(await call('GET', '/v1/contacts?all=1'));
    const ai = ids(await call('GET', '/v1/contacts?all=1', { division: 'ai' }));
    expect(marketing).toHaveLength(1);
    expect(ai).toHaveLength(1);
    expect(marketing[0]).not.toBe(ai[0]);

    const aiContact = ai[0]!;
    expect((await call('GET', `/v1/contacts/${aiContact}`)).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/contacts/${aiContact}`, {
      payload: {
        displayName: 'Diubah dari Marketing', phone: null, email: null, igUsername: null, tags: [],
        address: null, notes: null, storeName: null, storeStatus: null, scheduleMeeting: null, clientStatus: null,
      },
    })).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/contacts/${aiContact}`)).statusCode).toBe(404);

    // Untouched in AI.
    const [kept] = await withTenant(db, t.tenantId, (tx) => tx.query<{ display_name: string; deleted_at: Date | null }>(
      'select display_name, deleted_at from contacts where id = $1', [aiContact]));
    expect(kept).toEqual({ display_name: 'Gabe', deleted_at: null });
  });

  it('lets each division hold its own client with the same phone, store and status', async () => {
    const client = (storeName: string, notes: string) => ({
      displayName: 'Client ABC', phone: '081299990000', tags: ['customer'],
      storeName, storeStatus: 'aktif', notes, clientStatus: 'deal',
    });

    const inAi = await call('POST', '/v1/contacts', { division: 'ai', payload: client('Toko AI', 'catatan AI') });
    expect(inAi.statusCode).toBe(201);
    const inMarketing = await call('POST', '/v1/contacts', { payload: client('Toko Marketing', 'catatan marketing') });
    expect(inMarketing.statusCode).toBe(201);

    const aiId = (inAi.json() as { id: string }).id;
    const marketingId = (inMarketing.json() as { id: string }).id;
    expect(aiId).not.toBe(marketingId);

    // The Pelanggan list (tag `customer`) of each division shows only its own.
    expect(ids(await call('GET', '/v1/contacts'))).toContain(marketingId);
    expect(ids(await call('GET', '/v1/contacts'))).not.toContain(aiId);
    expect(ids(await call('GET', '/v1/contacts', { division: 'ai' }))).toEqual([aiId]);

    const aiDetail = JSON.stringify((await call('GET', `/v1/contacts/${aiId}`, { division: 'ai' })).json());
    expect(aiDetail).toContain('Toko AI');
    expect(aiDetail).toContain('catatan AI');
    expect(aiDetail).not.toContain('Toko Marketing');
  });

  /* ------------------------------------------------ brands, deals, tasks */

  it('keeps brands, deals and tasks apart, and refuses to link across', async () => {
    const brand = await call('POST', '/v1/brands', { division: 'ai', payload: { name: 'Brand AI' } });
    expect(brand.statusCode).toBe(201);
    const brandId = (brand.json() as { id: string }).id;

    expect(ids(await call('GET', '/v1/brands'))).not.toContain(brandId);
    expect(ids(await call('GET', '/v1/brands', { division: 'ai' }))).toContain(brandId);
    expect((await call('GET', `/v1/brands/${brandId}`)).statusCode).toBe(404);

    const deal = await call('POST', '/v1/deals', {
      division: 'ai', payload: { brandId, title: 'Paket AI', amountIdr: 1_500_000 },
    });
    expect(deal.statusCode).toBe(201);
    const dealId = (deal.json() as { id: string }).id;
    expect((await call('GET', `/v1/deals/${dealId}`)).statusCode).toBe(404);
    expect((await call('GET', `/v1/deals/${dealId}`, { division: 'ai' })).statusCode).toBe(200);

    const task = await call('POST', '/v1/tasks', {
      division: 'ai', payload: { brandId, title: 'Follow-up AI', dueAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(task.statusCode).toBe(201);
    const taskId = (task.json() as { id: string }).id;
    expect(ids(await call('GET', '/v1/tasks'))).not.toContain(taskId);
    expect(ids(await call('GET', '/v1/tasks', { division: 'ai' }))).toContain(taskId);
    expect((await call('POST', `/v1/tasks/${taskId}/done`)).statusCode).toBe(404);

    // Marketing naming AI's brand is naming something that does not exist there.
    const smuggled = await call('POST', '/v1/tasks', {
      payload: { brandId, title: 'Tugas selundupan', dueAt: new Date().toISOString() },
    });
    expect(smuggled.statusCode).toBe(404);
    const [{ n }] = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from tasks where title = 'Tugas selundupan'`)) as [{ n: number }];
    expect(n).toBe(0);
  });

  /* ---------------------------------------------------------- comments */

  it('keeps Facebook comments apart, and refuses to act on the other division\'s', async () => {
    const record = (division: Division, commentId: string) => inDivision(division, (ctx) =>
      recordFacebookComment(ctx, {
        pageId: `page-${division}`, pageName: `Page ${division}`, postId: `post-${division}`, commentId,
        authorExternalId: '100000000000123', authorName: 'Budi', body: 'mau tanya harga',
      }));
    const marketingComment = (await record('marketing', 'c-marketing')).id;
    const aiComment = (await record('ai', 'c-ai')).id;

    const listed = async (division?: Division) =>
      ((await call('GET', '/v1/inbox/comments', { division })).json() as { comments: { id: string }[] })
        .comments.map((c) => c.id);
    expect(await listed()).toEqual([marketingComment]);
    expect(await listed('ai')).toEqual([aiComment]);

    const refused = await call('POST', `/v1/facebook-bridge/comments/${marketingComment}/reply-public`, {
      division: 'ai', payload: { text: 'Halo kak' },
    });
    expect(refused.statusCode).toBe(404);
    expect(jobs).toHaveLength(0);

    const accepted = await call('POST', `/v1/facebook-bridge/comments/${aiComment}/reply-public`, {
      division: 'ai', payload: { text: 'Halo kak' },
    });
    expect(accepted.statusCode).toBe(202);
    expect(jobs).toHaveLength(1);
  });

  it('keeps Instagram comments apart, and refuses to act on the other division\'s', async () => {
    const aiComment = (await inDivision('ai', (ctx) => recordIgComment(ctx, {
      postRef: 'post-ai', commentRef: 'ig-c-ai', commenter: 'budi', text: 'harga berapa kak?',
    }))).id;

    const listed = async (division?: Division) =>
      ((await call('GET', '/v1/ig-comments', { division })).json() as { id: string }[]).map((c) => c.id);
    expect(await listed()).not.toContain(aiComment);
    expect(await listed('ai')).toContain(aiComment);

    expect((await call('PATCH', `/v1/ig-comments/${aiComment}`, { payload: { publicStatus: 'sent' } })).statusCode)
      .toBe(404);
    expect((await call('PATCH', `/v1/ig-comments/${aiComment}`, {
      division: 'ai', payload: { publicStatus: 'sent' },
    })).statusCode).toBe(200);
  });

  /* --------------------------------------------------------- dashboard */

  it('counts the dashboard per division', async () => {
    const contactsIn = (divisionId?: string) => withTenant(db, t.tenantId, async (tx) =>
      (await tx.query<{ n: number }>('select count(*)::int as n from contacts where deleted_at is null'))[0]!.n,
    { divisionId });
    const summary = async (division?: Division) =>
      (await call('GET', '/v1/dashboard/summary', { division })).json() as { totalClients: number; unansweredCount: number };

    const marketing = await summary();
    const ai = await summary('ai');
    expect(marketing.totalClients).toBe(await contactsIn(t.divisions.marketing));
    expect(ai.totalClients).toBe(await contactsIn(t.divisions.ai));
    expect(marketing.totalClients + ai.totalClients).toBe(await contactsIn());
    expect(marketing.unansweredCount).toBe(1);
    expect(ai.unansweredCount).toBe(1);
  });

  /* ---------------------------------------------------------- calendar */

  it('keeps Google Calendar connections per division', async () => {
    await inDivision('marketing', (ctx) => saveGoogleCalendarConnection(ctx, {
      userId: ownerId,
      tokens: {
        accessToken: 'at-marketing', refreshToken: 'rt-marketing',
        expiresAt: new Date(Date.now() + 3_600_000), email: 'marketing@toko.test',
      },
    }));

    const status = async (division?: Division) =>
      (await call('GET', '/v1/google-calendar/status', { division })).json() as { connected: boolean; email: string | null };
    expect(await status()).toEqual({ connected: true, email: 'marketing@toko.test' });
    expect(await status('ai')).toEqual({ connected: false, email: null });

    // Disconnecting while in AI must not touch Marketing's calendar.
    const revoked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      revoked.push(String(url));
      return new Response('{}', { status: 200 });
    }));
    expect((await call('POST', '/v1/google-calendar/disconnect', { division: 'ai' })).statusCode).toBe(200);
    expect(revoked).toHaveLength(0);
    expect(await status()).toEqual({ connected: true, email: 'marketing@toko.test' });
  });

  /* -------------------------------------------------- provider settings */

  it('lists WhatsApp numbers per division', async () => {
    const { channelId } = await inDivision('ai', (ctx) => createWaBridgeChannel(ctx, { displayName: 'WA Web AI' }));
    const listed = async (division?: Division) => ids(await call('GET', '/v1/wa-bridge/channels', { division }));

    expect(await listed()).not.toContain(channelId);
    expect(await listed('ai')).toContain(channelId);
    expect((await call('POST', `/v1/wa-bridge/channels/${channelId}/disconnect`)).statusCode).toBe(404);
  });

  it('addresses each division\'s Facebook session separately, and never lends one Page to both', async () => {
    await inDivision('marketing', async (ctx) => {
      await setFbBridgeConnection(ctx, {
        status: 'ready', pageId: 'page-divapi', pageName: 'Toko Marketing', actorId: ownerId,
      });
      await ensureMessengerBridgeChannel(ctx, { pageId: 'page-divapi', pageName: 'Toko Marketing', status: 'connected' });
    });

    const bridge: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      bridge.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(JSON.stringify({ status: 'disconnected', pageId: null, pageName: null, lastError: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));

    const aiStatus = await call('GET', '/v1/facebook-bridge/status', { division: 'ai' });
    expect(aiStatus.statusCode).toBe(200);
    expect(bridge.at(-1)).toContain(`/internal/sessions/${t.tenantId}-ai/status`);
    expect((aiStatus.json() as { status: string }).status).toBe('disconnected');

    // The same Page cannot be connected to AI while Marketing holds it.
    const stolen = await call('POST', '/v1/facebook-bridge/connect', {
      division: 'ai', payload: { pageId: 'page-divapi', pageName: 'Toko Marketing' },
    });
    expect(stolen.statusCode).toBe(409);

    // Disconnecting AI leaves Marketing's Page and channel exactly as they were.
    expect((await call('POST', '/v1/facebook-bridge/disconnect', { division: 'ai' })).statusCode).toBe(200);
    expect(bridge.at(-1)).toContain(`/internal/sessions/${t.tenantId}-ai`);
    expect(bridge.some((b) => b.endsWith(`/internal/sessions/${t.tenantId}`))).toBe(false);

    const marketing = await inDivision('marketing', (ctx) => getFbBridgeConnection(ctx));
    expect(marketing).toMatchObject({ status: 'ready', pageId: 'page-divapi', sessionKey: t.tenantId });
    const [channel] = await withTenant(db, t.tenantId, (tx) => tx.query<{ division_id: string; status: string }>(
      `select division_id, status from channels where kind = 'messenger_bridge' and external_id = 'page-divapi'`));
    expect(channel).toEqual({ division_id: t.divisions.marketing, status: 'connected' });
  });

  it('addresses each division\'s Instagram session separately', async () => {
    const bridge: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      bridge.push(String(url));
      return new Response(JSON.stringify({ status: 'disconnected' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));

    await call('GET', '/v1/instagram-bridge/status', { division: 'ai' });
    expect(bridge.at(-1)).toContain(`/internal/sessions/${t.tenantId}-ai/`);
    await call('GET', '/v1/instagram-bridge/status');
    expect(bridge.at(-1)).toContain(`/internal/sessions/${t.tenantId}/`);
  });

  /* ------------------------------------------------------------ tenants */

  it('cannot reach another tenant through the division header', async () => {
    const [aiConversation] = ids(await call('GET', '/v1/conversations', { division: 'ai' }));
    expect((await call('GET', `/v1/conversations/${aiConversation}`, { division: 'ai', as: otherToken })).statusCode)
      .toBe(404);
    expect(ids(await call('GET', '/v1/conversations', { division: 'ai', as: otherToken }))).toEqual([]);
  });
});
