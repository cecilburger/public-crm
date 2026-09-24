import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env } from '@kirana/core';
import {
  withTenant, recordFacebookComment,
  claimCommentForPublicReply, markCommentPublicReplied, markCommentPublicReplyFailed,
  claimCommentForDm, markCommentDmSent, markCommentDmFailed, clearCommentDmError, getFacebookComment,
  type Database,
} from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { COMMENT_REPLY_QUEUE, COMMENT_DM_QUEUE } from '../apps/worker/src/processors/facebookComments.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

const PAGE = { id: '900000000000001', name: 'Toko Demo' };
const POST = '998877665544';
const PASSWORD = 'correct horse battery staple';
const MEMBER_PASSWORD = 'another long password';

/**
 * The API side of acting on a Facebook comment. Nothing here reaches Facebook,
 * a bridge or the worker: the routes enqueue, and the queue is a spy. What is
 * under test is who may ask, which comments may be asked about, and that the
 * job that comes out names the right queue with the payload the worker's
 * processor expects — the row id, not Facebook's comment id.
 */

interface QueuedJob { queue: string; payload: unknown }

describe('asking for a comment to be acted on', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let agentToken: string;
  let viewerToken: string;
  const jobs: QueuedJob[] = [];
  let seq = 0;

  const login = async (workspace: string, email: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { workspace, email, password } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbroutes');
    other = await makeTenant(db, 'fbother');

    app = buildApp({
      db, control: db, kek: TEST_KEK, env: env(),
      dispatch: async ({ queue, payload }) => { jobs.push({ queue, payload }); },
    });
    await app.ready();

    // The owner only exists to seed the two roles the routes distinguish
    // between; every request below is made as one of those.
    const ownerToken = await login('fbroutes', 'owner@fbroutes.test', PASSWORD);
    for (const member of [
      { email: 'agent@fbroutes.test', name: 'Agent', role: 'agent' },
      { email: 'viewer@fbroutes.test', name: 'Viewer', role: 'viewer' },
    ]) {
      const created = await app.inject({
        method: 'POST', url: '/v1/members', headers: { authorization: `Bearer ${ownerToken}` },
        payload: { ...member, password: MEMBER_PASSWORD },
      });
      expect(created.statusCode).toBe(201);
    }
    agentToken = await login('fbroutes', 'agent@fbroutes.test', MEMBER_PASSWORD);
    viewerToken = await login('fbroutes', 'viewer@fbroutes.test', MEMBER_PASSWORD);
  });

  afterAll(async () => { await app.close(); await db.close(); });

  beforeEach(() => { jobs.length = 0; });

  /* --------------------------------------------------------- helpers */

  const ctxFor = (tenant: TestTenant) =>
    (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => ({ tx, tenantId: tenant.tenantId, kek: TEST_KEK });

  /** A fresh comment at 'new', in whichever tenant is asked for. */
  const given = async (tenant: TestTenant = t) => {
    seq += 1;
    const row = await withTenant(db, tenant.tenantId, (tx) =>
      recordFacebookComment(ctxFor(tenant)(tx), {
        pageId: PAGE.id, pageName: PAGE.name, postId: POST, commentId: `80000000000${seq}`,
        authorExternalId: `10000000000${seq}`, authorName: 'Budi Santoso',
        body: 'mau tau jasa ini gimana?', commentedAt: new Date(1789000000_000 + seq),
      }));
    return row.id;
  };

  /** Walks a fresh comment through the real transitions to the state asked for. */
  const givenAt = async (state: 'public_replied' | 'dm_sent' | 'failed' | 'dm_failed' | 'public_reply_pending') => {
    const id = await given();
    const step = (fn: (c: ReturnType<ReturnType<typeof ctxFor>>, a: { id: string; reason: string }) => Promise<boolean>, reason = '') =>
      withTenant(db, t.tenantId, (tx) => fn(ctxFor(t)(tx), { id, reason }));

    await step(claimCommentForPublicReply);
    if (state === 'public_reply_pending') return id;
    if (state === 'failed') {
      await step(markCommentPublicReplyFailed, 'tombol balas tidak ditemukan');
      return id;
    }
    await step(markCommentPublicReplied);
    if (state === 'public_replied') return id;
    await step(claimCommentForDm);
    if (state === 'dm_sent') await step(markCommentDmSent);
    if (state === 'dm_failed') await step(markCommentDmFailed, 'Facebook tidak menyediakan pesan pribadi untuk komentar ini');
    return id;
  };

  const statusOf = async (id: string) => {
    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string }>('select status from facebook_comments where tenant_id = $1 and id = $2', [t.tenantId, id]));
    return rows[0]!.status;
  };

  const auditRows = (action: string) => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ actor_id: string; resource_id: string }>(
      'select actor_id, resource_id from audit_events where tenant_id = $1 and action = $2', [t.tenantId, action]));

  const act = (
    kind: 'reply-public' | 'send-dm', id: string,
    opts: { token?: string | null; text?: unknown } = {},
  ) => app.inject({
    method: 'POST', url: `/v1/facebook-bridge/comments/${id}/${kind}`,
    headers: opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? agentToken}` },
    payload: { text: 'text' in opts ? opts.text : 'Check DM ya kak!!!' },
  });

  const detailOf = (res: { json: () => unknown }) => (res.json() as { detail?: string }).detail ?? '';

  /* ------------------------------------------------------ who may ask */

  it('refuses anyone who is not signed in', async () => {
    const id = await given();

    expect((await act('reply-public', id, { token: null })).statusCode).toBe(401);
    expect((await act('send-dm', id, { token: null })).statusCode).toBe(401);
    expect(jobs).toEqual([]);
  });

  it('refuses a viewer, who reads the inbox but does not speak for the Page', async () => {
    const id = await given();

    expect((await act('reply-public', id, { token: viewerToken })).statusCode).toBe(403);
    expect((await act('send-dm', id, { token: viewerToken })).statusCode).toBe(403);
    expect(jobs).toEqual([]);
  });

  it('still lets that viewer read the inbox comments', async () => {
    // The action routes take conversation:write; the listing keeps its
    // conversation:read guard, or adding the actions would have taken the
    // inbox away from exactly the people who only look at it.
    const res = await app.inject({
      method: 'GET', url: '/v1/inbox/comments', headers: { authorization: `Bearer ${viewerToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray((res.json() as { comments: unknown[] }).comments)).toBe(true);
  });

  /* ----------------------------------------------------- which comment */

  it('answers 404 for another tenant\'s comment', async () => {
    // Row-level security hides the row, so the route cannot tell somebody
    // else's id from a wrong one — and must not, or ids would leak across tenants.
    const foreign = await given(other);

    expect((await act('reply-public', foreign)).statusCode).toBe(404);
    expect((await act('send-dm', foreign)).statusCode).toBe(404);
    expect(jobs).toEqual([]);
  });

  it('answers 404 for an id that is not a comment at all', async () => {
    expect((await act('reply-public', 'not-a-uuid')).statusCode).toBe(404);
    expect((await act('reply-public', '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect(jobs).toEqual([]);
  });

  /* ---------------------------------------------------- the public reply */

  it('queues a public reply for a new comment, and only queues it', async () => {
    const id = await given();

    const res = await act('reply-public', id, { text: 'Check DM ya kak!!!' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: true });
    // One job, on the worker's reply queue, carrying the row id the claim takes.
    expect(jobs).toEqual([{
      queue: COMMENT_REPLY_QUEUE,
      payload: { tenantId: t.tenantId, commentId: id, text: 'Check DM ya kak!!!' },
    }]);
    expect(COMMENT_REPLY_QUEUE).toBe('facebook.comment.reply');
    // The status is the processor's to move. A route that moved it would race
    // the claim, or mark replied something the bridge then refused.
    expect(await statusOf(id)).toBe('new');
  });

  it('records which agent asked for the reply', async () => {
    const id = await given();
    await act('reply-public', id);

    const rows = await auditRows('facebook_comment.reply_requested');

    expect(rows.map((r) => r.resource_id)).toContain(id);
  });

  it('refuses a public reply once the comment already has one', async () => {
    const id = await givenAt('dm_sent');

    const res = await act('reply-public', id);

    expect(res.statusCode).toBe(409);
    expect(detailOf(res)).toContain('sudah dibalas');
    expect(jobs).toEqual([]);
    expect(await statusOf(id)).toBe('dm_sent');
  });

  it('refuses a public reply while one is already in flight', async () => {
    // A double-click. The claim would refuse the second job anyway; the agent
    // should hear that now rather than see nothing happen.
    const id = await givenAt('public_reply_pending');

    const res = await act('reply-public', id);

    expect(res.statusCode).toBe(409);
    expect(detailOf(res)).toContain('sedang diproses');
    expect(jobs).toEqual([]);
  });

  it('refuses to retry a failed public reply, and says why it failed', async () => {
    // Terminal by design: the claim only takes 'new', and retyping a reply the
    // bridge typed but never saw is how a customer's post ends up with two. A
    // 202 here would enqueue a job that quietly does nothing; the stored error
    // is the useful answer.
    const id = await givenAt('failed');

    const res = await act('reply-public', id);

    expect(res.statusCode).toBe(409);
    expect(detailOf(res)).toContain('tombol balas tidak ditemukan');
    expect(jobs).toEqual([]);
    expect(await statusOf(id)).toBe('failed');
  });

  /* -------------------------------------------------- the private message */

  it('queues a private message once the public reply is on record', async () => {
    const id = await givenAt('public_replied');

    const res = await act('send-dm', id, { text: 'Halo kak, boleh kami bantu lewat DM ya.' });

    expect(res.statusCode).toBe(202);
    expect(jobs).toEqual([{
      queue: COMMENT_DM_QUEUE,
      payload: { tenantId: t.tenantId, commentId: id, text: 'Halo kak, boleh kami bantu lewat DM ya.' },
    }]);
    expect(COMMENT_DM_QUEUE).toBe('facebook.comment.dm');
    expect(await statusOf(id)).toBe('public_replied');
    expect((await auditRows('facebook_comment.dm_requested')).map((r) => r.resource_id)).toContain(id);
  });

  it('refuses a private message before the public reply exists', async () => {
    const id = await given();

    const res = await act('send-dm', id);

    expect(res.statusCode).toBe(409);
    expect(detailOf(res)).toContain('secara publik dulu');
    expect(jobs).toEqual([]);
    expect(await statusOf(id)).toBe('new');
  });

  it('refuses a second private message once one has been sent', async () => {
    const id = await givenAt('dm_sent');

    const res = await act('send-dm', id);

    expect(res.statusCode).toBe(409);
    expect(detailOf(res)).toContain('sudah terkirim');
    expect(jobs).toEqual([]);
  });

  it('lets a person try a private message again after one failed', async () => {
    // Terminal for the automated sweep, not for an agent. `claimCommentForDm`
    // refuses while dm_error is set — a loop must never re-send to a customer
    // on its own — so the manual route clears it first. Refusing the person
    // too left the comment behind an enabled button that could never do
    // anything, which is what happened live.
    const id = await givenAt('dm_failed');

    const res = await act('send-dm', id);

    expect(res.statusCode).toBe(202);
    expect(jobs).toHaveLength(1);
  });

  it('refuses a private message for a comment whose public reply failed', async () => {
    const id = await givenAt('failed');

    const res = await act('send-dm', id);

    expect(res.statusCode).toBe(409);
    expect(jobs).toEqual([]);
  });

  /* ------------------------------------------------------------- the body */

  it('refuses text the bridge could not type', async () => {
    // Every authenticated route reports a bad body as a 422 problem document
    // (`invalid()`), not a bare 400 — the 400s in this API are reserved for
    // machine-facing webhook routes with no client to read a message.
    const id = await given();

    for (const text of ['x'.repeat(2001), '', '   ', undefined, 42]) {
      const res = await act('reply-public', id, { text });
      expect(res.statusCode).toBe(422);
    }
    expect((await act('send-dm', id, { text: 'x'.repeat(2001) })).statusCode).toBe(422);
    expect(jobs).toEqual([]);
    expect(await statusOf(id)).toBe('new');
  });

  it('accepts text right at the limit', async () => {
    const id = await given();

    expect((await act('reply-public', id, { text: 'x'.repeat(2000) })).statusCode).toBe(202);
    expect(jobs).toHaveLength(1);
  });
});

/* ------------------------------- "connected" has to mean the channel exists */

describe('reading the Facebook connection status', () => {
  /**
   * The trap this closes, confirmed live: the bridge's Chromium profile
   * outlives the CRM database, so `/status` wrote a 'ready' connection row
   * while the channel row — created only by `/connect` — never existed. The
   * console then showed "connected", hid the connect form, and left only
   * Disconnect (which deletes the logged-in profile), while every inbound
   * message failed in the worker with "no messenger_bridge channel".
   */
  let db: Database;
  let app: FastifyInstance;

  /** The bridge, answering from a profile on its own disk. */
  // Each tenant gets its own Page id: `channels` is unique on
  // `(kind, external_id)` ACROSS tenants, so one Facebook Page belongs to one
  // workspace. Reusing an id here would make the second tenant's insert a
  // silent no-op and the test would be measuring that rule, not this fix.
  const bridgeSays = (status: string, pageId: string) => vi.stubGlobal('fetch', async () => new Response(
    JSON.stringify({ status, pageId, pageName: PAGE.name, lastError: null }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));

  const tokenFor = async (slug: string) => {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: slug, email: `owner@${slug}.test`, password: PASSWORD },
    });
    return (res.json() as { accessToken: string }).accessToken;
  };

  const channelsOf = (tenantId: string) => withTenant(db, tenantId, (tx) =>
    tx.query<{ id: string }>(
      `select id from channels where tenant_id = $1 and kind = 'messenger_bridge'`, [tenantId]));

  beforeAll(async () => {
    db = await freshDb();
    app = buildApp({ db, control: db, kek: TEST_KEK, env: env(), dispatch: async () => {} });
    await app.ready();
  });

  afterAll(async () => { vi.unstubAllGlobals(); await app.close(); await db.close(); });

  it('creates the channel when the bridge reports a live session', async () => {
    const t = await makeTenant(db, 'fbstatus');
    const token = await tokenFor('fbstatus');
    expect(await channelsOf(t.tenantId)).toHaveLength(0);

    bridgeSays('ready', '900000000000101');
    const res = await app.inject({
      method: 'GET', url: '/v1/facebook-bridge/status', headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(await channelsOf(t.tenantId)).toHaveLength(1);
  });

  it('does not create a second one when it is read again', async () => {
    const t = await makeTenant(db, 'fbstatustwice');
    const token = await tokenFor('fbstatustwice');

    bridgeSays('ready', '900000000000102');
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'GET', url: '/v1/facebook-bridge/status', headers: { authorization: `Bearer ${token}` },
      });
    }

    expect(await channelsOf(t.tenantId)).toHaveLength(1);
  });

  it('creates nothing while the session is not live', async () => {
    const t = await makeTenant(db, 'fbcheckpoint');
    const token = await tokenFor('fbcheckpoint');

    bridgeSays('checkpoint_required', '900000000000103');
    await app.inject({
      method: 'GET', url: '/v1/facebook-bridge/status', headers: { authorization: `Bearer ${token}` },
    });

    expect(await channelsOf(t.tenantId)).toHaveLength(0);
  });
});

