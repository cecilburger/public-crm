import { api, type WaBridgeChannel, type ConversationSummary } from '@/lib/api';
import { awaitingReply, ago, duration } from '@/lib/format';
import { t } from '@/lib/copy';

export const dynamic = 'force-dynamic';

const LIVE = new Set(['ready', 'connected']);

interface ChannelStats {
  total: number; today: number; unanswered: number; queue: number;
  lastActiveAt: number | null; replyTotalMs: number; replyCount: number;
}

const emptyStats = (): ChannelStats =>
  ({ total: 0, today: 0, unanswered: 0, queue: 0, lastActiveAt: null, replyTotalMs: 0, replyCount: 0 });

export default async function WaStatusPage() {
  const [channels, conversations] = await Promise.all([
    // Only owners/admins/supervisors hold `channel:manage` — an agent still
    // sees the page, just as an empty table rather than a 403.
    api<WaBridgeChannel[]>('/v1/wa-bridge/channels').catch(() => [] as WaBridgeChannel[]),
    api<ConversationSummary[]>('/v1/conversations?channelKind=whatsapp_web&limit=200').catch(() => [] as ConversationSummary[]),
  ]);

  const todayKey = new Date().toDateString();
  const statsByChannel = new Map<string, ChannelStats>();
  for (const c of conversations) {
    const s = statsByChannel.get(c.channel_id) ?? emptyStats();

    s.total += 1;
    if (c.last_message_at && new Date(c.last_message_at).toDateString() === todayKey) s.today += 1;
    if (awaitingReply(c)) s.unanswered += 1;
    // Nobody has picked this thread up yet — a queue depth, distinct from
    // "belum dijawab" (which is about who spoke last, not who owns it).
    if (c.status !== 'resolved' && c.assignee_id === null) s.queue += 1;
    if (c.last_message_at) {
      const at = new Date(c.last_message_at).getTime();
      if (s.lastActiveAt === null || at > s.lastActiveAt) s.lastActiveAt = at;
    }
    // Time to first response is measured against this thread's own start, not
    // the customer's most recent message — a fair "how fast do we pick up a
    // new conversation" number even mid-thread.
    if (c.first_response_at) {
      s.replyTotalMs += new Date(c.first_response_at).getTime() - new Date(c.created_at).getTime();
      s.replyCount += 1;
    }

    statsByChannel.set(c.channel_id, s);
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.waStatus.title}</h1>
          <p className="subtitle">{t.waStatus.subtitle}</p>
        </div>
      </div>

      <div className="scroll pad stack">
        <div className="panel" style={{ border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          {channels.length === 0 ? (
            <p className="empty" style={{ padding: '24px 0' }}>{t.waStatus.noNumbers}</p>
          ) : (
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.waStatus.code}</th>
                  <th>{t.waStatus.number}</th>
                  <th className="num">{t.waStatus.totalChats}</th>
                  <th className="num">{t.waStatus.todayChats}</th>
                  <th>{t.waStatus.lastActive}</th>
                  <th className="num">{t.waStatus.unanswered}</th>
                  <th className="num">{t.waStatus.queue}</th>
                  <th>{t.waStatus.avgReply}</th>
                  <th>{t.waStatus.status}</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => {
                  const s = statsByChannel.get(c.id) ?? emptyStats();
                  const dotClass = LIVE.has(c.sessionStatus) ? 'good' : c.sessionStatus === 'error' ? 'danger' : 'warn';
                  return (
                    <tr key={c.id}>
                      <td><b>{c.displayName}</b></td>
                      <td className="mono">{c.phoneE164 ?? '—'}</td>
                      <td className="num">{s.total}</td>
                      <td className="num">{s.today}</td>
                      <td>{s.lastActiveAt !== null ? ago(new Date(s.lastActiveAt).toISOString()) : t.waStatus.neverActive}</td>
                      <td className="num">
                        {s.unanswered > 0
                          ? <span className="chip warn">{t.waStatus.unansweredCount(s.unanswered)}</span>
                          : <span className="dim">{t.waStatus.unansweredCount(s.unanswered)}</span>}
                      </td>
                      <td className="num">
                        {s.queue > 0
                          ? <span className="chip">{t.waStatus.queueCount(s.queue)}</span>
                          : <span className="dim">{t.waStatus.queueCount(s.queue)}</span>}
                      </td>
                      <td>{s.replyCount > 0 ? duration(s.replyTotalMs / s.replyCount) : <span className="dim">{t.waStatus.avgReplyNone}</span>}</td>
                      <td>
                        <span className={`chip ${dotClass}`}>{t.waBridge.status[c.sessionStatus] ?? c.sessionStatus}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
