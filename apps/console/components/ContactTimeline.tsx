import Link from 'next/link';
import { ago, CHANNEL_LABEL } from '@/lib/format';
import { t } from '@/lib/copy';
import type { ContactTimelineEvent, Member } from '@/lib/api';

/** Machine event names, said in words — same convention as Riwayat and Deal Detail. */
function activityLabel(action: string): string {
  return t.events[action] ?? action;
}

function activityDetails(meta: Record<string, unknown>, names: Map<string, string>): string {
  const entries = Object.entries(meta ?? {});
  if (entries.length === 0) return '—';
  return entries
    .map(([k, v]) => {
      const raw = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      return `${t.metaKeys[k] ?? k}: ${names.get(raw) ?? raw}`;
    })
    .join(' · ');
}

/**
 * Everything about this customer in one vertical list — chat, deals, orders
 * and tasks, gathered from the audit log the app already writes to for every
 * one of those, plus a marker per conversation. Nothing here is a second
 * copy of the data; this is a read-only view over records that already exist.
 */
export function ContactTimeline({ events, members }: { events: ContactTimelineEvent[]; members: Member[] }) {
  const names = new Map(members.map((m) => [m.id, m.name]));

  if (events.length === 0) {
    return <p className="record-hint">{t.timeline.empty}</p>;
  }

  return (
    <div className="timeline-list">
      {events.map((e) => (
        <div key={e.id} className="timeline-row">
          <span className="timeline-dot" aria-hidden />
          <div className="timeline-body">
            <div className="timeline-head">
              <b>{activityLabel(e.action)}</b>
              <span className="mono dim">{ago(e.occurredAt)}</span>
            </div>
            {e.action === 'conversation.started' ? (
              <Link href={`/obrolan/${e.meta.conversationId}`} className="timeline-link">
                {CHANNEL_LABEL[String(e.meta.channel)] ?? String(e.meta.channel)} · {t.timeline.openChat}
              </Link>
            ) : (
              <span className="dim" style={{ fontSize: 12.5 }}>
                {[
                  Object.keys(e.meta ?? {}).length > 0 ? activityDetails(e.meta, names) : null,
                  e.actorType === 'user' && e.actorId ? (names.get(e.actorId) ?? null) : null,
                ].filter(Boolean).join(' · ') || '—'}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
