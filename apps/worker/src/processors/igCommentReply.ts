import {
  withTenant, getIgComment, setIgCommentOutcome, upsertContactByIgUsername, ensureConversation,
  recordIgBridgeAgentReply, seedBdConversationState, type Database,
} from '@kirana/db';
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

/** The node the flow expects a commenter's first DM reply at: the opener has
 * asked the qualification question (`bd_bot.models.Node.INBOUND_QUALIFY`). */
export const NODE_AFTER_COMMENT_OPENER = 'inbound_qualify';

/** The provider id the opener is stored under — one per comment, so a
 * re-run records it once, and distinct from the bridge watcher's own keys. */
export const commentOpenerMessageKey = (tenantId: string, commentId: string): string =>
  `ig_comment_dm:${tenantId}:${commentId}`;

/**
 * Answer one comment the way the bot was designed to: a short line in public,
 * the actual reply in DM.
 *
 * The public line deliberately says almost nothing — the BD team's own rule
 * is not to explain under a post, because everyone scrolling past reads it,
 * including competitors, and a commenter who has already been answered has no
 * reason to open the DM that is the whole point. Both texts come from the
 * brain (`apps/bd-brain`, `/v1/comment-reply`), so the bot's templates remain
 * the single place its words are written.
 *
 * Neither half is retried into a loop. A public reply Instagram refuses is
 * refusing the pace or the content, and asking again shortly is how an
 * account earns an action block — the row records the failure and the page
 * shows it, for a person to decide about.
 *
 * Once the opener is in the commenter's DMs, the flow has to be told: the
 * opener asks for their brand, so their first reply is the answer to that
 * question and must arrive at `inbound_qualify`. Before this (24 Sep 2026)
 * the DM conversation did not exist in the CRM until the commenter wrote
 * back, so `bd.draft` stepped their reply from `new` and sent the
 * qualification form — the same questions a second time. `seedAfterOpener`
 * is the bot's `MetaTransport._seed` on this side: create the conversation,
 * record the opener on it, and set the node only if the person has no state
 * yet. Someone who already talked to us keeps their place.
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

  // Sent now, or found already sitting in their DMs from an earlier run that
  // did not get as far as this write: either way the opener is in front of
  // them and the flow must know. Never for a failed DM — there is nothing to
  // be at `inbound_qualify` about.
  let seeded: { conversationId: string; contactId: string; seeded: boolean } | null = null;
  if (result.dm.sent || result.dm.alreadyThere) {
    try {
      seeded = await seedAfterOpener(deps, job, {
        commenter: comment.commenter, threadId: result.dm.threadId, opener: texts.dmOpener,
      });
    } catch (err) {
      // The DM went out; losing the seed costs one repeated question, not
      // the lead. Say so rather than fail a job whose side effect is done.
      console.error(`[ig-comment] could not seed BD state for @${comment.commenter}:`, (err as Error).message);
    }
  }

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
    ...(seeded ? { conversationId: seeded.conversationId, contactId: seeded.contactId } : {}),
    lastError: result.dm.alreadyThere
      ? [errors, `@${comment.commenter} sudah menerima pembuka DM sebelumnya — tidak dikirim ulang`]
        .filter(Boolean).join(' · ')
      : (errors || null),
  });

  console.log(
    `[ig-comment] balas @${comment.commenter}: `
    + `publik=${isReply ? 'dilewati (balasan dalam thread)' : (result.public.sent ? 'ok' : 'gagal')} `
    + `dm=${result.dm.alreadyThere ? 'sudah punya' : (result.dm.sent ? 'ok' : 'gagal')}`
    + `${seeded ? ` state=${seeded.seeded ? NODE_AFTER_COMMENT_OPENER : 'sudah ada, dibiarkan'}` : ''}`
    + `${errors ? ` (${errors})` : ''}`,
  );
  return {
    status: result.public.sent || result.dm.sent || result.dm.alreadyThere || isReply ? 'replied' : 'failed',
  };
}

/**
 * Put the opener on the commenter's DM conversation and park the flow at
 * `inbound_qualify` — only for a conversation the flow has never seen.
 *
 * The contact is keyed by the @username, the same key
 * `ingestInboundInstagramDmMessage` uses when their reply arrives, so the
 * reply lands on this conversation and not a second one. The opener itself
 * is recorded as an agent reply (never queued — it is already in their
 * inbox) so the transcript reads correctly and the brain sees it as our last
 * message. Without a thread id from the bridge the message cannot be filed
 * against the thread; the conversation and the state are still seeded.
 */
export async function seedAfterOpener(
  deps: IgCommentReplyDeps, job: IgCommentReplyJob,
  args: { commenter: string; threadId?: string; opener: string; now?: Date },
): Promise<{ conversationId: string; contactId: string; seeded: boolean }> {
  const now = args.now ?? new Date();
  return withTenant(deps.db, job.tenantId, async (tx) => {
    const ctx = { tx, tenantId: job.tenantId, kek: deps.kek };
    const channels = await tx.query<{ id: string }>(
      `select id from channels where tenant_id = $1 and kind = 'instagram_bridge' and status <> 'disabled'
        order by created_at limit 1`,
      [job.tenantId],
    );
    const channelId = channels[0]?.id;
    if (!channelId) throw new Error("no 'instagram_bridge' channel — connect Instagram from Pengaturan → Instagram");

    let conversationId: string;
    let contactId: string;
    if (args.threadId) {
      const recorded = await recordIgBridgeAgentReply(ctx, {
        channelId, username: args.commenter, threadId: args.threadId, body: args.opener,
        providerMessageId: commentOpenerMessageKey(job.tenantId, job.commentId),
        displayName: args.commenter, now,
      });
      ({ conversationId, contactId } = recorded);
    } else {
      const contact = await upsertContactByIgUsername(ctx, { username: args.commenter, displayName: args.commenter, now });
      const conversation = await ensureConversation(ctx, { contactId: contact.id, channelId, now });
      conversationId = conversation.id;
      contactId = contact.id;
    }

    const seeded = await seedBdConversationState(ctx, {
      conversationId, node: NODE_AFTER_COMMENT_OPENER, now,
    });
    return { conversationId, contactId, seeded };
  });
}

async function record(
  deps: IgCommentReplyDeps, job: IgCommentReplyJob,
  args: {
    publicStatus?: 'sent' | 'failed' | 'skipped'; dmStatus?: 'sent' | 'failed' | 'skipped';
    publicReply?: string | null; lastError?: string | null;
    conversationId?: string | null; contactId?: string | null;
  },
): Promise<void> {
  await withTenant(deps.db, job.tenantId, (tx) =>
    setIgCommentOutcome({ tx, tenantId: job.tenantId, kek: deps.kek }, {
      commentId: job.commentId, ...args,
    }));
}
