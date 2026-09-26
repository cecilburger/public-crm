import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { env } from '@kirana/core';
import {
  withTenant, ensureMessengerBridgeChannel, recordFacebookComment, getFacebookComment,
  claimCommentForPublicReply, markCommentPublicReplied, tenantKeys, openField,
  type Database,
} from '@kirana/db';
import { FbBridgeClient, fbBridgeFailure, type FbBridgeError } from '../apps/worker/src/fbBridgeClient.ts';
import {
  processCommentPublicReply, processCommentDm, processCommentAutopilot, dispatchCommentSweeps,
  isPagesOwnComment, commentDmMessageKey,
  COMMENT_REPLY_QUEUE, COMMENT_DM_QUEUE, COMMENT_SWEEP_QUEUE,
  type CommentBridge, type CommentDeps, type CommentEnv, type CommentActionJob,
} from '../apps/worker/src/processors/facebookComments.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

const PAGE = { id: '900000000000001', name: 'Toko Demo' };
const POST = '998877665544';

/**
 * Nothing here reaches Facebook or a running bridge, and nothing can. The
 * bridge is an in-memory stub that records what it was asked and answers with
 * whatever the test configured — using the exact error the real client throws,
 * built by the real client's own factory, so the stub cannot drift from it.
 * The database is real (PGlite, migrated with the real SQL), because the claims
 * and transitions under test *are* the database.
 */

/* ------------------------------------------------------------- fakes */

interface StubBridge extends CommentBridge {
  replies: { commentId: string; postId: string; text: string }[];
  dms: { commentId: string; postId: string; text: string }[];
}

function stubBridge(outcome: {
  reply?: () => Promise<void>;
  dm?: () => Promise<{ threadId: string }>;
} = {}): StubBridge {
  const replies: StubBridge['replies'] = [];
  const dms: StubBridge['dms'] = [];
  return {
    replies, dms,
    async replyToComment(args) {
      replies.push({ commentId: args.commentId, postId: args.postId, text: args.text });
      await outcome.reply?.();
    },
    async privateReplyToComment(args) {
      dms.push({ commentId: args.commentId, postId: args.postId, text: args.text });
      return outcome.dm ? outcome.dm() : { threadId: '100000000000777' };
    },
  };
}

/** The bridge answering exactly as the contract says it would. */
const bridgeAnswers = (what: string, status: number, body: Record<string, unknown>) => async (): Promise<never> => {
  throw fbBridgeFailure(what, status, JSON.stringify(body));
};

function recordingDispatch() {
  const jobs: { queue: string; payload: CommentActionJob }[] = [];
  return {
    jobs,
    dispatch: async (job: { queue: string; payload: unknown }) => {
      jobs.push(job as { queue: string; payload: CommentActionJob });
    },
  };
}

const AUTO_OFF: CommentEnv = {
  FB_COMMENT_AUTO_DM: false, FB_COMMENT_COOLDOWN_MS: 0, FB_COMMENT_BATCH: 10, FB_COMMENT_MAX_ATTEMPTS: 3,
  FB_COMMENT_AUTO_REPLY_TEXT: 'Check DM ya kak!!!',
  FB_COMMENT_AUTO_DM_TEXT: 'Halo kak, ini dari Red Panda Test — boleh kami bantu lewat DM ya.',
};
const AUTO_ON: CommentEnv = { ...AUTO_OFF, FB_COMMENT_AUTO_DM: true };

/* ------------------------------------------------------ one comment */

