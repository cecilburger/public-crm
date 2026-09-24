import { api, type ConversationSummary, type FacebookComment } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';
import { ConversationList } from '@/components/ConversationList';
import { AutoRefresh } from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function ChatsLayout({ children }: { children: React.ReactNode }) {
  // Fetched together rather than one after the other: neither depends on the
  // other, and a waterfall here is paid on every single inbox load.
  const [conversations, commentsResult] = await Promise.all([
    api<ConversationSummary[]>('/v1/conversations?limit=100'),
    // Comments must never be able to take the inbox down. A workspace with no
    // Facebook Page connected, a bridge mid-deploy, a permission that changes
    // — none of those are reasons an agent should lose access to their
    // WhatsApp conversations.
    //
    // But the failure is carried through rather than erased. Swallowing it
    // into a bare [] made a broken endpoint look exactly like a quiet one:
    // during review, 67 consecutive 404s rendered a calm, empty, entirely
    // convincing inbox with nothing anywhere to suggest a problem.
    api<{ comments: FacebookComment[] }>('/v1/inbox/comments?limit=100')
      .then((r) => ({ comments: r.comments, unavailable: false }))
      .catch(() => ({ comments: [] as FacebookComment[], unavailable: true })),
  ]);
  const waiting = conversations.filter(awaitingReply).length;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.chats.title}</h1>
          <p className="subtitle">{t.chats.subtitle}</p>
        </div>
        {waiting > 0 ? <span className="chip warn">{waiting} {t.chats.filterNeedsReply.toLowerCase()}</span> : null}
        <span className="spacer" />
        <AutoRefresh seconds={10} renderedAt={Date.now()} />
      </div>
      <div className="inbox">
        <ConversationList
          conversations={conversations}
          comments={commentsResult.comments}
          commentsUnavailable={commentsResult.unavailable}
          showChannelFilter
        />
        {children}
      </div>
    </>
  );
}
