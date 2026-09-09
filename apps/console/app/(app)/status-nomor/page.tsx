import { api, type WaBridgeChannel, type ConversationSummary } from '@/lib/api';
import { awaitingReply } from '@/lib/format';
import { t } from '@/lib/copy';

export const dynamic = 'force-dynamic';

const LIVE = new Set(['ready', 'connected']);

export default async function WaStatusPage() {
  const [channels, conversations] = await Promise.all([
    // Only owners/admins/supervisors hold `channel:manage` — an agent still
    // sees the page, just as an empty table rather than a 403.
    api<WaBridgeChannel[]>('/v1/wa-bridge/channels').catch(() => [] as WaBridgeChannel[]),
    api<ConversationSummary[]>('/v1/conversations?channelKind=whatsapp_web&limit=200').catch(() => [] as ConversationSummary[]),
  ]);

  const totalByChannel = new Map<string, number>();
  const unansweredByChannel = new Map<string, number>();
  for (const c of conversations) {
    totalByChannel.set(c.channel_id, (totalByChannel.get(c.channel_id) ?? 0) + 1);
    if (awaitingReply(c)) {
      unansweredByChannel.set(c.channel_id, (unansweredByChannel.get(c.channel_id) ?? 0) + 1);
    }
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
        <div className="panel">
          {channels.length === 0 ? (
            <p className="empty" style={{ padding: '24px 0' }}>{t.waStatus.noNumbers}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t.waStatus.code}</th>
                  <th>{t.waStatus.number}</th>
                  <th className="num">{t.waStatus.totalChats}</th>
                  <th className="num">{t.waStatus.unanswered}</th>
                  <th>{t.waStatus.status}</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => {
                  const total = totalByChannel.get(c.id) ?? 0;
                  const count = unansweredByChannel.get(c.id) ?? 0;
                  const dotClass = LIVE.has(c.sessionStatus) ? 'good' : c.sessionStatus === 'error' ? 'danger' : 'warn';
                  return (
                    <tr key={c.id}>
                      <td><b>{c.displayName}</b></td>
                      <td className="mono">{c.phoneE164 ?? '—'}</td>
                      <td className="num">{total}</td>
                      <td className="num">
                        {count > 0
                          ? <span className="chip warn">{t.waStatus.unansweredCount(count)}</span>
                          : <span className="dim">{t.waStatus.unansweredCount(count)}</span>}
                      </td>
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
