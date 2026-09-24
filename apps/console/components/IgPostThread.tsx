import { t } from '@/lib/copy';
import { ago } from '@/lib/format';
import type { IgComment } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { CsrfField } from '@/components/Csrf';
import { recordCommentOutcome } from '@/app/(app)/actions';

function statusLabel(c: IgComment): string {
  if (c.publicStatus === 'sent') return t.igComments.statusPublicSent;
  if (c.publicStatus === 'skipped') return t.igComments.statusPublicSkipped;
  if (c.publicStatus === 'failed') return t.igComments.statusPublicFailed;
  return t.igComments.statusPublicPending;
}

/**
 * Every comment on one postingan, opened from the grouped `/komentar-ig`
 * list — the Instagram counterpart to opening a Facebook post's comment
 * thread in Obrolan. All of them share the panel, newest first, because
 * that is how a person actually reads a post's comments: together, not one
 * at a time behind six separate clicks.
 *
 * The reply/DM controls per comment sit inside a native `<details>`,
 * collapsed by default — the same "▶ Balas publik · Kirim DM" a Facebook
 * comment thread shows, without needing client-side state to track which
 * row is open. Still manual, still never sent from here: see
 * `IgCommentList`'s doc and the module comment this replaced for why
 * posting to Instagram stays a thing an agent does by hand.
 */
export function IgPostThread({ postRef, comments }: { postRef: string; comments: IgComment[] }) {
  const sorted = [...comments].sort((a, b) =>
    (b.commentedAt ?? b.createdAt).localeCompare(a.commentedAt ?? a.createdAt));

  return (
    <div className="thread">
      <div className="thread-head">
        <div>
          <strong>{t.inbox.postContext} {postRef}</strong>
          <div className="dim" style={{ fontSize: 12 }}>
            {comments.length} {t.igComments.commentCount}
          </div>
        </div>
      </div>

      <div className="scroll" style={{ padding: 16, display: 'grid', gap: 12, alignContent: 'start' }}>
        {sorted.map((c) => {
          const needsAction = c.publicStatus !== 'sent' && c.publicStatus !== 'skipped';
          return (
            <div className="panel" key={c.id}>
              <header>
                <h2 style={{ fontSize: 14 }}>@{c.commenter}</h2>
                <span className="dim" style={{ fontSize: 12 }} suppressHydrationWarning>
                  {ago(c.commentedAt ?? c.createdAt)}
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <span className={`chip ${c.publicStatus === 'failed' ? 'danger' : c.publicStatus === 'sent' ? 'good' : ''}`}>
                    {statusLabel(c)}
                  </span>
                  {c.dmStatus === 'sent' ? <span className="chip good">{t.igComments.statusDmSent}</span> : null}
                  {c.dmStatus === 'failed' ? <span className="chip danger">{t.igComments.statusDmFailed}</span> : null}
                </div>
              </header>

              <div className="body stack">
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{c.text}</p>
                {c.lastError ? <p className="dim" style={{ fontSize: 12, color: 'var(--danger)' }}>{c.lastError}</p> : null}

                {needsAction ? (
                  <details>
                    <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                      {t.inbox.replyPublic} · {t.igComments.markSent}
                    </summary>
                    <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                      <div>
                        <span className="dim" style={{ fontSize: 12 }}>{t.igComments.draftLabel}</span>
                        <div className="panel" style={{ marginTop: 6, padding: '10px 12px' }}>
                          {c.publicReply ?? t.igComments.draftPublicReply}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <CopyButton text={c.publicReply ?? t.igComments.draftPublicReply}
                                    label={t.igComments.copy} copiedLabel={t.igComments.copied} />
                        <form action={recordCommentOutcome}>
                          <CsrfField />
                          <input type="hidden" name="commentId" value={c.id} />
                          <input type="hidden" name="publicStatus" value="sent" />
                          <button className="btn primary sm" type="submit">{t.igComments.markSent}</button>
                        </form>
                        <form action={recordCommentOutcome}>
                          <CsrfField />
                          <input type="hidden" name="commentId" value={c.id} />
                          <input type="hidden" name="publicStatus" value="skipped" />
                          <button className="btn ghost sm" type="submit">{t.igComments.skip}</button>
                        </form>
                      </div>
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