describe('acting on one Facebook comment', () => {
  let db: Database;
  let t: TestTenant;
  let seq = 0;

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbcomments');
    await withTenant(db, t.tenantId, (tx) =>
      ensureMessengerBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        pageId: PAGE.id, pageName: PAGE.name, status: 'connected',
      }));
  });
  afterAll(async () => { await db.close(); });

  const ctx = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => ({ tx, tenantId: t.tenantId, kek: TEST_KEK });

  /** A fresh comment, so each test starts from 'new' without touching another. */
  const given = async (over: Record<string, unknown> = {}) => {
    seq += 1;
    const row = await withTenant(db, t.tenantId, (tx) =>
      recordFacebookComment(ctx(tx), {
        pageId: PAGE.id, pageName: PAGE.name, postId: POST, commentId: `70000000000${seq}`,
        authorExternalId: `10000000000${seq}`, authorName: 'Budi Santoso',
        body: 'mau tau jasa ini gimana?', commentedAt: new Date(1789000000_000 + seq), ...over,
      }));
    return row.id;
  };

  /** A comment that already has its public reply on record. */
  const givenReplied = async (over: Record<string, unknown> = {}) => {
    const id = await given(over);
    await withTenant(db, t.tenantId, (tx) => claimCommentForPublicReply(ctx(tx), { id }));
    await withTenant(db, t.tenantId, (tx) => markCommentPublicReplied(ctx(tx), { id }));
    return id;
  };

  const rowOf = async (id: string) => {
    const row = await withTenant(db, t.tenantId, (tx) => getFacebookComment(ctx(tx), { id }));
    if (!row) throw new Error(`comment ${id} vanished`);
    return row;
  };

  const deps = (fbBridge: StubBridge, env: CommentEnv = AUTO_OFF): CommentDeps => ({
    db, kek: TEST_KEK, fbBridge, dispatch: recordingDispatch().dispatch, env,
  });

  const job = (commentId: string, text = 'Check DM ya kak!!!'): CommentActionJob => ({ tenantId: t.tenantId, commentId, text });

  /** Everything a delivered DM leaves behind on the Messenger side. */
  const messengerFootprint = () => withTenant(db, t.tenantId, async (tx) => {
    const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
    const contacts = await tx.query<{ n: number }>(
      `select count(*)::int as n from contacts where tenant_id = $1 and fb_user_id_bidx is not null`, [t.tenantId]);
    const conversations = await tx.query<{ id: string }>(
      `select c.id from conversations c
         join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
        where c.tenant_id = $1 and ch.kind = 'messenger_bridge'`, [t.tenantId]);
    const messages = await tx.query<{
      direction: string; sender_type: string; status: string; body_enc: string; provider_message_id: string;
    }>(
      `select m.direction, m.sender_type, m.status, m.body_enc, m.provider_message_id
         from messages m join channels ch on ch.id = m.channel_id and ch.tenant_id = m.tenant_id
        where m.tenant_id = $1 and ch.kind = 'messenger_bridge'`, [t.tenantId]);
    const outbox = await tx.query<{ n: number }>(
      `select count(*)::int as n from message_outbox where tenant_id = $1`, [t.tenantId]);
    return {
      contacts: contacts[0]!.n,
      conversations: conversations.length,
      messages: messages.map((m) => ({
        direction: m.direction, senderType: m.sender_type, status: m.status,
        body: openField(keys, t.tenantId, m.body_enc), providerMessageId: m.provider_message_id,
      })),
      outbox: outbox[0]!.n,
    };
  });

  /* ---- the public reply */

  it('replies exactly once when two workers race for the same comment', async () => {
    // Arrange
    const id = await given();
    const bridge = stubBridge();

    // Act
    const outcomes = await Promise.all([
      processCommentPublicReply(deps(bridge), job(id)),
      processCommentPublicReply(deps(bridge), job(id)),
    ]);

    // Assert
    expect(bridge.replies).toHaveLength(1);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['replied', 'skipped']);
  });

  it('records a public reply the bridge confirmed', async () => {
    const id = await given();
    const bridge = stubBridge();

    const outcome = await processCommentPublicReply(deps(bridge), job(id, 'Sudah kami DM ya kak'));

    expect(outcome.status).toBe('replied');
    expect(bridge.replies).toEqual([{ commentId: `70000000000${seq}`, postId: POST, text: 'Sudah kami DM ya kak' }]);
    const row = await rowOf(id);
    expect(row.status).toBe('public_replied');
    expect(row.publicReplyAt).not.toBeNull();
    expect(row.publicReplyError).toBeNull();
  });

  it('never calls public_replied a reply the bridge could not see, and hands the error to the queue', async () => {
    // A 502 is not a success. The row records it in words, the bridge was
    // asked exactly once, and the job rejects so the queue's failed-event log
    // shows a bridge that is struggling.
    const id = await given();
    const bridge = stubBridge({
      reply: bridgeAnswers('comment reply', 502, { error: 'reply typed but not seen', code: 'reply_not_confirmed' }),
    });

    await expect(processCommentPublicReply(deps(bridge), job(id))).rejects.toMatchObject({ permanent: false });

    expect(bridge.replies).toHaveLength(1);
    const row = await rowOf(id);
    expect(row.status).not.toBe('public_replied');
    expect(row.publicReplyAt).toBeNull();
    expect(row.publicReplyError).toContain('tidak terlihat muncul');
  });

  it('does not type the reply again when the queue retries after an unconfirmed one', async () => {
    // The reply may well be on the post already. The retry finds the claim
    // refused — the row is terminal — and touches nothing.
    const id = await given();
    const bridge = stubBridge({
      reply: bridgeAnswers('comment reply', 502, { error: 'reply typed but not seen', code: 'reply_not_confirmed' }),
    });
    await processCommentPublicReply(deps(bridge), job(id)).catch(() => undefined);

    const retry = await processCommentPublicReply(deps(bridge), job(id));

    expect(retry.status).toBe('skipped');
    expect(bridge.replies).toHaveLength(1);
  });

  it('stores a permanent refusal without asking the queue to retry', async () => {
    const id = await given();
    const bridge = stubBridge({
      reply: bridgeAnswers('comment reply', 409, { error: 'comment is gone', code: 'comment_not_found' }),
    });

    const outcome = await processCommentPublicReply(deps(bridge), job(id));

    expect(outcome.status).toBe('failed');
    expect(bridge.replies).toHaveLength(1);
    const row = await rowOf(id);
    expect(row.status).toBe('failed');
    expect(row.publicReplyError).toContain('tidak ditemukan');
  });

  it('explains a missing session in words an agent can act on', async () => {
    const id = await given();
    const bridge = stubBridge({ reply: bridgeAnswers('comment reply', 404, { error: 'no active session' }) });

    const outcome = await processCommentPublicReply(deps(bridge), job(id));

    expect(outcome.status).toBe('failed');
    expect((await rowOf(id)).publicReplyError).toContain('Sesi Facebook tidak aktif');
  });

  it("never replies to the Page's own comment, by id or by name", async () => {
    const byId = await given({ authorExternalId: PAGE.id, authorName: 'Somebody Else' });
    const byName = await given({ authorExternalId: null, authorName: PAGE.name });
    const bridge = stubBridge();

    const outcomes = await Promise.all([
      processCommentPublicReply(deps(bridge), job(byId)),
      processCommentPublicReply(deps(bridge), job(byName)),
    ]);

    expect(bridge.replies).toHaveLength(0);
    expect(outcomes.map((o) => o.status)).toEqual(['skipped', 'skipped']);
    // Untouched, not failed: there was nothing to do and nothing went wrong.
    expect((await rowOf(byId)).status).toBe('new');
    expect((await rowOf(byName)).status).toBe('new');
  });

  it('refuses a blank reply before claiming anything', async () => {
    const id = await given();
    const bridge = stubBridge();

    const outcome = await processCommentPublicReply(deps(bridge), job(id, '   '));

    expect(outcome.status).toBe('skipped');
    expect(bridge.replies).toHaveLength(0);
    expect((await rowOf(id)).status).toBe('new');
  });

  /* ---- the private message */

  it('records a delivered private message as history, never as something to send', async () => {
    const id = await givenReplied();
    const before = await messengerFootprint();
    const bridge = stubBridge({ dm: async () => ({ threadId: '100000000000555' }) });

    const outcome = await processCommentDm(deps(bridge), job(id, 'Halo kak, boleh kami bantu?'));

    expect(outcome.status).toBe('sent');
    expect(bridge.dms).toHaveLength(1);
    const row = await rowOf(id);
    expect(row.status).toBe('dm_sent');
    expect(row.dmAt).not.toBeNull();
    expect(row.dmError).toBeNull();

    const after = await messengerFootprint();
    expect(after.contacts).toBe(before.contacts + 1);
    expect(after.conversations).toBe(before.conversations + 1);
    const history = after.messages.filter((m) => m.providerMessageId === commentDmMessageKey(t.tenantId, row.commentId));
    expect(history).toEqual([{
      direction: 'outbound', senderType: 'agent', status: 'sent', body: 'Halo kak, boleh kami bantu?',
      providerMessageId: commentDmMessageKey(t.tenantId, row.commentId),
    }]);
    expect(after.outbox).toBe(0);
  });

  it('keeps the public reply on record when Facebook offers no private message', async () => {
    const id = await givenReplied();
    const before = await messengerFootprint();
    const bridge = stubBridge({
      dm: bridgeAnswers('private reply', 409, { error: 'no private reply offered', code: 'private_reply_unavailable' }),
    });

    const outcome = await processCommentDm(deps(bridge), job(id, 'Halo kak'));

    expect(outcome.status).toBe('failed');
    const row = await rowOf(id);
    expect(row.status).toBe('public_replied');
    expect(row.dmAt).toBeNull();
    expect(row.dmError).toBe('Facebook tidak menyediakan pesan pribadi untuk komentar ini');
    expect(await messengerFootprint()).toEqual(before);
  });

  it('hands an unconfirmed send to the queue without calling it sent', async () => {
    const id = await givenReplied();
    const bridge = stubBridge({
      dm: bridgeAnswers('private reply', 502, { error: 'send typed but not seen', code: 'send_not_confirmed' }),
    });

    await expect(processCommentDm(deps(bridge), job(id, 'Halo kak'))).rejects.toMatchObject({ permanent: false });

    const row = await rowOf(id);
    expect(row.status).not.toBe('dm_sent');
    expect(row.dmError).toContain('tidak terkonfirmasi terkirim');
    // And the retry it caused sends nothing.
    expect((await processCommentDm(deps(bridge), job(id, 'Halo kak'))).status).toBe('skipped');
    expect(bridge.dms).toHaveLength(1);
  });

  it('sends nothing when the private message is retried after it was sent', async () => {
    const id = await givenReplied();
    const bridge = stubBridge();
    await processCommentDm(deps(bridge), job(id, 'Halo kak'));

    const again = await processCommentDm(deps(bridge), job(id, 'Halo kak'));

    expect(again.status).toBe('skipped');
    expect(bridge.dms).toHaveLength(1);
    expect((await rowOf(id)).status).toBe('dm_sent');
  });

  it('does not send a private message to a comment that was never answered in public', async () => {
    // The DM follows the reply; there is no path around that order.
    const id = await given();
    const bridge = stubBridge();

    const outcome = await processCommentDm(deps(bridge), job(id, 'Halo kak'));

    expect(outcome.status).toBe('skipped');
    expect(bridge.dms).toHaveLength(0);
    expect((await rowOf(id)).status).toBe('new');
  });
});

