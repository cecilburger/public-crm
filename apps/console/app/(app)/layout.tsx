import { api, type Me, type ConversationSummary, type Task, type WaBridgeChannel, type IgComment } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { buildNotifications } from '@/lib/notifications';
import { Rail } from '@/components/Rail';
import { CsrfProvider } from '@/components/Csrf';
import { csrfToken } from '@/lib/csrf';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, conversations, tasks, waChannels, pendingComments, csrf] = await Promise.all([
    api<Me>('/v1/me'),
    api<ConversationSummary[]>('/v1/conversations?limit=200'),
    api<Task[]>('/v1/tasks').catch(() => [] as Task[]),
    // Only owners/admins/supervisors hold `channel:manage` — an agent still
    // sees the rest of the rail, just not the WhatsApp number list.
    api<WaBridgeChannel[]>('/v1/wa-bridge/channels').catch(() => [] as WaBridgeChannel[]),
    // Same `pending=true` filter Komentar IG's own page uses (pending + failed).
    // Non-critical to the rail's own render, so a hiccup here drops comments
    // from the bell rather than taking the whole shell down.
    api<IgComment[]>('/v1/ig-comments?pending=true').catch(() => [] as IgComment[]),
    csrfToken(),
  ]);

  // The Obrolan badge counts what needs a human there specifically — a number
  // that goes down when you do your job is a number people trust. The
  // notification bell is broader: chats waiting on a reply, follow-ups whose
  // due date has already arrived, and Instagram comments still needing their
  // public reply, so nothing goes quiet just because nobody happened to open
  // the page that tracks it that day.
  const needsReplyList = conversations.filter(awaitingReply);
  const notifications = buildNotifications(conversations, tasks, pendingComments);

  return (
    <CsrfProvider token={csrf}>
      <div className="shell">
        <Rail me={me} needsReply={needsReplyList.length} notifications={notifications} waChannels={waChannels} />
        <div className="main">{children}</div>
      </div>
    </CsrfProvider>
  );
}
