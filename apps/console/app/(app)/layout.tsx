import { api, type Me, type ConversationSummary, type WaBridgeChannel } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { Rail } from '@/components/Rail';
import { CsrfProvider } from '@/components/Csrf';
import { csrfToken } from '@/lib/csrf';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, conversations, waChannels, csrf] = await Promise.all([
    api<Me>('/v1/me'),
    api<ConversationSummary[]>('/v1/conversations?limit=200'),
    // Only owners/admins/supervisors hold `channel:manage` — an agent still
    // sees the rest of the rail, just not the WhatsApp number list.
    api<WaBridgeChannel[]>('/v1/wa-bridge/channels').catch(() => [] as WaBridgeChannel[]),
    csrfToken(),
  ]);

  // The badge counts what needs a human, not what is merely open — a number that
  // goes down when you do your job is a number people trust. The notification
  // bell reuses this same list (no second fetch) so it can name who, not just
  // how many.
  const needsReplyList = conversations.filter(awaitingReply);

  return (
    <CsrfProvider token={csrf}>
      <div className="shell">
        <Rail me={me} needsReply={needsReplyList.length} notifications={needsReplyList} waChannels={waChannels} />
        <div className="main">{children}</div>
      </div>
    </CsrfProvider>
  );
}
