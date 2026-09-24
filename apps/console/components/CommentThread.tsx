import { t } from '@/lib/copy';
import { ago, clock } from '@/lib/format';
import type { FacebookComment } from '@/lib/api';
import { CommentActions } from '@/components/CommentActions';

/**
 * One public comment, opened from the inbox.
 *
 * READ-ONLY, AND HONESTLY SO. Opening a comment writes nothing: no
 * conversation, no message, no contact. It is a view over the
 * `facebook_comments` row and nothing else, which is what stops a public
 * comment from quietly becoming a private thread in the CRM.
 *
 * The two actions at the bottom are the one way anything changes, and they
 * go through the comment's own state machine (see `CommentActions`): a job is
 * queued, the bridge acts in a real browser, and the row records what came of
 * it. A conversation appears only on the worker, only after Facebook
 * confirmed a private message went out — never from a click on this page.
 *
 * Rendered inside the same `.thread` panel the conversation view uses, with
 * the same chips and spacing, so the inbox does not change shape depending on
 * which kind of item happens to be selected.
 */
export function CommentThread({ comment }: { comment: FacebookComment }) {
  const status = t.inbox.commentStatuses[comment.status] ?? comment.status;
  const hasHistory = Boolean(
    comment.publicReplyAt || comment.dmAt || comment.publicReplyError || comment.dmError || comment.attempts > 0,
  );

  return (
    <div className="thread">
      <div className="thread-head">
        <div>
          <strong>{comment.authorName || '—'}</strong>
          <div className="dim" style={{ fontSize: 12 }}>
            {t.inbox.commenter} · {t.inbox.channelFacebookComment}
          </div>
        </div>
        <span className="spacer" />
        <span className="chip">{comment.pageName || comment.pageId}</span>
        <span className={`chip ${comment.status === 'failed' ? 'warn' : ''}`}>{status}</span>
      </div>

      {/* `alignContent: start` matters more than it looks. `.scroll` carries
          `flex: 1`, so a grid inside it stretches its rows to fill the whole
          column by default — which pushed the comment body to the bottom of
          the panel with a screen-high gap above it. */}
      <div className="scroll" style={{ padding: 16, display: 'grid', gap: 16, alignContent: 'start' }}>
        <section>
          <h3 className="dim" style={{ fontSize: 12, margin: '0 0 6px' }}>{t.inbox.postContext}</h3>
          <p style={{ margin: 0 }}>
            {t.inbox.commentOn} <span className="tnum">{comment.postId}</span>
          </p>
          <a
            href={`https://www.facebook.com/${comment.postId}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 13 }}
          >
            {t.inbox.openOnFacebook}
          </a>
        </section>

        <section>
          <h3 className="dim" style={{ fontSize: 12, margin: '0 0 6px' }}>{t.inbox.commentBody}</h3>
          {/* Rendered as text, never as markup: this string came from a
              stranger on the internet by way of a scraper. */}
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{comment.body}</p>
          <p className="dim" style={{ fontSize: 12, margin: '6px 0 0' }} suppressHydrationWarning>
            {ago(comment.commentedAt ?? comment.createdAt)}
          </p>
        </section>

        {/* Both steps are reported, because they fail independently: a public
            reply that landed stays visible even when the private message
            afterwards did not. Every line here comes from the row — the only
            record of what actually happened on Facebook — never from a click
            on this page, which only ever queues. */}
        {hasHistory ? (
          <section style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            {comment.publicReplyAt ? (
              <div><span className="dim">{t.inbox.publicReplyAt}:</span> {clock(comment.publicReplyAt)}</div>
            ) : null}
            {comment.dmAt ? (
              <div><span className="dim">{t.inbox.dmAt}:</span> {clock(comment.dmAt)}</div>
            ) : null}
            {comment.attempts > 0 ? (
              <div><span className="dim">{t.inbox.attempts}:</span> {comment.attempts}</div>
            ) : null}
            {/* The stored reasons are written by the worker for a person to
                read (a dead session, "Facebook offers no private reply here"),
                so they are shown verbatim rather than paraphrased. */}
            {comment.publicReplyError ? (
              <div style={{ color: 'var(--danger)' }}>
                <span className="dim">{t.inbox.publicReplyError}:</span> {comment.publicReplyError}
              </div>
            ) : null}
            {comment.dmError ? (
              <div style={{ color: 'var(--danger)' }}>
                <span className="dim">{t.inbox.dmError}:</span> {comment.dmError}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      {/* Keyed on status and attempts: `attempts` moves on every claim, so
          even a retry that lands back on the same status remounts the forms
          clean. See `CommentActions` for what that resets. */}
      <CommentActions
        key={`${comment.status}:${comment.attempts}`}
        commentId={comment.id}
        status={comment.status}
      />
    </div>
  );
}
