import { api, type FacebookComment } from '@/lib/api';
import { t } from '@/lib/copy';
import { CommentThread } from '@/components/CommentThread';

export const dynamic = 'force-dynamic';

/**
 * A public comment, opened inside the existing inbox.
 *
 * Its own URL space rather than sharing `/obrolan/[id]`: a comment id and a
 * conversation id are both UUIDs, and one route serving both would turn a
 * mistyped id into either a confusing 404 or, worse, somebody else's thread.
 *
 * Read from the list endpoint rather than a per-id route. There is no
 * `/v1/inbox/comments/:id`, and adding one would create a second way to read
 * data the inbox already holds — and a second place for the permission on it
 * to drift. The list is capped and ordered newest-first, the same window the
 * inbox itself shows, so anything reachable from the list is reachable here.
 */
export default async function CommentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { comments } = await api<{ comments: FacebookComment[] }>('/v1/inbox/comments?limit=200');
  const comment = comments.find((c) => c.id === id);

  if (!comment) {
    return (
      <div className="thread">
        <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
          <h2>{t.inbox.notFound}</h2>
          <p>{t.inbox.pickOneHelp}</p>
        </div>
      </div>
    );
  }

  // Every comment on the same post, not just the one that was clicked — a
  // post's comments are read together, the way they actually sit on
  // Facebook, rather than one at a time behind a separate click each.
  const inPost = comments.filter((c) => c.postId === comment.postId);
  return <CommentThread postId={comment.postId} pageName={comment.pageName} comments={inPost} />;
}
