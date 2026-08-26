import { api, type Me, type ConversationSummary } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { Rail } from '@/components/Rail';
import { CsrfProvider } from '@/components/Csrf';
import { csrfToken } from '@/lib/csrf';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, conversations, csrf] = await Promise.all([
    api<Me>('/v1/me'),
    api<ConversationSummary[]>('/v1/conversations?limit=200'),
    csrfToken(),
  ]);

  // The badge counts what needs a human, not what is merely open — a number that
  // goes down when you do your job is a number people trust.
  const needsReply = conversations.filter(awaitingReply).length;

  return (
    <CsrfProvider token={csrf}>
      <div className="shell">
        <Rail me={me} needsReply={needsReply} />
        <div className="main">{children}</div>
      </div>
    </CsrfProvider>
  );
}
