import { api, type FacebookComment } from '@/lib/api';
import { t } from '@/lib/copy';
import { FbCommentList } from '@/components/FbCommentList';
import { groupCommentsByPost } from '@/lib/inbox';

export const dynamic = 'force-dynamic';

/**
 * Same shape as `komentar-ig/layout.tsx`: a topbar, a `.inbox` grid holding
 * the list on the left and whichever post is open (`children`, from
 * `[id]/page.tsx`) on the right. Its own dedicated page rather than only
 * living inside the combined Obrolan inbox — same reasoning as Chat IG /
 * Komentar IG getting their own rail entries.
 */
export default async function FbCommentsLayout({ children }: { children: React.ReactNode }) {
  const { comments } = await api<{ comments: FacebookComment[] }>('/v1/inbox/comments?limit=200');
  const pendingCount = groupCommentsByPost(comments).filter((g) => g.needsReply).length;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.fbComments.title}</h1>
          <p className="subtitle">{t.fbComments.subtitle}</p>
        </div>
        <span className="spacer" />
        {pendingCount > 0 ? <span className="chip warn">{pendingCount} {t.fbComments.tabPending}</span> : null}
      </div>
      <div className="inbox">
        <FbCommentList comments={comments} />
        {children}
      </div>
    </>
  );
}
