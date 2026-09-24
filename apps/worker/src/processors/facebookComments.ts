import {
  withTenant, eachTenant, getFacebookComment, listPendingComments, findMessengerBridgeChannel,
  recordMessengerAgentReply,
  claimCommentForPublicReply, markCommentPublicReplied, markCommentPublicReplyFailed,
  claimCommentForDm, markCommentDmSent, markCommentDmFailed,
  type Ctx, type Database, type FacebookCommentRow, type PendingComment, type CommentStatus,
} from '@kirana/db';
import type { CommentTarget, FbBridgeError } from '../fbBridgeClient.ts';

/**
 * Acting on a Facebook comment: the public reply, the private message that may
 * follow it, and the sweep that decides which comments get either on their own.
 *
 * Everything here is a side effect on a real person's timeline or inbox, sent
 * through a browser session that Meta is watching for exactly this kind of
 * behaviour. So the shape of this file is defensive on purpose:
 *
 *   - The database decides whether an action may happen. `claimCommentFor*`
 *     moves the row *before* the bridge is called, and a refused claim means
 *     stop — never "check again", never "probably fine". That is what makes a
 *     retry, a restart, a repeated sweep or two workers unable to reply twice.
 *   - Nothing is marked done on anything but a 200 from the bridge. A reply the
 *     bridge typed but could not see on the post is a failure with a reason,
 *     not a success with a caveat.
 *   - The bridge is never called inside a database transaction. The claim
 *     commits, the browser does its slow work, and the outcome is written in a
 *     fresh transaction — holding a connection across a multi-second page
 *     interaction is how the pool starves.
 *
 * Automatic processing (the sweep) is gated on FB_COMMENT_AUTO_DM. The two
 * action processors are not: an agent choosing to reply from the console is a
 * different thing from the system choosing to, and the flag exists to stop the
 * latter.
 */

export const COMMENT_REPLY_QUEUE = 'facebook.comment.reply';
export const COMMENT_DM_QUEUE = 'facebook.comment.dm';
export const COMMENT_SWEEP_QUEUE = 'facebook.comment.sweep';

/** What the processors need from the bridge — `FbBridgeClient` satisfies it,
 * and so does an in-memory stub. */
export interface CommentBridge {
  replyToComment(args: CommentTarget): Promise<void>;
  privateReplyToComment(args: CommentTarget): Promise<{ threadId: string }>;
}

export interface CommentEnv {
  FB_COMMENT_AUTO_DM: boolean;
  FB_COMMENT_COOLDOWN_MS: number;
  FB_COMMENT_BATCH: number;
  FB_COMMENT_MAX_ATTEMPTS: number;
  FB_COMMENT_AUTO_REPLY_TEXT: string;
  FB_COMMENT_AUTO_DM_TEXT: string;
}

export interface CommentDeps {
  db: Database;
  kek: Buffer;
  fbBridge: CommentBridge;
  dispatch: (job: { queue: string; payload: unknown }) => Promise<void>;
  env: CommentEnv;
}

/**
 * One action on one comment.
 *
 * `commentId` is the `facebook_comments.id` row id — the key every state
 * transition takes — and NOT Facebook's own comment id, which the row carries
 * and the processor reads off it before talking to the bridge.
 */
export interface CommentActionJob {
  tenantId: string;
  commentId: string;
  text: string;
}

export interface CommentActionOutcome {
  status: 'replied' | 'sent' | 'skipped' | 'failed';
  reason?: string;
}

export interface CommentSweepOutcome {
  status: 'disabled' | 'swept';
  dispatched: number;
  skipped: number;
}

/* ------------------------------------------------------------ guards */

/**
 * The Page talking to itself is not a customer.
 *
 * The bridge reads every comment on a post, the Page's own replies included —
 * and once this code has replied publicly, that reply is a comment too. Acting
 * on it would answer our own answer, then DM ourselves, then do both again from
 * the reply to that. The id comparison is exact; the name comparison is the
 * fallback for markup that exposed no profile link, and only runs then, because
 * a customer whose display name happens to match the Page is at least possible
 * and a Page whose reply carries somebody else's id is not.
 */
