import { api, type IgComment } from '@/lib/api';
import { t } from '@/lib/copy';
import { IgPostThread } from '@/components/IgPostThread';

export const dynamic = 'force-dynamic';

/**
 * Every comment on one postingan, opened inside `/komentar-ig`. `id` here is
 * a `postRef` (URL-encoded by `IgCommentList`), not a comment id — the list
 * groups by post, so this is the id it actually links to.
 */
export default async function IgPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postRef = decodeURIComponent(id);
  const comments = await api<IgComment[]>('/v1/ig-comments');
  const inPost = comments.filter((c) => c.postRef === postRef);

  if (inPost.length === 0) {
    return (
      <div className="thread">
        <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
          <h2>{t.inbox.notFound}</h2>
          <p>{t.chats.pickOneHelp}</p>
        </div>
      </div>
    );
  }

  return <IgPostThread postRef={postRef} comments={inPost} />;
}
