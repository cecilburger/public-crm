import { t } from '@/lib/copy';
import { ago, clock } from '@/lib/format';
import type { FacebookComment } from '@/lib/api';
import { CommentActions } from '@/components/CommentActions';

/**
 * One Page post, with every comment on it — the layout Meta Business Suite's
 * own "Facebook comments" tab uses: the post named once at the top, every
 * comment left on it listed underneath, each independently repliable.
 *
 * READ-ONLY of `facebook_comments`, same as the single-comment view it
 * replaces. Nothing here writes a conversation, a message or a contact; the
 * only way anything changes is `CommentActions`, per comment, which queues a
 * job for the bridge exactly as it always did.
 *
 * Every comment gets its own actions, not the post one set shared between
 * them: two different people can comment on the same post, and Facebook (and
 * `facebookBridge.ts`'s state machine) tracks a reply and a DM per COMMENT,
 * never per post. Collapsed behind a `<details>` by default — a post with a
 * dozen comments would otherwise open as a dozen open textareas at once.
 */
export function CommentPostThread({ postId, comments }: { postId: string; comments: FacebookComment[] }) {
  const first = comments[0];
  const pageName = first?.pageName || first?.pageId || '';

  return (
    <div className="thread">
      <div className="thread-head">
        <div>
          <strong>{t.inbox.postLabel(postId)}</strong>
          <div className="dim" style={{ fontSize: 12 }}>
            {t.inbox.commentCount(comments.length)} · {pageName}
          </div>
        </div>
        <span className="spacer" />
        <a
          href={`https://www.facebook.com/${postId}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 13 }}
        >
          {t.inbox.openOnFacebook}
        </a>
      </div>

      <div className="scroll" style={{ padding: 16, display: 'grid', gap: 4, alignContent: 'start' }}>
        {comments.map((comment) => {
          const status = t.inbox.commentStatuses[comment.status] ?? comment.status;
          const hasHistory = Boolean(
            comment.publicReplyAt || comment.dmAt || comment.publicReplyError || comment.dmError,
          );

          return (
            <article
              key={comment.id}
              style={{ display: 'grid', gap: 6, padding: '12px 0', borderBottom: '1px solid var(--line)' }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <strong style={{ fontSize: 13.5 }}>{comment.authorName || '—'}</strong>
                <span className="dim tnum" style={{ fontSize: 11.5 }} suppressHydrationWarning>
                  {ago(comment.commentedAt ?? comment.createdAt)}
                </span>
                <span className="spacer" />
                <span className={`chip ${comment.status === 'failed' ? 'warn' : ''}`} style={{ fontSize: 11 }}>
                  {status}
                </span>
              </div>

              {/* Rendered as text, never as markup: this string came from a
                  stranger on the internet by way of a scraper. */}
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{comment.body}</p>

              {hasHistory ? (
                <div style={{ display: 'grid', gap: 2, fontSize: 12 }}>
                  {comment.publicReplyAt ? (
                    <div><span className="dim">{t.inbox.publicReplyAt}:</span> {clock(comment.publicReplyAt)}</div>
                  ) : null}
                  {comment.dmAt ? (
                    <div><span className="dim">{t.inbox.dmAt}:</span> {clock(comment.dmAt)}</div>
                  ) : null}
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
                </div>
              ) : null}

              <details>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--brand)' }}>
                  {t.inbox.replyPublic} · {t.inbox.sendDm}
                </summary>
                <div style={{ marginTop: 8 }}>
                  <CommentActions
                    key={`${comment.id}:${comment.status}:${comment.attempts}`}
                    commentId={comment.id}
                    status={comment.status}
                  />
                </div>
              </details>
            </article>
          );
        })}
      </div>
    </div>
  );
}