export function isPagesOwnComment(c: {
  authorExternalId: string | null; authorName: string | null; pageId: string; pageName: string | null;
}): boolean {
  if (c.authorExternalId) return c.authorExternalId === c.pageId;
  if (!c.authorName || !c.pageName) return false;
  return c.authorName.trim() === c.pageName.trim();
}

const isPermanent = (err: unknown): boolean => (err as FbBridgeError | null)?.permanent === true;

/**
 * What goes on the row, in words an agent reads in the console.
 *
 * The bridge's codes are the contract; the sentences are ours. Two of them
 * carry a warning rather than a diagnosis: "typed but not confirmed" means the
 * action may well have happened, and the honest advice is to look at Facebook
 * before doing it again by hand.
 */
const SESSION_GONE = 'Sesi Facebook tidak aktif — hubungkan ulang Page dari Pengaturan → Facebook';
const REASONS: Record<string, string> = {
  comment_not_found: 'Komentar tidak ditemukan lagi di postingan — mungkin sudah dihapus',
  reply_unavailable: 'Facebook tidak menyediakan kolom balasan untuk komentar ini',
  reply_not_confirmed:
    'Balasan sudah diketik tapi tidak terlihat muncul di postingan — periksa postingan sebelum membalas ulang',
  private_reply_unavailable: 'Facebook tidak menyediakan pesan pribadi untuk komentar ini',
  send_not_confirmed:
    'Pesan sudah diketik tapi tidak terkonfirmasi terkirim — periksa kotak masuk Facebook sebelum mengirim ulang',
  malformed_response:
    'Bridge menjawab sukses tanpa id percakapan — pesan mungkin sudah terkirim, periksa kotak masuk Facebook',
};