/* ---------------------------------------------------------- the sweep */

describe('the comment sweep', () => {
  let db: Database;
  let t: TestTenant;
  let seq = 0;

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbsweep');
    await withTenant(db, t.tenantId, (tx) =>
      ensureMessengerBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        pageId: PAGE.id, pageName: PAGE.name, status: 'connected',
      }));
  });
  afterAll(async () => { await db.close(); });

  const ctx = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => ({ tx, tenantId: t.tenantId, kek: TEST_KEK });

  const given = async (over: Record<string, unknown> = {}, tenantId = t.tenantId) => {
    seq += 1;
    const row = await withTenant(db, tenantId, (tx) =>
      recordFacebookComment({ tx, tenantId, kek: TEST_KEK }, {
        pageId: PAGE.id, pageName: PAGE.name, postId: POST, commentId: `80000000000${seq}`,
        authorExternalId: `20000000000${seq}`, authorName: 'Siti Aminah',
        body: 'harganya berapa?', commentedAt: new Date(1789000000_000 + seq), ...over,
      }));
    return row.id;
  };

  const sweep = async (env: CommentEnv, tenantId = t.tenantId) => {
    const q = recordingDispatch();
    const outcome = await processCommentAutopilot(
      { db, kek: TEST_KEK, fbBridge: stubBridge(), dispatch: q.dispatch, env }, { tenantId });
    return { outcome, jobs: q.jobs };
  };

  const jobsFor = (jobs: { queue: string; payload: CommentActionJob }[], id: string, queue: string) =>
    jobs.filter((j) => j.queue === queue && j.payload.commentId === id);

  it('is off unless FB_COMMENT_AUTO_DM says otherwise, and off is the default', async () => {
    await given();

    const { outcome, jobs } = await sweep(AUTO_OFF);

    expect(env().FB_COMMENT_AUTO_DM).toBe(false);
    expect(outcome.status).toBe('disabled');
    expect(jobs).toEqual([]);
  });

  it("queues one reply for a new comment, one DM after a reply, and nothing for the Page's own", async () => {
    // Arrange
    const fresh = await given();
    const replied = await given();
    await withTenant(db, t.tenantId, (tx) => claimCommentForPublicReply(ctx(tx), { id: replied }));
    await withTenant(db, t.tenantId, (tx) => markCommentPublicReplied(ctx(tx), { id: replied }));
    const own = await given({ authorExternalId: PAGE.id, authorName: PAGE.name });
    const ownByName = await given({ authorExternalId: null, authorName: PAGE.name });

    // Act
    const { outcome, jobs } = await sweep(AUTO_ON);

    // Assert
    expect(outcome.status).toBe('swept');
    expect(jobsFor(jobs, fresh, COMMENT_REPLY_QUEUE)).toEqual([{
      queue: COMMENT_REPLY_QUEUE,
      payload: { tenantId: t.tenantId, commentId: fresh, text: AUTO_ON.FB_COMMENT_AUTO_REPLY_TEXT },
    }]);
    expect(jobsFor(jobs, fresh, COMMENT_DM_QUEUE)).toEqual([]);
    expect(jobsFor(jobs, replied, COMMENT_DM_QUEUE)).toEqual([{
      queue: COMMENT_DM_QUEUE,
      payload: { tenantId: t.tenantId, commentId: replied, text: AUTO_ON.FB_COMMENT_AUTO_DM_TEXT },
    }]);
    expect(jobsFor(jobs, replied, COMMENT_REPLY_QUEUE)).toEqual([]);
    expect(jobs.filter((j) => j.payload.commentId === own || j.payload.commentId === ownByName)).toEqual([]);
    expect(outcome.skipped).toBeGreaterThanOrEqual(2);
  });

  it('does not queue a second reply after a restart once the reply is on record', async () => {
    const id = await given();
    const first = await sweep(AUTO_ON);
    expect(jobsFor(first.jobs, id, COMMENT_REPLY_QUEUE)).toHaveLength(1);
    // The queued job runs (the process could have died and come back between).
    const bridge = stubBridge();
    await processCommentPublicReply(
      { db, kek: TEST_KEK, fbBridge: bridge, dispatch: async () => {}, env: AUTO_ON }, { tenantId: t.tenantId, commentId: id, text: 'Check DM' });
    expect(bridge.replies).toHaveLength(1);

    const second = await sweep(AUTO_ON);

    expect(jobsFor(second.jobs, id, COMMENT_REPLY_QUEUE)).toHaveLength(0);
    // What it does offer is the next step, once, and then nothing at all.
    expect(jobsFor(second.jobs, id, COMMENT_DM_QUEUE)).toHaveLength(1);
    await processCommentDm(
      { db, kek: TEST_KEK, fbBridge: bridge, dispatch: async () => {}, env: AUTO_ON }, { tenantId: t.tenantId, commentId: id, text: 'Halo' });
    const third = await sweep(AUTO_ON);
    expect(third.jobs.filter((j) => j.payload.commentId === id)).toEqual([]);
  });

  it('leaves a comment mid-action alone rather than queueing it twice', async () => {
    const id = await given();
    await withTenant(db, t.tenantId, (tx) => claimCommentForPublicReply(ctx(tx), { id }));

    const { jobs } = await sweep(AUTO_ON);

    expect(jobs.filter((j) => j.payload.commentId === id)).toEqual([]);
  });

  it('acts on no more than FB_COMMENT_BATCH comments per sweep', async () => {
    const other = await makeTenant(db, 'fbsweep-batch');
    for (let i = 0; i < 4; i += 1) await given({}, other.tenantId);

    const { jobs } = await sweep({ ...AUTO_ON, FB_COMMENT_BATCH: 2 }, other.tenantId);

    expect(jobs).toHaveLength(2);
  });

  it('holds a comment back while its cooldown runs', async () => {
    const other = await makeTenant(db, 'fbsweep-cooldown');
    const id = await given({}, other.tenantId);
    await withTenant(db, other.tenantId, (tx) =>
      claimCommentForPublicReply({ tx, tenantId: other.tenantId, kek: TEST_KEK }, { id }));
    await withTenant(db, other.tenantId, (tx) =>
      markCommentPublicReplied({ tx, tenantId: other.tenantId, kek: TEST_KEK }, { id }));

    const held = await sweep({ ...AUTO_ON, FB_COMMENT_COOLDOWN_MS: 60_000 }, other.tenantId);
    const released = await sweep({ ...AUTO_ON, FB_COMMENT_COOLDOWN_MS: 0 }, other.tenantId);

    expect(held.jobs).toEqual([]);
    expect(jobsFor(released.jobs, id, COMMENT_DM_QUEUE)).toHaveLength(1);
  });

  it('fans the tick out into one sweep per tenant', async () => {
    const q = recordingDispatch();

    const { tenants } = await dispatchCommentSweeps({ control: db, dispatch: q.dispatch });

    const tenantIds = q.jobs.map((j) => (j.payload as unknown as { tenantId: string }).tenantId);
    expect(tenants).toBe(q.jobs.length);
    expect(new Set(tenantIds).size).toBe(tenantIds.length);
    expect(tenantIds).toContain(t.tenantId);
    expect(q.jobs.every((j) => j.queue === COMMENT_SWEEP_QUEUE)).toBe(true);
  });
});

