import { t } from '@/lib/copy';
import { ago } from '@/lib/format';
import type { FacebookComment } from '@/lib/api';
import { postOfComments } from '@/lib/inbox';
import { POST_TITLE_MAX, detailSubtitle, postHeading } from '@/lib/facebookPost';
import { CommentActions } from '@/components/CommentActions';

/**
 * One Page post, with every comment on it — the layout Meta Business Suite's
 * own "Facebook comments" tab uses: the post named once at the top, every
 * comment left on it listed underneath, each independently repliable. Styled
 * the same way as its Instagram counterpart (`IgPostThread`): a flat list of
 * rows divided by a thin line, not a card per comment.
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
  const sorted = [...comments].sort((a, b) =>
    (b.commentedAt ?? b.createdAt).localeCompare(a.commentedAt ?? a.createdAt));
  // Named by what the post says; `postId` stays what it links and replies by.
  const heading = postHeading(postOfComments(comments), { max: POST_TITLE_MAX.detail, dateStyle: 'long' });

  return (
    <div className="thread">
      <div className="thread-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{heading.title}</strong>
          <div className="dim" style={{ fontSize: 12 }} suppressHydrationWarning>
            {detailSubtitle(heading, comments.length)}
          </div>
          {/* The whole caption, lines kept, once the title had to cut it. Text,
              never markup: it is the Page's words, read off Facebook. */}
          {heading.truncated && heading.fullText ? (
            <details style={{ marginTop: 4, fontSize: 12 }}>
              <summary style={{ cursor: 'pointer' }}>{t.inbox.postFullCaption}</summary>
              <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{heading.fullText}</p>
            </details>
          ) : null}
        </div>
        <span className="spacer" />
        <a href={`https://www.facebook.com/${postId}`} target="_blank" rel="noopener noreferrer"
           className="btn ghost sm">
          {t.inbox.openOnFacebook}
        </a>
      </div>

      <div className="scroll" style={{ padding: '4px 16px' }}>
        {sorted.map((comment) => {
          const status = t.inbox.commentStatuses[comment.status] ?? comment.status;
          const hasHistory = Boolean(
            comment.publicReplyAt || comment.dmAt || comment.publicReplyError || comment.dmError,
          );
          const tone = comment.status === 'failed'
            ? 'danger'
            : comment.status === 'public_replied' || comment.status === 'dm_sent' ? 'good' : '';

          return (
            <article key={comment.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14 }}>{comment.authorName || '—'}</strong>
                <span className="dim" style={{ fontSize: 12 }} suppressHydrationWarning>
                  {ago(comment.commentedAt ?? comment.createdAt)}
                </span>
                <span className={`chip ${tone}`}>{status}</span>
              </div>

              {/* Rendered as text, never as markup: this string came from a
                  stranger on the internet by way of a scraper. */}
              <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{comment.body}</p>

              {/* Both steps are reported, because they fail independently: a
                  public reply that landed stays visible even when the private
                  message afterwards did not. Every line comes from the row —
                  the only record of what actually happened on Facebook. */}
              {hasHistory ? (
                <div style={{ marginTop: 4, fontSize: 12, display: 'grid', gap: 2 }}>
                  {comment.publicReplyAt ? (
                    <div><span className="dim">{t.inbox.publicReplyAt}:</span> {ago(comment.publicReplyAt)}</div>
                  ) : null}
                  {comment.dmAt ? (
                    <div><span className="dim">{t.inbox.dmAt}:</span> {ago(comment.dmAt)}</div>
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

              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                  {t.inbox.replyPublic} · {t.inbox.sendDm}
                </summary>
                <div style={{ marginTop: 8 }}>
                  {/* Keyed on status and attempts: `attempts` moves on every
                      claim, so even a retry that lands back on the same
                      status remounts the forms clean. */}
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
