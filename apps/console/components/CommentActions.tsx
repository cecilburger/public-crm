'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { replyCommentPublic, sendCommentDm, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { canReplyPublic, canSendDm } from '@/lib/inbox';
import { CsrfField } from '@/components/Csrf';
import type { FacebookCommentStatus } from '@/lib/api';

/** The worker holds the comment in these states. Nothing an agent clicks
 * should race a browser that is mid-typing on a customer's post. */
function isProcessing(status: FacebookCommentStatus): boolean {
  return status === 'public_reply_pending' || status === 'dm_pending';
}

/**
 * Why a form is off, in one sentence — or null when it is on.
 *
 * The processing case is deliberately not here: it applies to both forms at
 * once, so it is said once, above them, by the chip.
 */
function replyDisabledReason(status: FacebookCommentStatus): string | null {
  if (canReplyPublic(status) || isProcessing(status)) return null;
  return t.inbox.replyPublicDone;
}

function dmDisabledReason(status: FacebookCommentStatus): string | null {
  if (canSendDm(status) || isProcessing(status)) return null;
  return status === 'dm_sent' ? t.inbox.dmDone : t.inbox.dmNeedsReply;
}

interface ActionFormProps {
  id: string;
  label: string;
  commentId: string;
  defaultText: string;
  submitLabel: string;
  queuedNote: string;
  action: (form: FormData) => void;
  state: ActionResult | null;
  pending: boolean;
  /** Something is in flight — this form's submit, the other form's, or the
   * worker. Any of the three locks both forms, so two jobs are never queued
   * against one comment from one screen. */
  locked: boolean;
  disabledReason: string | null;
}

/**
 * One form, used twice, so the two actions cannot drift apart: the same
 * disabled rules, the same error placement, the same "queued" wording.
 *
 * The textarea is prefilled rather than empty. The default is what the
 * automatic sweep would send, so an agent replying by hand starts from the
 * house wording and edits it, instead of composing from nothing under a
 * customer's open comment.
 */
function CommentActionForm(props: ActionFormProps) {
  const off = props.locked || props.disabledReason !== null;

  return (
    <form action={props.action} style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
      <CsrfField />
      <input type="hidden" name="commentId" value={props.commentId} />
      <div className="record-field">
        <label htmlFor={props.id}>{props.label}</label>
        <textarea className="line-input" id={props.id} name="text" rows={2} required
                  defaultValue={props.defaultText} disabled={off} />
        {props.disabledReason ? <p className="record-hint" style={{ margin: 0 }}>{props.disabledReason}</p> : null}
      </div>
      {props.state?.ok === false ? <p className="error" role="alert">{props.state.error}</p> : null}
      {props.state?.ok ? <p className="record-hint" style={{ margin: 0 }}>{props.queuedNote}</p> : null}
      <div>
        <button type="submit" className="btn primary sm" disabled={off}>
          {props.pending ? t.inbox.sending : props.submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * The two things an agent can do to a public comment, in the order they come:
 * reply on the post, then message the commenter privately.
 *
 * NEITHER HAPPENS HERE. Each submit queues a job; the bridge types the text
 * into a real browser on another machine and the row's status records what
 * came of it. So this component decides only whether to OFFER a step, from
 * the status the server just rendered — `canReplyPublic` / `canSendDm`, the
 * same rules the state machine in `packages/db` enforces on claim. A stale
 * page that offers a button the server would refuse gets a 409 and shows it;
 * it never gets a second reply on the customer's post.
 *
 * The parent mounts this keyed on status and attempts, so every state change
 * the server reports remounts it clean: the "queued" note lives exactly as
 * long as it is true, and a fresh form appears the moment a retry is allowed.
 */
export function CommentActions({ commentId, status }: { commentId: string; status: FacebookCommentStatus }) {
  const router = useRouter();
  const [replyState, replyAction, replyPending] =
    useActionState<ActionResult | null, FormData>(replyCommentPublic, null);
  const [dmState, dmAction, dmPending] =
    useActionState<ActionResult | null, FormData>(sendCommentDm, null);

  // A 202 changed the row on the server, not this page. The action already
  // revalidated the comment route; refreshing here makes the processing chip
  // appear now rather than on the inbox's next auto-refresh tick.
  useEffect(() => {
    if (replyState?.ok || dmState?.ok) router.refresh();
  }, [replyState, dmState, router]);

  const processing = isProcessing(status);
  const locked = processing || replyPending || dmPending;

  return (
    <div className="composer" style={{ display: 'grid', gap: 12 }}>
      {processing ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="chip brand">{t.inbox.commentStatuses[status] ?? status}</span>
          <span className="dim" style={{ fontSize: 12 }}>{t.inbox.processing}</span>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
        <CommentActionForm
          id="comment-reply-text"
          label={t.inbox.replyPublicLabel}
          commentId={commentId}
          defaultText={t.inbox.replyPublicDefault}
          submitLabel={t.inbox.replyPublic}
          queuedNote={t.inbox.replyQueued}
          action={replyAction}
          state={replyState}
          pending={replyPending}
          locked={locked}
          disabledReason={replyDisabledReason(status)}
        />
        <CommentActionForm
          id="comment-dm-text"
          label={t.inbox.dmLabel}
          commentId={commentId}
          defaultText={t.inbox.dmDefault}
          submitLabel={t.inbox.sendDm}
          queuedNote={t.inbox.dmQueued}
          action={dmAction}
          state={dmState}
          pending={dmPending}
          locked={locked}
          disabledReason={dmDisabledReason(status)}
        />
      </div>
    </div>
  );
}
