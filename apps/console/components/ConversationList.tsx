'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ago, awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';
import type { ConversationSummary, WaBridgeChannel } from '@/lib/api';

/**
 * Three filters, and the useful one is first.
 *
 * The API has four statuses; an agent has one question — who is waiting for me?
 * "Perlu dibalas" answers it, and the other two are there so nothing is hidden.
 *
 * A fourth filter, `channelId`, is separate from those three and client-only —
 * it narrows the list to one wa-bridge number (the message icon on Channel
 * WhatsApp monitoring links in with it set) rather than adding a fourth tab,
 * since it only ever applies to `/chat-wa`, never `/obrolan`.
 */
export function ConversationList(
  { conversations, basePath = '/obrolan', channels }:
  { conversations: ConversationSummary[]; basePath?: string; channels?: WaBridgeChannel[] },
) {
  const pathname = usePathname();
  const params = useSearchParams();
  const filter = params.get('f') ?? 'semua';
  const channelId = params.get('channelId');
  const filteredChannel = channelId ? channels?.find((c) => c.id === channelId) ?? null : null;

  const scoped = channelId ? conversations.filter((c) => c.channel_id === channelId) : conversations;

  const counts = {
    perlu: scoped.filter(awaitingReply).length,
    selesai: scoped.filter((c) => c.status === 'resolved').length,
  };

  const shown = scoped.filter((c) =>
    filter === 'perlu' ? awaitingReply(c)
    : filter === 'selesai' ? c.status === 'resolved'
    : true);

  const tabs = [
    { key: 'semua', label: t.chats.filterAll, n: scoped.length },
    { key: 'perlu', label: t.chats.filterNeedsReply, n: counts.perlu },
    { key: 'selesai', label: t.chats.filterDone, n: counts.selesai },
  ];
  // Tab links keep whatever number is being filtered — switching "Perlu
  // dibalas" while looking at one number shouldn't jump back to all of them.
  const tabHref = (key: string) => {
    const qs = new URLSearchParams();
    if (key !== 'semua') qs.set('f', key);
    if (channelId) qs.set('channelId', channelId);
    const query = qs.toString();
    return query ? `${basePath}?${query}` : basePath;
  };
  // Opening a thread keeps the same query string, so the list you land back
  // on (via the browser's back button, or the thread panel's own close) is
  // still scoped the way you left it, not silently reset to every number.
  const threadHref = (id: string) => {
    const query = params.toString();
    return query ? `${basePath}/${id}?${query}` : `${basePath}/${id}`;
  };

  return (
    <div className="list">
      {filteredChannel ? (
        <div className="filters" style={{ padding: '8px 10px 0' }}>
          <span className="chip brand">{t.waBridge.filteringNumber(filteredChannel.displayName)}</span>
          <Link href={basePath} style={{ fontSize: 12, marginLeft: 8 }}>{t.waBridge.clearFilter}</Link>
        </div>
      ) : null}
      <div className="filters" role="navigation" aria-label="Saring obrolan">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tabHref(tab.key)}
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
            const active = pathname === `${basePath}/${c.id}`;
            const waiting = awaitingReply(c);
            return (
              <Link
                key={c.id}
                href={threadHref(c.id)}
                className={`thread-item ${waiting ? 'waiting' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className="row1">
                  {waiting ? <span className="dot warn" aria-label={t.chats.needsReply} /> : null}
                  <span className="who">
                    {c.display_name
                      ? <>{c.display_name}{c.phone ? <span className="dim" style={{ fontWeight: 400 }}> · {c.phone}</span> : null}</>
                      : (c.phone ?? '—')}
                  </span>
                  {/* This list is a Client Component hydrating over server-rendered
                      HTML — "ago" is relative to whenever each render actually runs,
                      so the server's text and the client's first paint can
                      legitimately differ by a rounding step (e.g. "51m" vs "52m").
                      That's expected drift, not a bug: let the client's clock win
                      instead of warning about it. */}
                  <span className="when tnum" suppressHydrationWarning>{ago(c.last_message_at)}</span>
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
