import { api, type FacebookComment } from '@/lib/api';
import { t } from '@/lib/copy';
import { CommentPostThread } from '@/components/CommentPostThread';

export const dynamic = 'force-dynamic';

/**
 * Every comment on one Page post, opened inside `/komentar-fb`. `id` here is
 * a Facebook post id — the list groups by post — but a comment's own row id
 * is still accepted, the same fallback `obrolan/komentar/[id]` gives: a link
 * minted before the grouping still opens the post it now lives under.
 */
export default async function FbPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { comments } = await api<{ comments: FacebookComment[] }>('/v1/inbox/comments?limit=200');
  const postId = comments.some((c) => c.postId === id) ? id : comments.find((c) => c.id === id)?.postId;
  const onThisPost = postId ? comments.filter((c) => c.postId === postId) : [];

  if (!postId || onThisPost.length === 0) {
    return (
      <div className="thread">
        <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
          <h2>{t.inbox.notFound}</h2>
          <p>{t.chats.pickOneHelp}</p>
        </div>
      </div>
    );
  }

  return <CommentPostThread postId={postId} comments={onThisPost} />;
}
