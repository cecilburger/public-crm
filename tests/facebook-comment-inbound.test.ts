import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env, bridgeSessionKey, type Env } from '@kirana/core';
import { withTenant, withoutTenant, listFacebookComments, type Database } from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { webhookEvents } from '../apps/api/src/metrics.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * One Facebook comment, end to end: the bridge's webhook, the spool, the
 * worker's normaliser, the `facebook_comments` row, the bridge's "what do you
 * already hold" read, and the console's inbox — in the division whose session
 * reported it, and nowhere else.
 *
 * Ids are shaped like the live Page's: a post is a `pfbid0…` permalink token,
 * a comment a 16-digit number. Nothing here talks to Facebook or a bridge.
 */

const PASSWORD = 'correct horse battery staple';
const MARKETING_PAGE = { id: '100064512345678', name: 'Toko Demo' };
const AI_PAGE = { id: '100064587654321', name: 'Toko Demo AI' };
const POST_ID = 'pfbid02Xk9vQm7LsT4hRcN8yPzW3aBfGdE6jKuV1oYiMnHq5tS2wLxCz7rAeD9gFbJpUl';
const AUTHOR = { id: '100089912345678', name: 'Budi Santoso' };
const COMMENTED_AT = '2026-09-25T03:00:00.000Z';
const AT = '2026-09-25T03:00:05.000Z';

type Division = 'marketing' | 'ai';

interface CommentFields {
  commentId: string; postId: string; parentCommentId: string | null; authorId: string | null;
  authorName: string; text: string; commentedAt: string | null; pageId: string; pageName: string;
}

interface InboxComment {
  id: string; divisionId: string; commentId: string; postId: string; pageId: string;
  parentCommentId: string | null; body: string; authorName: string | null; status: string;
}