/* ------------------------------------------------------ pure pieces */

describe("recognising the Page's own comment", () => {
  const base = { pageId: PAGE.id, pageName: PAGE.name };

  it('matches on id when there is one', () => {
    expect(isPagesOwnComment({ ...base, authorExternalId: PAGE.id, authorName: 'x' })).toBe(true);
    expect(isPagesOwnComment({ ...base, authorExternalId: '1', authorName: PAGE.name })).toBe(false);
  });

  it('falls back to the name only when the id is missing', () => {
    expect(isPagesOwnComment({ ...base, authorExternalId: null, authorName: ' Toko Demo ' })).toBe(true);
    expect(isPagesOwnComment({ ...base, authorExternalId: null, authorName: 'Budi' })).toBe(false);
    expect(isPagesOwnComment({ ...base, pageName: null, authorExternalId: null, authorName: PAGE.name })).toBe(false);
  });
});

describe('the bridge client, against the comment contract', () => {
  const client = new FbBridgeClient('http://bridge.test', 's3cret');
  // The bridge is addressed by session, which for a Marketing Page is the
  // bare tenant id — hence the unchanged `/sessions/t1/…` paths below.
  const target = { sessionKey: 't1', postId: POST, commentId: '7001', text: 'Halo' };

  const bridgeReplies = (status: number, body: unknown) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts a reply to the contract path with the shared secret', async () => {
    const fetchMock = bridgeReplies(200, { replied: true });

    await client.replyToComment(target);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://bridge.test/internal/sessions/t1/comments/reply');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer s3cret');
    expect(JSON.parse(init.body as string)).toEqual({ postId: POST, commentId: '7001', text: 'Halo' });
  });

  it('returns the thread a confirmed private reply opened', async () => {
    const fetchMock = bridgeReplies(200, { sent: true, threadId: '100000000000555' });

    const result = await client.privateReplyToComment(target);

    // No message id in this answer: the processor files the DM under the comment's own key.
    expect(result).toEqual({ threadId: '100000000000555', messageId: null });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0])
      .toBe('http://bridge.test/internal/sessions/t1/comments/private-reply');
  });

  it('treats "no private reply for this comment" as permanent, and says why', async () => {
    bridgeReplies(409, { error: 'not offered', code: 'private_reply_unavailable' });

    const err = await client.privateReplyToComment(target).catch((e: FbBridgeError) => e);

    expect(err).toMatchObject({ permanent: true, status: 409, code: 'private_reply_unavailable' });
    expect((err as Error).message).toContain('not offered');
  });

  it('leaves an unconfirmed reply to the queue', async () => {
    bridgeReplies(502, { error: 'typed, not seen', code: 'reply_not_confirmed' });

    const err = await client.replyToComment(target).catch((e: FbBridgeError) => e);

    expect(err).toMatchObject({ permanent: false, status: 502, code: 'reply_not_confirmed' });
  });

  it('treats a missing session as permanent for this job', async () => {
    bridgeReplies(404, { error: 'no active session' });

    const err = await client.replyToComment(target).catch((e: FbBridgeError) => e);

    expect(err).toMatchObject({ permanent: true, status: 404 });
    expect(err).not.toHaveProperty('code');
  });

  it('refuses a success that names no thread', async () => {
    bridgeReplies(200, { sent: true });

    const err = await client.privateReplyToComment(target).catch((e: FbBridgeError) => e);

    expect(err).toMatchObject({ permanent: true, code: 'malformed_response' });
  });
});
