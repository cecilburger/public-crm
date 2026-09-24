import Link from '@/components/FastLink';
import { api, type ConversationSummary, type IgMetaConnection, type IgBridgeConnection } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';
import { ConversationList } from '@/components/ConversationList';
import { AutoRefresh } from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function ChatIgLayout({ children }: { children: React.ReactNode }) {
  const [conversations, metaConnection, bridgeConnection] = await Promise.all([
    // Both the official Graph API channel and the Playwright bridge's own
    // channel feed the same inbox — one `channelKind` per connection method,
    // shown together since they're both "Instagram" to whoever's answering.
    api<ConversationSummary[]>('/v1/conversations?channelKind=instagram,instagram_bridge&limit=100'),
    api<IgMetaConnection>('/v1/instagram-meta/status').catch(() => null),
    api<IgBridgeConnection>('/v1/instagram-bridge/status').catch(() => null),
  ]);
  const waiting = conversations.filter(awaitingReply).length;
  const connectedUsername = metaConnection?.status === 'connected'
    ? metaConnection.igUsername
    : bridgeConnection?.status === 'ready' ? bridgeConnection.username : null;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.chatIg.title}</h1>
          <p className="subtitle">{t.chatIg.subtitle}</p>
        </div>
        {waiting > 0 ? <span className="chip warn">{waiting} {t.chats.filterNeedsReply.toLowerCase()}</span> : null}
        <span className="spacer" />
        <AutoRefresh seconds={10} renderedAt={Date.now()} />
        {connectedUsername ? (
          <span className="chip good">
            <span className="google-dot" aria-hidden /> @{connectedUsername}
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
