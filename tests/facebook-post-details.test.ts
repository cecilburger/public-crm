import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env, bridgeSessionKey, type Env } from '@kirana/core';
import { withTenant, type Database } from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { groupCommentsByPost } from '../apps/console/lib/inbox.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * A Facebook post's caption and age, from the bridge to the inbox.
 *
 * The bridge reads them off the Page timeline it already reloads every minute
 * and hands them to `/v1/webhooks/fb-bridge/posts`; the inbox listing carries
 * them on every comment, so the console can name a comment group after its
 * post. `post_id` stays the identity: details are looked up by it, never the
 * other way round.
 */

const PASSWORD = 'correct horse battery staple';
const MARKETING_PAGE = { id: '100064512345678', name: 'Toko Demo' };
const AI_PAGE = { id: '100064587654321', name: 'Toko Demo AI' };
const POST = 'pfbid02Xk9vQm7LsT4hRcN8yPzW3aBfGdE6jKuV1oYiMnHq5tS2wLxCz7rAeD9gFbJpUl';
const RENAMED = 'pfbid0NewSlugAfterFacebookReissuedItQm7LsT4hRcN8yPzW3aBfGdE6jKuV1oY';
const OTHER = 'pfbid0AnotherPostWithNoDetailsYetXk9vQm7LsT4hRcN8yPzW3aBfGdE6jKuV1o';
const AI_POST = 'pfbid0AiDivisionPostXk9vQm7LsT4hRcN8yPzW3aBfGdE6jKuV1oYiMnHq5tS2wL';
const AUTHOR = { id: '100089912345678', name: 'Gabe' };
/** The precise age, read while the post was minutes old, and a coarser one read two days later. */
const PRECISE = '2026-09-24T03:12:00.000Z';
const COARSE = '2026-09-24T09:00:00.000Z';

interface InboxComment {
  id: string; commentId: string; postId: string; divisionId: string; body: string;
  status: string; commentedAt: string | null; createdAt: string;
  postText?: string | null; postCreatedAt?: string | null;
}

