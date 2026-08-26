'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ago, awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';
import type { ConversationSummary } from '@/lib/api';

/**
 * Three filters, and the useful one is first.
 *
 * The API has four statuses; an agent has one question — who is waiting for me?
 * "Perlu dibalas" answers it, and the other two are there so nothing is hidden.
 */
export function ConversationList({ conversations }: { conversations: ConversationSummary[] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const filter = params.get('f') ?? 'semua';

  const counts = {
    perlu: conversations.filter(awaitingReply).length,
    selesai: conversations.filter((c) => c.status === 'resolved').length,
  };

  const shown = conversations.filter((c) =>
    filter === 'perlu' ? awaitingReply(c)
    : filter === 'selesai' ? c.status === 'resolved'
    : true);

  const tabs = [
    { key: 'semua', label: t.chats.filterAll, n: conversations.length },
    { key: 'perlu', label: t.chats.filterNeedsReply, n: counts.perlu },
    { key: 'selesai', label: t.chats.filterDone, n: counts.selesai },
  ];

  return (
    <div className="list">
      <div className="filters" role="navigation" aria-label="Saring obrolan">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.key === 'semua' ? '/obrolan' : `/obrolan?f=${tab.key}`}
            aria-current={filter === tab.key ? 'page' : undefined}
          >
            {tab.label} {tab.n}
          </Link>
        ))}
      </div>

      <div className="scroll">
        {shown.length === 0 ? (
          <p className="empty" style={{ fontSize: 13 }}>{t.chats.emptyList}</p>
        ) : (
          shown.map((c) => {
            const active = pathname === `/obrolan/${c.id}`;
            const waiting = awaitingReply(c);
            return (
              <Link
                key={c.id}
                href={`/obrolan/${c.id}`}
                className={`thread-item ${waiting ? 'waiting' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="row1">
                  {waiting ? <span className="dot warn" aria-label={t.chats.needsReply} /> : null}
                  <span className="who">{c.display_name ?? t.chats.unknown}</span>
                  <span className="when tnum">{ago(c.last_message_at)}</span>
                </span>
                <span className="row2">
                  <span className="chip">{t.channels[c.channel_kind] ?? c.channel_kind}</span>
                  {waiting ? <span className="chip warn">{t.chats.needsReply}</span> : null}
                  {c.status === 'resolved' ? <span className="chip good">{t.chats.done}</span> : null}
                  {c.assignee_id === null && c.status !== 'resolved'
                    ? <span className="chip">{t.chats.nobodyYet}</span> : null}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
