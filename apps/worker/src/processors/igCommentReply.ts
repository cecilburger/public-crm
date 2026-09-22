import { withTenant, getIgComment, setIgCommentOutcome, type Database } from '@kirana/db';
import type { IgBridgeClient } from '../igBridgeClient.ts';

export interface IgCommentReplyDeps {
  db: Database;
  kek: Buffer;
  igBridge: IgBridgeClient;
  /** Where the bot's own wording comes from. Injected so a test can answer
   * without a running brain. */
  commentTexts: () => Promise<{ publicReply: string; dmOpener: string } | null>;
}

export interface IgCommentReplyJob {
  tenantId: string;
  commentId: string;
}

/**
 * Answer one comment the way the bot was designed to: a short line in public,
 * the actual reply in DM.
 *
 * The public line deliberately says almost nothing — the BD team's own rule
 * is not to explain under a post, because everyone scrolling past reads it,
 * including competitors, and a commenter who has already been answered has no
 * reason to open the DM that is the whole point. Both texts come from
 * `trained-cb`, so the bot's templates remain the single place its words are
 * written.
 *
 * Neither half is retried into a loop. A public reply Instagram refuses is
 * refusing the pace or the content, and asking again shortly is how an
 * account earns an action block — the row records the failure and the page
 * shows it, for a person to decide about.
 */
export async function processIgCommentReply(
  deps: IgCommentReplyDeps, job: IgCommentReplyJob,
): Promise<{ status: string }> {
  const comment = await withTenant(deps.db, job.tenantId, (tx) =>
    getIgComment({ tx, tenantId: job.tenantId, kek: deps.kek }, job.commentId));

  if (!comment) return { status: 'gone' };
  // Someone already dealt with it by hand, or a previous run did. Re-posting
  // under a public post is the one mistake worth being paranoid about.
  if (comment.publicStatus !== 'pending' || comment.dmStatus !== 'pending') {
    return { status: 'already_handled' };
  }

  const texts = await deps.commentTexts();
  if (!texts) {
    await record(deps, job, { lastError: 'Chatbot tidak bisa dihubungi untuk mengambil teks balasan' });
    return { status: 'no_brain' };
  }

  // A reply inside a thread is answered only by DM. The thread it sits in
  // already carries our one public line — saying it again turns a single
  // short reply into a visible back-and-forth under a brand's post, which is
  // precisely what keeping the public side short was for.
  const isReply = comment.parentRef !== null;

  const result = await deps.igBridge.replyToComment({
    tenantId: job.tenantId,
    postRef: comment.postRef,
    commentRef: comment.commentRef,
    commenter: comment.commenter,
    publicReply: isReply ? undefined : texts.publicReply,
    dmText: texts.dmOpener,
  });

  const errors = [result.public.error, result.dm.error].filter(Boolean).join(' · ');
  await record(deps, job, {
    // 'skipped', not 'failed': nothing was attempted in public here, and
    // calling that a failure would put the row back in the work queue for a
    // person to fix something that was a deliberate choice.
    publicStatus: isReply ? 'skipped' : (result.public.sent ? 'sent' : 'failed'),
    // 'skipped' when this person already had the opener: nothing was sent,
    // and recording that as 'sent' sends someone hunting through Instagram
    // for a message that does not exist.
    dmStatus: result.dm.alreadyThere ? 'skipped' : (result.dm.sent ? 'sent' : 'failed'),
    publicReply: result.public.sent ? texts.publicReply : null,
    lastError: result.dm.alreadyThere
      ? [errors, `@${comment.commenter} sudah menerima pembuka DM sebelumnya — tidak dikirim ulang`]
        .filter(Boolean).join(' · ')
      : (errors || null),
  });

  console.log(
    `[ig-comment] balas @${comment.commenter}: `
    + `publik=${isReply ? 'dilewati (balasan dalam thread)' : (result.public.sent ? 'ok' : 'gagal')} `
    + `dm=${result.dm.alreadyThere ? 'sudah punya' : (result.dm.sent ? 'ok' : 'gagal')}`
    + `${errors ? ` (${errors})` : ''}`,
  );
  return {
    status: result.public.sent || result.dm.sent || result.dm.alreadyThere || isReply ? 'replied' : 'failed',
  };
}

async function record(
  deps: IgCommentReplyDeps, job: IgCommentReplyJob,
  args: {
    publicStatus?: 'sent' | 'failed' | 'skipped'; dmStatus?: 'sent' | 'failed' | 'skipped';
    publicReply?: string | null; lastError?: string | null;
  },
): Promise<void> {
  await withTenant(deps.db, job.tenantId, (tx) =>
    setIgCommentOutcome({ tx, tenantId: job.tenantId, kek: deps.kek }, {
      commentId: job.commentId, ...args,
    }));
}
