import { api, type IgComment } from '@/lib/api';
import { t } from '@/lib/copy';
import { ago } from '@/lib/format';
import { CopyButton } from '@/components/CopyButton';
import { CsrfField } from '@/components/Csrf';
import { recordCommentOutcome } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * Comments on our own posts, and the one short line each gets in public.
 *
 * The reply is written here but posted by the agent in Instagram itself.
 * That is on purpose while the account's session is as fragile as it is:
 * reading a post is quiet, posting to one is the loud half, and doing the
 * loud half by hand keeps automation off the public side of the account.
 * Turning it into a one-click send later is a change to this button, not to
 * anything behind it.
 */
export default async function IgCommentsPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const pendingOnly = tab === 'pending';
  const comments = await api<IgComment[]>(`/v1/ig-comments${pendingOnly ? '?pending=true' : ''}`);
  const pendingCount = comments.filter((c) => c.publicStatus === 'pending' || c.publicStatus === 'failed').length;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.igComments.title}</h1>
          <p className="subtitle">{t.igComments.subtitle}</p>
        </div>
        <span className="spacer" />
        {pendingCount > 0 ? <span className="chip warn">{pendingCount} {t.igComments.tabPending}</span> : null}
      </div>

      <div className="scroll pad stack">
        <div style={{ display: 'flex', gap: 8 }}>
          <a href="/komentar-ig" className={`btn sm ${pendingOnly ? 'ghost' : 'primary'}`}>{t.igComments.tabAll}</a>
          <a href="/komentar-ig?tab=pending" className={`btn sm ${pendingOnly ? 'primary' : 'ghost'}`}>
            {t.igComments.tabPending}
          </a>
        </div>

        {comments.length === 0 ? (
          <div className="panel"><div className="body"><p className="empty">{t.igComments.empty}</p></div></div>
        ) : comments.map((c) => (
          <div className="panel" key={c.id}>
            <header>
              <h2>@{c.commenter}</h2>
              <span className="dim" style={{ fontSize: 12 }}>
                {ago(c.commentedAt ?? c.createdAt)} · {t.igComments.onPost} {c.postRef}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {c.publicStatus === 'sent' ? <span className="chip good">{t.igComments.statusPublicSent}</span> : null}
                {c.publicStatus === 'pending' ? <span className="chip warn">{t.igComments.statusPublicPending}</span> : null}
                {c.publicStatus === 'skipped' ? <span className="chip">{t.igComments.statusPublicSkipped}</span> : null}
                {c.publicStatus === 'failed' ? <span className="chip danger">{t.igComments.statusPublicFailed}</span> : null}
                {c.dmStatus === 'sent' ? <span className="chip good">{t.igComments.statusDmSent}</span> : null}
                {c.dmStatus === 'failed' ? <span className="chip danger">{t.igComments.statusDmFailed}</span> : null}
              </div>
            </header>

            <div className="body stack">
              <blockquote style={{ margin: 0, fontSize: 14 }}>{c.text}</blockquote>

              {/* Anything that is not already answered in public still needs a
                  way to be answered by hand — especially a failed one. Showing
                  these only while `pending` meant the bot failing took the
                  manual controls away with it, exactly when they were needed. */}
              {c.publicStatus !== 'sent' && c.publicStatus !== 'skipped' ? (
                <>
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
                </>
              ) : null}

              {c.lastError ? <p className="dim" style={{ fontSize: 12 }}>{c.lastError}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
