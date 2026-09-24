import { t } from '@/lib/copy';
import { ago } from '@/lib/format';
import type { FacebookComment } from '@/lib/api';
import { CommentActions } from '@/components/CommentActions';

/**
 * Every comment on one postingan, opened from the inbox — grouped the way a
 * real Facebook post's comment section actually reads, not one comment
 * behind a separate click each. (The single-comment card this replaced
 * showed exactly one row no matter how many other comments sat on the same
 * post; the reference this was redesigned against is the grouped Instagram
 * equivalent, `IgPostThread`.)
 *
 * READ-ONLY, AND HONESTLY SO. Opening a post writes nothing: no
 * conversation, no message, no contact. It is a view over the
 * `facebook_comments` rows for this post and nothing else, which is what
 * stops a public comment from quietly becoming a private thread in the CRM.
 *
 * The reply/DM controls per comment (`CommentActions`) are the one way
 * anything changes, and they go through the comment's own state machine: a
 * job is queued, the bridge acts in a real browser, and the row records what
 * came of it. Collapsed behind a `<details>` per comment — "▶ Balas publik ·
 * Kirim DM" — so a post with several comments does not open with every
 * composer already expanded.
 */
export function CommentThread({
  postId, pageName, comments,
}: { postId: string; pageName: string | null; comments: FacebookComment[] }) {
  const sorted = [...comments].sort((a, b) =>
    (b.commentedAt ?? b.createdAt).localeCompare(a.commentedAt ?? a.createdAt));

  return (
    <div className="thread">
      <div className="thread-head">
        <div>
          <strong>{t.inbox.postContext} {postId}</strong>
          <div className="dim" style={{ fontSize: 12 }}>
            {comments.length} {t.igComments.commentCount}{pageName ? ` · ${pageName}` : ''}
          </div>
        </div>
        <span className="spacer" />
        <a href={`https://www.facebook.com/${postId}`} target="_blank" rel="noopener noreferrer"
           className="btn ghost sm">
          {t.inbox.openOnFacebook}
        </a>
      </div>

      <div className="scroll" style={{ padding: '4px 16px' }}>
        {sorted.map((c) => {
          const status = t.inbox.commentStatuses[c.status] ?? c.status;
          const hasHistory = Boolean(
            c.publicReplyAt || c.dmAt || c.publicReplyError || c.dmError || c.attempts > 0,
          );
          return (
            <div key={c.id} style={{ padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14 }}>{c.authorName || '—'}</strong>
                <span className="dim" style={{ fontSize: 12 }} suppressHydrationWarning>
                  {ago(c.commentedAt ?? c.createdAt)}
                </span>
                <span className={`chip ${c.status === 'failed' ? 'danger' : c.status === 'public_replied' || c.status === 'dm_sent' ? 'good' : ''}`}>
                  {status}
                </span>
              </div>

              {/* Rendered as text, never as markup: this string came from a
                  stranger on the internet by way of a scraper. */}
              <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{c.body}</p>

              {hasHistory ? (
                <div style={{ marginTop: 4, fontSize: 12, display: 'grid', gap: 2 }}>
                  {c.publicReplyAt ? (
                    <div><span className="dim">{t.inbox.publicReplyAt}:</span> {ago(c.publicReplyAt)}</div>
                  ) : null}
                  {c.publicReplyError ? (
                    <div style={{ color: 'var(--danger)' }}>
                      <span className="dim">{t.inbox.publicReplyError}:</span> {c.publicReplyError}
                    </div>
                  ) : null}
                  {c.dmError ? (
                    <div style={{ color: 'var(--danger)' }}>
                      <span className="dim">{t.inbox.dmError}:</span> {c.dmError}
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
                  <CommentActions key={`${c.status}:${c.attempts}`} commentId={c.id} status={c.status} />
                </div>
              </details>
            </div>
          );
        })}
      </div>
    </div>
  );
}