export function readableReason(err: unknown): string {
  const e = err as FbBridgeError | null;
  const known = e?.code ? REASONS[e.code] : undefined;
  if (known) return known;
  if (e?.status === 404) return SESSION_GONE;
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/* ----------------------------------------------------------- claiming */

type Refusal =
  | { kind: 'missing' }
  | { kind: 'own' }
  | { kind: 'no_channel' }
  | { kind: 'refused'; status: CommentStatus; dmError?: string | null };

/** Either the row is ours to act on, with what the action needs, or why not. */
type Claim<T> = ({ kind: 'claimed' } & T) | Refusal;

function describe(claim: Refusal): string {
  switch (claim.kind) {
    case 'missing': return 'no such comment in this tenant';
    case 'own': return "it is the Page's own comment";
    case 'no_channel': return "no 'messenger_bridge' channel — connect a Page from Pengaturan → Facebook";
    case 'refused':
      return `claim refused, status is '${claim.status}'${claim.dmError ? ' and the private message already failed' : ''}`;
  }
}

function skipped(job: CommentActionJob, action: string, reason: string): CommentActionOutcome {
  console.log(`[fb-comments] ${action} skipped for comment ${job.commentId}: ${reason}`);
  return { status: 'skipped', reason };
}

/** A blank message is not a job; it is a bug upstream, and typing it into a
 * customer's post would be the worst possible way to report it. */
function textOf(job: CommentActionJob): string {
  return typeof job.text === 'string' ? job.text.trim() : '';
}

/* ------------------------------------------------------- public reply */

export async function processCommentPublicReply(
  deps: CommentDeps, job: CommentActionJob,
): Promise<CommentActionOutcome> {
  const text = textOf(job);
  if (!text) return skipped(job, 'public reply', 'empty text');

  const claim = await withTenant(deps.db, job.tenantId, async (tx): Promise<Claim<{ comment: FacebookCommentRow }>> => {
    const ctx = { tx, tenantId: job.tenantId, kek: deps.kek };
    const comment = await getFacebookComment(ctx, { id: job.commentId });
    if (!comment) return { kind: 'missing' };
    if (isPagesOwnComment(comment)) return { kind: 'own' };
    const claimed = await claimCommentForPublicReply(ctx, { id: comment.id });
    return claimed ? { kind: 'claimed', comment } : { kind: 'refused', status: comment.status };
  });
  if (claim.kind !== 'claimed') return skipped(job, 'public reply', describe(claim));
  const { comment } = claim;

  try {
    await deps.fbBridge.replyToComment({
      tenantId: job.tenantId, postId: comment.postId, commentId: comment.commentId, text,
    });
  } catch (err) {
    return await failPublicReply(deps, job, err);
  }

  const marked = await withTenant(deps.db, job.tenantId, (tx) =>
    markCommentPublicReplied({ tx, tenantId: job.tenantId, kek: deps.kek }, { id: comment.id }));
  if (!marked) {
    // The claim is ours and the only ways out of 'public_reply_pending' are the
    // two this file performs, so this means a hand edit of the row. Loud, not
    // fatal: the reply is on the post either way.
    console.error(`[fb-comments] reply confirmed for comment ${job.commentId} but the row was no longer pending`);
  }
  console.log(`[fb-comments] public reply confirmed: ${comment.commentId} on post ${comment.postId}`);
  return { status: 'replied' };
}

/**
 * THE RETRY PATH, AND WHY IT DOES NOTHING.
 *
 * A transient error is rethrown so the queue's backoff retries the job — and
 * the retry will find its claim refused and stop. That is the intended outcome,
 * not a gap. `markCommentPublicReplyFailed` moves the row to 'failed', from
 * which no transition leads back, and `claimCommentForPublicReply` only takes
 * a row from 'new'. The state machine (`transition()` in
 * `packages/db/src/facebookBridge.ts`) was written that way and its own tests
 * pin it: "a failed public reply is terminal".
 *
 * The alternative — leaving the row claimable so the retry types again — is
 * wrong for the one transient error that actually occurs here. 502
 * `reply_not_confirmed` means the bridge typed the reply and could not see it
 * on the post; most of the time that is Facebook rendering late, and the reply
 * is there. Typing it again would put two identical answers under a real
 * customer's comment, which is the exact thing this whole state machine exists
 * to prevent. So the comment is failed with a sentence telling the agent to
 * look at the post, and the rethrow's only job is to surface the bridge error
 * to the queue's failed-event log, where an operator watching for a sick bridge
 * will see it. Bounded attempts and the persistent cooldown remain the sole
 * pacing mechanism, on the row, as the columns intend.
 */
async function failPublicReply(deps: CommentDeps, job: CommentActionJob, err: unknown): Promise<CommentActionOutcome> {
  const reason = readableReason(err);
  await withTenant(deps.db, job.tenantId, (tx) =>
    markCommentPublicReplyFailed({ tx, tenantId: job.tenantId, kek: deps.kek }, { id: job.commentId, reason }));
  console.error(`[fb-comments] public reply failed for comment ${job.commentId}: ${(err as Error).message}`);
  if (!isPermanent(err)) throw err;
  return { status: 'failed', reason };
}

/* ---------------------------------------------------- private message */

/**
 * The provider id the delivered DM is stored under. One per comment, so a job
 * that somehow records twice inserts once — and distinct from the `fb_dm:`
 * keys the watcher uses, so it is obvious in the data where the row came from.
 */
export const commentDmMessageKey = (tenantId: string, commentId: string): string =>
  `fb_comment_dm:${tenantId}:${commentId}`;

export async function processCommentDm(deps: CommentDeps, job: CommentActionJob): Promise<CommentActionOutcome> {
  const text = textOf(job);
  if (!text) return skipped(job, 'private message', 'empty text');

  type DmClaim = Claim<{ comment: FacebookCommentRow; channelId: string }>;
  const claim = await withTenant(deps.db, job.tenantId, async (tx): Promise<DmClaim> => {
    const ctx = { tx, tenantId: job.tenantId, kek: deps.kek };
    const comment = await getFacebookComment(ctx, { id: job.commentId });
    if (!comment) return { kind: 'missing' };
    if (isPagesOwnComment(comment)) return { kind: 'own' };
    // Resolved before the claim, not after the send: a message that was
    // delivered with nowhere to record it would leave the row at 'dm_pending'
    // with no error, and there is no transition back from there. The channel
    // is created when the Page is connected, so this only fails on a broken
    // setup — and then nothing is claimed and nothing is sent.
    const channel = await findMessengerBridgeChannel(ctx);
    if (!channel) return { kind: 'no_channel' };
    const claimed = await claimCommentForDm(ctx, { id: comment.id });
    return claimed
      ? { kind: 'claimed', comment, channelId: channel.channelId }
      : { kind: 'refused', status: comment.status, dmError: comment.dmError };
  });
  if (claim.kind !== 'claimed') {
    if (claim.kind === 'no_channel') console.error(`[fb-comments] tenant ${job.tenantId}: ${describe(claim)}`);
    return skipped(job, 'private message', describe(claim));
  }
  const { comment, channelId } = claim;

  let threadId: string;
  try {
    ({ threadId } = await deps.fbBridge.privateReplyToComment({
      tenantId: job.tenantId, postId: comment.postId, commentId: comment.commentId, text,
    }));
  } catch (err) {
    return await failDm(deps, job, err);
  }

  // Delivered. What follows is history, in one transaction with the state
  // change so the row and the conversation cannot disagree.
  //
  // The contact is keyed by the thread id, not by the comment author's profile
  // id, and that is deliberate: the watcher stamps every inbound Messenger
  // message with `senderId: threadId` (apps/fb-bridge/src/messengerWatcher.ts),
  // so the thread id is the only key under which the customer's eventual reply
  // lands on this same contact instead of a second one. The author's name is
  // carried along and fills the contact's name if it is empty.
  //
  // `recordMessengerAgentReply`, never `queueOutboundMessage`: the message is
  // already in the customer's inbox, and an outbox row would send it again.
  await withTenant(deps.db, job.tenantId, async (tx) => {
    const ctx = { tx, tenantId: job.tenantId, kek: deps.kek };
    await recordMessengerAgentReply(ctx, {
      channelId, fbUserId: threadId, threadId, body: text,
      providerMessageId: commentDmMessageKey(job.tenantId, comment.commentId),
      displayName: comment.authorName,
    });
    await markCommentDmSent(ctx, { id: comment.id });
  });
  console.log(`[fb-comments] private message sent for comment ${comment.commentId}: thread ${threadId}`);
  return { status: 'sent' };
}

/**
 * Same shape as the public reply's failure, same reasoning, one difference in
 * where the row lands. `markCommentDmFailed` returns the comment to
 * 'public_replied' — the public reply did happen and the row must keep saying
 * so — with `dm_error` set, and both `listPendingComments` and
 * `claimCommentForDm` exclude a row that has one. So the private message is
 * over for this comment whichever error ended it: Facebook offers it once, and
 * a 502 `send_not_confirmed` (typed, not seen in the thread) is a message that
 * probably arrived. The transient rethrow surfaces the bridge error to the
 * queue; the retry it causes is refused at the claim and sends nothing.
 */
async function failDm(deps: CommentDeps, job: CommentActionJob, err: unknown): Promise<CommentActionOutcome> {
  const reason = readableReason(err);
  await withTenant(deps.db, job.tenantId, (tx) =>
    markCommentDmFailed({ tx, tenantId: job.tenantId, kek: deps.kek }, { id: job.commentId, reason }));
  console.error(`[fb-comments] private message failed for comment ${job.commentId}: ${(err as Error).message}`);
  if (!isPermanent(err)) throw err;
  return { status: 'failed', reason };
}

/* -------------------------------------------------------------- sweep */

let saidAutoDmOff = false;

/** `listPendingComments` carries no Page name, and only a comment with no
 * author id needs one — so the row is read only then. */
async function isOwnPendingComment(ctx: Ctx, c: PendingComment): Promise<boolean> {
  if (c.authorExternalId) return c.authorExternalId === c.pageId;
  const row = await getFacebookComment(ctx, { id: c.id });
  return row ? isPagesOwnComment(row) : false;
}

/**
 * Where a comment goes next, or nowhere.
 *
 * Only two states are actionable. The two `*_pending` states are a claim some
 * job holds — or held, if it died mid-action — and re-dispatching them would
 * be refused at the claim anyway; 'dm_sent' and 'failed' are finished. That a
 * public reply and its private message are never dispatched from the same
 * sweep is what puts at least one cooldown between them.
 */
function nextQueueFor(status: CommentStatus): string | null {
  if (status === 'new') return COMMENT_REPLY_QUEUE;
  if (status === 'public_replied') return COMMENT_DM_QUEUE;
  return null;
}

/**
 * One tenant's sweep: find comments with work left and queue that work.
 *
 * Queued, not done here, so one slow comment cannot hold up the rest and one
 * failing comment is retried on its own. Pacing is not this function's job:
 * `listPendingComments` holds back any comment inside its cooldown, measured
 * from a column so a restart cannot reset it, and caps how many are offered.
 * A sweep that runs twice before its jobs are processed will queue a duplicate
 * job for the same 'new' comment; the second one's claim is refused, so the
 * cost is a log line and never a second reply.
 *
 * There is deliberately no check of the stored bridge status first. That row
 * is only refreshed when somebody opens the console, so gating on it would
 * silently stop the sweep after any recovered error until a human looked. The
 * bridge's own answer decides instead — a 404 fails that comment with a
 * reason an agent can read, and the next one is tried on its own.
 */
export async function processCommentAutopilot(deps: CommentDeps, job: { tenantId: string }): Promise<CommentSweepOutcome> {
  if (!deps.env.FB_COMMENT_AUTO_DM) {
    // Once per process, not once per tick: a disabled feature that logs every
    // minute is a log nobody reads.
    if (!saidAutoDmOff) {
      console.log('[fb-comments] FB_COMMENT_AUTO_DM is off — comments are not acted on automatically');
      saidAutoDmOff = true;
    }
    return { status: 'disabled', dispatched: 0, skipped: 0 };
  }

  const { env } = deps;
  const plan = await withTenant(deps.db, job.tenantId, async (tx) => {
    const ctx = { tx, tenantId: job.tenantId, kek: deps.kek };
    const pending = await listPendingComments(ctx, {
      limit: env.FB_COMMENT_BATCH, cooldownMs: env.FB_COMMENT_COOLDOWN_MS, maxAttempts: env.FB_COMMENT_MAX_ATTEMPTS,
    });
    const jobs: { queue: string; payload: CommentActionJob }[] = [];
    let skipped = 0;
    for (const c of pending) {
      if (await isOwnPendingComment(ctx, c)) { skipped += 1; continue; }
      const queue = nextQueueFor(c.status);
      if (!queue) continue;
      const text = queue === COMMENT_REPLY_QUEUE ? env.FB_COMMENT_AUTO_REPLY_TEXT : env.FB_COMMENT_AUTO_DM_TEXT;
      jobs.push({ queue, payload: { tenantId: job.tenantId, commentId: c.id, text } });
    }
    return { jobs, skipped };
  });

  // Outside the transaction: the queue is Redis, and a slow broker must not
  // hold a database connection open.
  for (const j of plan.jobs) await deps.dispatch(j);
  if (plan.jobs.length > 0) {
    console.log(`[fb-comments] sweep for tenant ${job.tenantId}: queued ${plan.jobs.length}, skipped ${plan.skipped}`);
  }
  return { status: 'swept', dispatched: plan.jobs.length, skipped: plan.skipped };
}

/**
 * The scheduler's tick: one sweep job per tenant.
 *
 * `eachTenant` is the sanctioned cross-tenant listing — identifiers only, never
 * data — so the sweep itself runs inside `withTenant` like every other
 * tenant-scoped job and this file never opens the escape hatch. Fanning out
 * rather than looping here means one tenant's slow bridge cannot delay the
 * next tenant's sweep, and a failing tenant is retried on its own.
 */
export async function dispatchCommentSweeps(
  deps: { control: Database; dispatch: CommentDeps['dispatch'] },
): Promise<{ tenants: number }> {
  const tenants = await eachTenant(deps.control, 'the Facebook comment sweep');
  for (const t of tenants) {
    await deps.dispatch({ queue: COMMENT_SWEEP_QUEUE, payload: { tenantId: t.id } });
  }
  return { tenants: tenants.length };
}
