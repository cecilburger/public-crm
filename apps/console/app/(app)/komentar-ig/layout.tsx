import { api, type IgComment } from '@/lib/api';
import { t } from '@/lib/copy';
import { IgCommentList } from '@/components/IgCommentList';

export const dynamic = 'force-dynamic';

/**
 * Same shape as `obrolan/layout.tsx`: a topbar, a `.inbox` grid holding the
 * list on the left and whichever comment is open (`children`, from
 * `[id]/page.tsx`) on the right. Its own list rather than reusing
 * `ConversationList` — see `IgCommentList`'s own doc for why this page stays
 * separate from the combined Obrolan inbox.
 */
export default async function IgCommentsLayout({ children }: { children: React.ReactNode }) {
  const comments = await api<IgComment[]>('/v1/ig-comments');
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
      <div className="inbox">
        <IgCommentList comments={comments} />
        {children}
      </div>
    </>
  );
}
