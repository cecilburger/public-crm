import { api, type ConversationSummary } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';
import { ConversationList } from '@/components/ConversationList';
import { AutoRefresh } from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function ChatsLayout({ children }: { children: React.ReactNode }) {
  const conversations = await api<ConversationSummary[]>('/v1/conversations?limit=100');
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
        <AutoRefresh seconds={10} />
      </div>
      <div className="inbox">
        <ConversationList conversations={conversations} />
        {children}
      </div>
    </>
  );
}
