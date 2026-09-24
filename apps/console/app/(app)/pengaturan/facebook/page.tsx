import { api, type FbBridgeConnection, type FacebookComment } from '@/lib/api';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { FacebookBridgeForm } from '@/components/FacebookBridgeForm';
import { DivisionBadge } from '@/components/DivisionBadge';

export const dynamic = 'force-dynamic';

/**
 * Pengaturan → Facebook.
 *
 * Reads only. Connecting hands the bridge a Page to watch and nothing else,
 * and the comment list below is a record of what came in — there is no reply
 * box anywhere on this page because the bridge cannot send.
 */
export default async function FacebookSettingsPage() {
  // The comment list is a nice-to-have next to the connection itself: a Page
  // that has never been connected has no comments either, and failing the whole
  // page over that would hide the very form used to fix it.
  const [connection, comments] = await Promise.all([
    api<FbBridgeConnection>('/v1/facebook-bridge/status'),
    api<{ comments: FacebookComment[] }>('/v1/facebook-bridge/comments?limit=20')
      .then((r) => r.comments)
      .catch(() => [] as FacebookComment[]),
  ]);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.facebookBridge.title}</h1>
        </div>
        <span className="spacer" />
        <DivisionBadge />
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <FacebookBridgeForm connection={connection} />

        <div className="panel">
          <header><h2>{t.facebookBridge.commentsTitle}</h2></header>
          <div className="body stack" style={{ gap: 12 }}>
            <p className="record-hint" style={{ margin: 0 }}>{t.facebookBridge.commentsHint}</p>
            {comments.length === 0 ? (
              <p className="dim" style={{ margin: 0 }}>{t.facebookBridge.commentsEmpty}</p>
            ) : (
              <ul className="stack" style={{ gap: 10, margin: 0, padding: 0, listStyle: 'none' }}>
                {comments.map((comment) => (
                  <li key={comment.id} className="stack" style={{ gap: 2 }}>
                    <p style={{ margin: 0, fontWeight: 600 }}>{comment.authorName ?? '—'}</p>
                    <p style={{ margin: 0 }}>{comment.body}</p>
                    <p className="mono dim" style={{ fontSize: 12, margin: 0 }}>
                      {t.facebookBridge.commentOnPost(comment.postId)}
                      {comment.commentedAt
                        ? ` · ${new Date(comment.commentedAt).toLocaleString('id-ID')}`
                        : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
