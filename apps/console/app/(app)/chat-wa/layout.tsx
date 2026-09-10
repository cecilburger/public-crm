import { api, type ConversationSummary, type WaBridgeChannel } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';
import { ConversationList } from '@/components/ConversationList';
import { AutoRefresh } from '@/components/AutoRefresh';
import { WaBridgeConnectButton } from '@/components/WaBridgeConnectButton';

export const dynamic = 'force-dynamic';

export default async function ChatWaLayout({ children }: { children: React.ReactNode }) {
  const [conversations, channels] = await Promise.all([
    api<ConversationSummary[]>('/v1/conversations?channelKind=whatsapp_web&limit=100'),
    // Only owners/admins/supervisors hold `channel:manage` — an agent still
    // sees the conversation list, just not whether a number is mid-pairing.
    api<WaBridgeChannel[]>('/v1/wa-bridge/channels').catch(() => [] as WaBridgeChannel[]),
  ]);
  const waiting = conversations.filter(awaitingReply).length;
  // Refreshes fast enough that a rotating QR (in the rail) never goes stale.
  const pairing = channels.some((c) => c.sessionStatus === 'qr_pending' || c.sessionStatus === 'starting');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.waBridge.title}</h1>
          <p className="subtitle">{t.waBridge.subtitle}</p>
        </div>
        {waiting > 0 ? <span className="chip warn">{waiting} {t.chats.filterNeedsReply.toLowerCase()}</span> : null}
        <span className="spacer" />
        <AutoRefresh seconds={pairing ? 3 : 10} />
        <WaBridgeConnectButton />
      </div>
      <div className="inbox">
        <ConversationList conversations={conversations} basePath="/chat-wa" />
        {children}
      </div>
    </>
  );
}