describe("a Facebook post's caption and age, from the bridge to the inbox", () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let e: Env;
  let token: string;
  let aiKey: string;
  let seq = 0;
  const nextCommentId = () => String(1_789_500_000_000_000n + BigInt(++seq));

  const deliverComment = (commentId: string, postId: string, opts: { ai?: boolean } = {}) => app.inject({
    method: 'POST', url: '/v1/webhooks/fb-bridge',
    headers: { authorization: `Bearer ${e.FB_BRIDGE_SECRET}`, 'content-type': 'application/json' },
    payload: JSON.stringify({
      tenantId: t.tenantId, event: 'comment', sessionKey: opts.ai ? aiKey : t.tenantId, at: '2026-09-26T03:00:05.000Z',
      comment: {
        commentId, postId, parentCommentId: null, authorId: AUTHOR.id, authorName: AUTHOR.name,
        text: `rt tes ${commentId.slice(-3)}`, commentedAt: '2026-09-26T03:00:00.000Z',
        pageId: opts.ai ? AI_PAGE.id : MARKETING_PAGE.id, pageName: opts.ai ? AI_PAGE.name : MARKETING_PAGE.name,
      },
    }),
  });

  const sendPosts = (body: Record<string, unknown>, secret?: string) => app.inject({
    method: 'POST', url: '/v1/webhooks/fb-bridge/posts',
    headers: { authorization: `Bearer ${secret ?? e.FB_BRIDGE_SECRET}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  const marketingPosts = (posts: unknown[]) =>
    sendPosts({ tenantId: t.tenantId, sessionKey: t.tenantId, pageId: MARKETING_PAGE.id, posts });

  const inbox = async (division?: 'marketing' | 'ai') => {
    const res = await app.inject({
      method: 'GET', url: '/v1/inbox/comments?limit=200',
      headers: { authorization: `Bearer ${token}`, ...(division ? { 'x-division': division } : {}) },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { comments: InboxComment[] }).comments;
  };
  const onPost = async (postId: string, division?: 'marketing' | 'ai') =>
    (await inbox(division)).filter((c) => c.postId === postId);

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbposts');
    e = env();
    aiKey = bridgeSessionKey(t.tenantId, 'ai');
    app = buildApp({
      db, control: db, kek: TEST_KEK, env: e,
      dispatch: async ({ queue, payload }) => {
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
      payload: { workspace: 'fbposts', email: 'owner@fbposts.test', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { accessToken: string }).accessToken;
  });

  afterAll(async () => { await app.close(); await db.close(); });

  it("stores a post's caption and age, and every comment on that post carries them to the inbox", async () => {
    const [a, b] = [nextCommentId(), nextCommentId()];
    expect((await deliverComment(a, POST)).statusCode).toBe(200);
    expect((await deliverComment(b, POST)).statusCode).toBe(200);

    const res = await marketingPosts([{ postId: POST, text: 'Drama baru', createdAt: PRECISE }]);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stored: 1 });
    const comments = await onPost(POST);
    expect(comments.map((c) => c.commentId).sort()).toEqual([a, b].sort());
    for (const c of comments) {
      expect(c.postText).toBe('Drama baru');
      expect(c.postCreatedAt).toBe(PRECISE);
      // The identity is untouched: the slug is still what the comment is filed under.
      expect(c.postId).toBe(POST);
    }
  });

  it('still lists a comment whose post nobody has described yet, with no caption and no age', async () => {
    const commentId = nextCommentId();
    await deliverComment(commentId, OTHER);

    const [comment] = await onPost(OTHER);

    expect(comment?.commentId).toBe(commentId);
    expect(comment?.postText).toBeNull();
    expect(comment?.postCreatedAt).toBeNull();
  });

  it('keeps the earliest age it was told and the fuller caption, and takes an edited caption', async () => {
    const details = async () => (await onPost(POST))[0]!;

    // A later, coarser reading ("2 days ago") never replaces a precise one.
    await marketingPosts([{ postId: POST, text: 'Drama baru', createdAt: COARSE }]);
    expect((await details()).postCreatedAt).toBe(PRECISE);

    // The permalink's whole caption, then the timeline's cut-off start of it.
    await marketingPosts([{ postId: POST, text: 'Drama baru\nEpisode 1 tayang malam ini', createdAt: null }]);
    await marketingPosts([{ postId: POST, text: 'Drama baru\nEpisode 1 tayang', createdAt: COARSE }]);
    expect((await details()).postText).toBe('Drama baru\nEpisode 1 tayang malam ini');

    // A caption with no text read this time leaves the stored one alone.
    await marketingPosts([{ postId: POST, text: null, createdAt: null }]);
    expect((await details()).postText).toBe('Drama baru\nEpisode 1 tayang malam ini');

    // An edit on Facebook is a different caption, and it wins.
    await marketingPosts([{ postId: POST, text: 'Drama baru (diedit)', createdAt: null }]);
    expect((await details()).postText).toBe('Drama baru (diedit)');
    expect((await details()).postCreatedAt).toBe(PRECISE);
  });

  it('follows the post when Facebook re-issues its slug, as one group with the details it had', async () => {
    const first = nextCommentId();
    const second = nextCommentId();
    await deliverComment(first, POST);
    await deliverComment(second, POST);
    // The timeline already shows the new slug, read two days in — a coarser age.
    await marketingPosts([{ postId: RENAMED, text: 'Drama baru (diedit)', createdAt: COARSE }]);

    // The sweep re-reads one comment under the new slug; the CRM moves the post.
    expect((await deliverComment(first, RENAMED)).statusCode).toBe(200);

    const comments = await inbox();
    expect(comments.filter((c) => c.postId === POST)).toEqual([]);
    const moved = comments.filter((c) => c.postId === RENAMED);
    expect(moved.map((c) => c.commentId)).toEqual(expect.arrayContaining([first, second]));
    for (const c of moved) {
      expect(c.postText).toBe('Drama baru (diedit)');
      expect(c.postCreatedAt).toBe(PRECISE);
    }
    const groups = groupCommentsByPost(comments).filter((g) => g.postId === POST || g.postId === RENAMED);
    expect(groups.map((g) => g.postId)).toEqual([RENAMED]);
    expect(groups[0]!.post).toEqual({ text: 'Drama baru (diedit)', createdAt: PRECISE });
  });

  it("keeps each division's post details to itself", async () => {
    const aiComment = nextCommentId();
    const marketingComment = nextCommentId();
    await deliverComment(aiComment, AI_POST, { ai: true });
    await deliverComment(marketingComment, AI_POST);

    const res = await sendPosts({
      tenantId: t.tenantId, sessionKey: aiKey, pageId: AI_PAGE.id,
      posts: [{ postId: AI_POST, text: 'Khusus divisi AI', createdAt: PRECISE }],
    });

    expect(res.statusCode).toBe(200);
    const ai = await onPost(AI_POST, 'ai');
    expect(ai.map((c) => [c.commentId, c.postText])).toEqual([[aiComment, 'Khusus divisi AI']]);
    const marketing = await onPost(AI_POST, 'marketing');
    expect(marketing.map((c) => [c.commentId, c.postText])).toEqual([[marketingComment, null]]);

    const visible = (division: 'marketing' | 'ai') => withTenant(db, t.tenantId, async (tx) =>
      (await tx.query<{ post_id: string }>('select post_id from facebook_posts order by post_id')).map((r) => r.post_id),
    { divisionId: t.divisions[division] });
    expect(await visible('ai')).toEqual([AI_POST]);
    expect(await visible('marketing')).not.toContain(AI_POST);
  });

  it('refuses a caller without the bridge secret, or a session that is not the tenant', async () => {
    const body = { tenantId: t.tenantId, sessionKey: t.tenantId, pageId: MARKETING_PAGE.id, posts: [] };
    expect((await sendPosts(body, 'wrong-secret')).statusCode).toBe(401);
    expect((await sendPosts({ ...body, sessionKey: bridgeSessionKey('00000000-0000-4000-8000-000000000000', 'ai') }))
      .statusCode).toBe(400);
  });

  it.each([
    ['a post id that is not a Facebook post id', { posts: [{ postId: 'javascript:alert(1)', text: 'x', createdAt: null }] }],
    ['an age that is not a timestamp', { posts: [{ postId: POST, text: 'x', createdAt: 'yesterday' }] }],
    ['a caption past the bound', { posts: [{ postId: POST, text: 'x'.repeat(5_001), createdAt: null }] }],
    ['more posts than one reading holds', {
      posts: Array.from({ length: 21 }, (_, i) => ({ postId: `pfbid0Bulk${i}`, text: null, createdAt: null })),
    }],
    ['no Page', { pageId: undefined }],
  ])('refuses %s', async (_what, over) => {
    const res = await sendPosts({
      tenantId: t.tenantId, sessionKey: t.tenantId, pageId: MARKETING_PAGE.id,
      posts: [{ postId: POST, text: 'x', createdAt: null }], ...over,
    });
    expect(res.statusCode).toBe(400);
  });
});
