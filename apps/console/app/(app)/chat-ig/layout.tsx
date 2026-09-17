import Link from 'next/link';
import { api, type ConversationSummary, type IgMetaConnection } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';
import { ConversationList } from '@/components/ConversationList';
import { AutoRefresh } from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function ChatIgLayout({ children }: { children: React.ReactNode }) {
  const [conversations, metaConnection] = await Promise.all([
    api<ConversationSummary[]>('/v1/conversations?channelKind=instagram&limit=100'),
    api<IgMetaConnection>('/v1/instagram-meta/status').catch(() => null),
  ]);
  const waiting = conversations.filter(awaitingReply).length;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.chatIg.title}</h1>
          <p className="subtitle">{t.chatIg.subtitle}</p>
        </div>
        {waiting > 0 ? <span className="chip warn">{waiting} {t.chats.filterNeedsReply.toLowerCase()}</span> : null}
        <span className="spacer" />
        <AutoRefresh seconds={10} />
        {metaConnection?.status === 'connected' ? (
          <span className="chip good">
            <span className="google-dot" aria-hidden /> @{metaConnection.igUsername}
          </span>
        ) : (
          <Link href="/pengaturan/instagram" className="btn ghost sm">{t.chatIg.goToSettings}</Link>
        )}
      </div>
      <div className="inbox">
        <ConversationList conversations={conversations} basePath="/chat-ig" />
        {children}
      </div>
    </>
  );
}