/* ------------------------- a failed private message an agent may try again */

describe('retrying a private message that failed', () => {
  /**
   * The rule this pins: a recorded DM failure is terminal for the AUTOMATED
   * sweep and not for a person. `claimCommentForDm` refuses while `dm_error`
   * is set — a loop must never re-send to a customer on its own — so the
   * manual route clears it first. Without that the comment sat forever behind
   * an enabled button that could never do anything, confirmed live after the
   * environmental cause had already been fixed.
   */
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let token: string;
  let n = 0;
  const jobs: { queue: string; payload: unknown }[] = [];

  const ctxOf = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
    ({ tx, tenantId: t.tenantId, kek: TEST_KEK });

  /** A comment walked through the real transitions to "the DM failed". */
  const failedDm = async () => {
    n += 1;
    const { id } = await withTenant(db, t.tenantId, (tx) =>
      recordFacebookComment(ctxOf(tx), {
        pageId: PAGE.id, pageName: PAGE.name, postId: POST, commentId: `81000000000${n}`,
        authorExternalId: `11000000000${n}`, authorName: 'Budi Santoso',
        body: 'mau tau jasa ini gimana?', commentedAt: new Date(1789000000_000 + n),
      }));
    await withTenant(db, t.tenantId, async (tx) => {
      await claimCommentForPublicReply(ctxOf(tx), { id });
      await markCommentPublicReplied(ctxOf(tx), { id });
      await claimCommentForDm(ctxOf(tx), { id });
      await markCommentDmFailed(ctxOf(tx), { id, reason: 'Facebook menolak' });
    });
    return id;
  };

  const rowOf = (id: string) => withTenant(db, t.tenantId, (tx) =>
    getFacebookComment(ctxOf(tx), { id }));

  const sendDm = (id: string, text = 'halo kak') => app.inject({
    method: 'POST', url: `/v1/facebook-bridge/comments/${id}/send-dm`,
    headers: { authorization: `Bearer ${token}` }, payload: { text },
  });

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbdmretry');
    app = buildApp({
      db, control: db, kek: TEST_KEK, env: env(),
      dispatch: async (job) => { jobs.push(job as { queue: string; payload: unknown }); },
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'fbdmretry', email: 'owner@fbdmretry.test', password: PASSWORD },
    });
    token = (res.json() as { accessToken: string }).accessToken;
  });

  afterAll(async () => { await app.close(); await db.close(); });
  beforeEach(() => { jobs.length = 0; });

  it('clears the recorded failure and queues the job', async () => {
    const id = await failedDm();
    expect((await rowOf(id))?.dmError).toBe('Facebook menolak');

    expect((await sendDm(id)).statusCode).toBe(202);

    expect((await rowOf(id))?.dmError).toBeNull();
    expect(jobs).toHaveLength(1);
  });

  it('leaves the claim able to take it, where before it could not', async () => {
    const id = await failedDm();
    // The worker on the untouched row: refused, exactly as the sweep must be.
    expect(await withTenant(db, t.tenantId, (tx) => claimCommentForDm(ctxOf(tx), { id }))).toBe(false);

    await withTenant(db, t.tenantId, (tx) => clearCommentDmError(ctxOf(tx), { id }));

    expect(await withTenant(db, t.tenantId, (tx) => claimCommentForDm(ctxOf(tx), { id }))).toBe(true);
  });

  it('still refuses once the message has actually been delivered', async () => {
    const id = await failedDm();
    await withTenant(db, t.tenantId, async (tx) => {
      await clearCommentDmError(ctxOf(tx), { id });
      await claimCommentForDm(ctxOf(tx), { id });
      await markCommentDmSent(ctxOf(tx), { id });
    });

    // A delivered message is the one thing no retry may undo.
    expect((await sendDm(id, 'halo lagi')).statusCode).toBe(409);
    expect(jobs).toHaveLength(0);
  });
});