describe('a Facebook comment reaching the CRM from the bridge', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let e: Env;
  let token: string;
  let aiKey: string;
  let seq = 0;
  const jobs: string[] = [];
  /** The worker's structured lines (`fb_comment_persisted` and friends), captured instead of printed. */
  const workerLog: Record<string, unknown>[] = [];

  /** A fresh comment id per call, so no test sees another's row as its own. */
  const nextCommentId = () => String(1_789_000_000_000_000n + BigInt(++seq));

  /** The exact payload `apps/fb-bridge` posts for one comment. */
  const commentEvent = (
    fields: Partial<CommentFields> & { commentId: string },
    opts: { sessionKey?: string | null } = {},
  ) => ({
    tenantId: t.tenantId, event: 'comment',
    ...(opts.sessionKey === null ? {} : { sessionKey: opts.sessionKey ?? t.tenantId }),
    at: AT,
    comment: {
      postId: POST_ID, parentCommentId: null, authorId: AUTHOR.id, authorName: AUTHOR.name,
      text: 'Ada size M kak?', commentedAt: COMMENTED_AT,
      pageId: MARKETING_PAGE.id, pageName: MARKETING_PAGE.name, ...fields,
    },
  });

  const aiCommentEvent = (fields: Partial<CommentFields> & { commentId: string }) =>
    commentEvent({ pageId: AI_PAGE.id, pageName: AI_PAGE.name, ...fields }, { sessionKey: aiKey });

  const deliver = (body: unknown) => app.inject({
    method: 'POST', url: '/v1/webhooks/fb-bridge',
    headers: { authorization: `Bearer ${e.FB_BRIDGE_SECRET}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  const askKnown = (body: unknown, secret?: string) => app.inject({
    method: 'POST', url: '/v1/webhooks/fb-bridge/known',
    headers: { authorization: `Bearer ${secret ?? e.FB_BRIDGE_SECRET}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  const inbox = async (division?: Division) => {
    const res = await app.inject({
      method: 'GET', url: '/v1/inbox/comments',
      headers: { authorization: `Bearer ${token}`, ...(division ? { 'x-division': division } : {}) },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { comments: InboxComment[] }).comments;
  };

  /** Every row for one Facebook comment id, across the whole tenant. */
  const storedRows = (commentId: string) => withTenant(db, t.tenantId, (tx) =>
    tx.query<{
      id: string; division_id: string; post_id: string; page_id: string; parent_comment_id: string | null;
      status: string; body_enc: string | null; author_name_enc: string | null;
    }>(
      `select id, division_id, post_id, page_id, parent_comment_id, status, body_enc, author_name_enc
         from facebook_comments where tenant_id = $1 and comment_id = $2`,
      [t.tenantId, commentId]));

  /** The read path the console and the API use, pinned to one division. */
  const listed = (division: Division) => withTenant(db, t.tenantId, (tx) =>
    listFacebookComments({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { limit: 200 }),
  { divisionId: t.divisions[division] });

  const spooled = (sessionKey: string, commentId: string) =>
    withoutTenant(db, 'reading the webhook spool in a test', (tx) =>
      tx.query<{ id: string; status: string }>(
        `select id, status from webhook_events where provider = 'fb_bridge' and external_id = $1`,
        [`fb_comment:${sessionKey}:${commentId}`]));

  const counted = async (outcome: string) =>
    (await webhookEvents.get()).values
      .find((v) => v.labels.provider === 'fb_bridge' && v.labels.outcome === outcome)?.value ?? 0;

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbinbound');
    e = env();
    aiKey = bridgeSessionKey(t.tenantId, 'ai');

    app = buildApp({
      db, control: db, kek: TEST_KEK, env: e,
      // The queue runs inline, so one injected request exercises the whole path.
      dispatch: async ({ queue, payload }) => {
        jobs.push(queue);
        if (queue !== 'inbound.normalise') return;
        await processInboundWebhook(
          { db, control: db, kek: TEST_KEK, dispatch: async () => {} },
          (payload as { webhookEventId: string }).webhookEventId,
        );
      },
    });
    await app.ready();

    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'fbinbound', email: 'owner@fbinbound.test', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { accessToken: string }).accessToken;
  });

  afterAll(async () => { await app.close(); await db.close(); });
  beforeEach(() => {
    jobs.length = 0;
    workerLog.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] !== 'string' || !args[0].startsWith('{')) return;
      try { workerLog.push(JSON.parse(args[0]) as Record<string, unknown>); } catch { /* not a structured line */ }
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /* ---------------------------------------------------------- one comment */

  it('stores a Marketing session\'s comment once, in Marketing, readable as it was written', async () => {
    const commentId = nextCommentId();

    const res = await deliver(commentEvent({ commentId }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(jobs).toEqual(['inbound.normalise']);

    const rows = await storedRows(commentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      division_id: t.divisions.marketing, post_id: POST_ID, page_id: MARKETING_PAGE.id,
      parent_comment_id: null, status: 'new',
    });
    // Sealed at rest: neither the words nor the name are in the row as text.
    expect(rows[0]!.body_enc).not.toContain('Ada size M kak?');
    expect(rows[0]!.author_name_enc).not.toContain(AUTHOR.name);

    const comment = (await listed('marketing')).find((c) => c.commentId === commentId);
    expect(comment).toMatchObject({
      id: rows[0]!.id, divisionId: t.divisions.marketing, commentId, postId: POST_ID,
      pageId: MARKETING_PAGE.id, pageName: MARKETING_PAGE.name, parentCommentId: null,
      authorExternalId: AUTHOR.id, authorName: AUTHOR.name, body: 'Ada size M kak?',
      commentedAt: new Date(COMMENTED_AT), status: 'new',
    });

    // The worker's trace names the row it wrote, by ids only.
    const persisted = workerLog.filter((l) => l.event === 'fb_comment_persisted');
    expect(persisted).toEqual([expect.objectContaining({
      tenantId: t.tenantId, divisionId: t.divisions.marketing, commentId, postId: POST_ID,
      parentCommentId: null, rowId: rows[0]!.id,
    })]);
    expect(JSON.stringify(persisted)).not.toContain('Ada size M kak?');
    expect(JSON.stringify(persisted)).not.toContain(AUTHOR.name);
  });

  it('keeps the comment a reply answers', async () => {
    const parentId = nextCommentId();
    const replyId = nextCommentId();

    expect((await deliver(commentEvent({ commentId: parentId }))).statusCode).toBe(200);
    expect((await deliver(commentEvent({
      commentId: replyId, parentCommentId: parentId, authorId: '100089987654321', authorName: 'Siti Aminah',
      text: 'Saya juga mau tanya kak',
    }))).statusCode).toBe(200);

    expect((await storedRows(parentId))[0]!.parent_comment_id).toBeNull();
    expect((await storedRows(replyId))[0]!.parent_comment_id).toBe(parentId);

    const repo = await listed('marketing');
    expect(repo.find((c) => c.commentId === replyId)).toMatchObject({
      parentCommentId: parentId, body: 'Saya juga mau tanya kak', authorName: 'Siti Aminah',
    });
    expect(repo.find((c) => c.commentId === parentId)!.parentCommentId).toBeNull();

    const api = await inbox();
    expect(api.find((c) => c.commentId === replyId)).toMatchObject({ parentCommentId: parentId, postId: POST_ID });
    expect(api.find((c) => c.commentId === parentId)).toMatchObject({ parentCommentId: null });
  });

  /* ---------------------------------------------------------- redelivery */

  it('stores a comment re-sent after a restart once, and turns the repeat away at the spool', async () => {
    const commentId = nextCommentId();
    const payload = commentEvent({ commentId });
    const accepted = await counted('accepted');
    const duplicate = await counted('duplicate');

    expect((await deliver(payload)).statusCode).toBe(200);
    expect((await deliver(payload)).statusCode).toBe(200);
    // A bridge from before divisions sends no session key; for Marketing that
    // is the same event under the same spool key.
    expect((await deliver(commentEvent({ commentId }, { sessionKey: null }))).statusCode).toBe(200);

    expect(await storedRows(commentId)).toHaveLength(1);
    expect(jobs).toEqual(['inbound.normalise']);
    expect(await spooled(t.tenantId, commentId)).toEqual([{ id: expect.any(String), status: 'processed' }]);
    expect(await counted('accepted')).toBe(accepted + 1);
    expect(await counted('duplicate')).toBe(duplicate + 2);
  });

  it('lets a failed spool row be retried without storing the comment twice', async () => {
    const commentId = nextCommentId();
    expect((await deliver(commentEvent({ commentId }))).statusCode).toBe(200);
    const [first] = await storedRows(commentId);

    // The one case the spool lets through again; the worker's own dedupe
    // on (tenant, comment id) is what has to hold.
    await withoutTenant(db, 'failing a spool row in a test', (tx) => tx.query(
      `update webhook_events set status = 'failed', error = 'test' where provider = 'fb_bridge' and external_id = $1`,
      [`fb_comment:${t.tenantId}:${commentId}`]));
    workerLog.length = 0;
    expect((await deliver(commentEvent({ commentId }))).statusCode).toBe(200);

    expect(jobs).toEqual(['inbound.normalise', 'inbound.normalise']);
    expect(await storedRows(commentId)).toEqual([first]);
    expect(workerLog.filter((l) => l.event === 'fb_comment_duplicate'))
      .toEqual([expect.objectContaining({ commentId, rowId: first!.id })]);
    expect(workerLog.some((l) => l.event === 'fb_comment_persisted')).toBe(false);
  });

  it('stores a comment whose first attempt was lost after the spool claimed it', async () => {
    const commentId = nextCommentId();
    // The worker marks the spool row processed before it does the work; one
    // that died in between left a claimed row and no comment. The bridge keeps
    // offering it (the CRM says it does not hold it), and that offer must land.
    await withoutTenant(db, 'spooling a lost comment in a test', (tx) => tx.query(
      `insert into webhook_events (provider, external_id, signature_ok, payload, status, processed_at)
       values ('fb_bridge', $1, true, '{}'::jsonb, 'processed', now())`,
      [`fb_comment:${t.tenantId}:${commentId}`]));
    expect(await storedRows(commentId)).toHaveLength(0);

    expect((await deliver(commentEvent({ commentId }))).statusCode).toBe(200);

    expect(jobs).toEqual(['inbound.normalise']);
    expect(await storedRows(commentId)).toHaveLength(1);
    expect(await spooled(t.tenantId, commentId)).toEqual([{ id: expect.any(String), status: 'processed' }]);
    // …and once it is stored, a further offer is the plain duplicate it always was.
    jobs.length = 0;
    expect((await deliver(commentEvent({ commentId }))).statusCode).toBe(200);
    expect(jobs).toEqual([]);
    expect(await storedRows(commentId)).toHaveLength(1);
  });

  /* ------------------------------------------------- what the CRM holds */

  it('tells the bridge exactly which comment ids it already holds', async () => {
    const a = nextCommentId();
    const b = nextCommentId();
    const neverSent = nextCommentId();
    for (const commentId of [a, b]) expect((await deliver(commentEvent({ commentId }))).statusCode).toBe(200);

    const res = await askKnown({
      tenantId: t.tenantId, sessionKey: t.tenantId, externalIds: [], commentIds: [a, neverSent, b],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { known: string[]; knownComments: string[] };
    expect([...body.knownComments].sort()).toEqual([a, b].sort());
    expect(body.known).toEqual([]);

    const none = await askKnown({ tenantId: t.tenantId, sessionKey: t.tenantId, externalIds: [], commentIds: [neverSent] });
    expect(none.statusCode).toBe(200);
    expect((none.json() as { knownComments: string[] }).knownComments).toEqual([]);
  });

  it('refuses the known-ids read without the shared secret', async () => {
    const res = await askKnown({ tenantId: t.tenantId, externalIds: [], commentIds: [nextCommentId()] }, 'wrong');

    expect(res.statusCode).toBe(401);
  });

  it('still answers a bridge that asks only about message ids', async () => {
    const res = await askKnown({ tenantId: t.tenantId, externalIds: [`fb_dm:${t.tenantId}:mid.$neverSeen`] });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ known: [], knownComments: [] });
    // Message ids are still the required half of the request.
    expect((await askKnown({ tenantId: t.tenantId, commentIds: [nextCommentId()] })).statusCode).toBe(400);
  });

  /* ------------------------------------------------------------ the inbox */

  it('shows each division\'s comment in that division\'s inbox and nowhere else', async () => {
    const marketingId = nextCommentId();
    const aiId = nextCommentId();
    expect((await deliver(commentEvent({ commentId: marketingId }))).statusCode).toBe(200);
    expect((await deliver(aiCommentEvent({ commentId: aiId, text: 'harga berapa kak?' }))).statusCode).toBe(200);

    const [marketingRow] = await storedRows(marketingId);
    const [aiRow] = await storedRows(aiId);
    expect(marketingRow!.division_id).toBe(t.divisions.marketing);
    expect(aiRow).toMatchObject({ division_id: t.divisions.ai, page_id: AI_PAGE.id, status: 'new' });

    for (const view of [await inbox(), await inbox('marketing')]) {
      expect(view.find((c) => c.commentId === marketingId)).toMatchObject({
        id: marketingRow!.id, divisionId: t.divisions.marketing, postId: POST_ID, pageId: MARKETING_PAGE.id,
        parentCommentId: null, body: 'Ada size M kak?', status: 'new',
      });
      expect(view.map((c) => c.commentId)).not.toContain(aiId);
      expect(view.every((c) => c.divisionId === t.divisions.marketing)).toBe(true);
    }

    const ai = await inbox('ai');
    expect(ai).toEqual([expect.objectContaining({
      id: aiRow!.id, divisionId: t.divisions.ai, commentId: aiId, pageId: AI_PAGE.id,
      parentCommentId: null, body: 'harga berapa kak?',
    })]);

    // The bridge's read follows the same session: each asks only its own Page's.
    const knownBy = async (sessionKey: string) => ((await askKnown({
      tenantId: t.tenantId, sessionKey, externalIds: [], commentIds: [marketingId, aiId],
    })).json() as { knownComments: string[] }).knownComments;
    expect(await knownBy(aiKey)).toEqual([aiId]);
    expect(await knownBy(t.tenantId)).toEqual([marketingId]);
  });

  /* ------------------------------------------------------------- refused */

  it('refuses a comment missing its Page or its text, and stores nothing', async () => {
    const invalid = await counted('invalid_payload');
    const broken = [
      { commentId: nextCommentId(), pageId: undefined },
      { commentId: nextCommentId(), text: undefined },
      { commentId: nextCommentId(), text: '' },
    ];

    for (const fields of broken) {
      const res = await deliver(commentEvent(fields as Partial<CommentFields> & { commentId: string }));
      expect(res.statusCode, JSON.stringify(fields)).toBe(400);
      expect(await storedRows(fields.commentId)).toEqual([]);
      expect(await spooled(t.tenantId, fields.commentId)).toEqual([]);
    }
    expect(jobs).toEqual([]);
    expect(await counted('invalid_payload')).toBe(invalid + broken.length);
  });
});
