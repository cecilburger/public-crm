import Link from '@/components/FastLink';
import { api, type ConversationSummary, type FbBridgeConnection } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';
import { ConversationList } from '@/components/ConversationList';
import { AutoRefresh } from '@/components/AutoRefresh';

export const dynamic = 'force-dynamic';

export default async function ChatFbLayout({ children }: { children: React.ReactNode }) {
  const [conversations, bridgeConnection] = await Promise.all([
    // Messenger has one transport — the Playwright bridge — unlike Instagram's
    // Graph API + bridge pair, so this only ever filters on `messenger_bridge`.
    api<ConversationSummary[]>('/v1/conversations?channelKind=messenger_bridge&limit=100'),
    api<FbBridgeConnection>('/v1/facebook-bridge/status').catch(() => null),
  ]);
  const waiting = conversations.filter(awaitingReply).length;
  const connectedPage = bridgeConnection?.status === 'ready' ? bridgeConnection.pageName : null;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.chatFb.title}</h1>
          <p className="subtitle">{t.chatFb.subtitle}</p>
        </div>
        {waiting > 0 ? <span className="chip warn">{waiting} {t.chats.filterNeedsReply.toLowerCase()}</span> : null}
        <span className="spacer" />
        <AutoRefresh seconds={10} renderedAt={Date.now()} />
        {connectedPage ? (
          <span className="chip good">
            <span className="google-dot" aria-hidden /> {connectedPage}
          </span>
        ) : (
          <Link href="/pengaturan/facebook" className="btn ghost sm">{t.chatFb.goToSettings}</Link>
        )}
      </div>
      <div className="inbox">
        <ConversationList conversations={conversations} basePath="/chat-fb" />
        {children}
      </div>
    </>
  );
}
