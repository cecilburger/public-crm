import { api, type FacebookComment } from '@/lib/api';
import { t } from '@/lib/copy';
import { CommentPostThread } from '@/components/CommentPostThread';

export const dynamic = 'force-dynamic';

/**
 * Every comment left on one Page post, opened inside the existing inbox.
 *
 * The route segment is Facebook's own post id, not a comment's row id — the
 * left list groups comments by the post they were left on (Meta Business
 * Suite's own "Facebook comments" layout: the post on the left, everyone who
 * commented on it together on the right), so this page shows all of them
 * together rather than one at a time. Its own URL space regardless: a post id
 * is never a UUID, so it cannot collide with a conversation id either way.
 *
 * A comment's row id is still accepted in the segment: links minted before
 * the list grouped by post point at one comment, and that comment's post is
 * what they now open — nothing bookmarked or notified goes dead.
 *
 * Read from the list endpoint rather than a per-post route. There is no
 * `/v1/inbox/comments?postId=`, and adding one would create a second way to
 * read data the inbox already holds — and a second place for the permission
 * on it to drift. The list is capped and ordered newest-first, the same
 * window the inbox itself shows, so anything reachable from the list is
 * reachable here.
 */
export default async function CommentPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { comments } = await api<{ comments: FacebookComment[] }>('/v1/inbox/comments?limit=200');
  const postId = comments.some((c) => c.postId === id) ? id : comments.find((c) => c.id === id)?.postId;
  const onThisPost = postId ? comments.filter((c) => c.postId === postId) : [];

  if (!postId || onThisPost.length === 0) {
    return (
      <div className="thread">
        <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
          <h2>{t.inbox.notFound}</h2>
          <p>{t.inbox.pickOneHelp}</p>
        </div>
      </div>
    );
  }

  return <CommentPostThread postId={postId} comments={onThisPost} />;
}
