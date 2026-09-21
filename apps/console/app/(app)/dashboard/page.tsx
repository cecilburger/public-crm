import { api, type DashboardSummary } from '@/lib/api';
import { t } from '@/lib/copy';
import { rp, initials, ago } from '@/lib/format';
import { StatTile, BarList, type BarItem } from '@/components/DashboardWidgets';

export const dynamic = 'force-dynamic';

const toIdr = (micros: string) => Number(micros) / 1_000_000;

const pctDelta = (current: number, previous: number): { label: string; direction: 'up' | 'down' } | null => {
  if (previous <= 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return null;
  return { label: `${pct > 0 ? '+' : ''}${pct}% dari bulan lalu`, direction: pct >= 0 ? 'up' : 'down' };
};

const replyTimeLabel = (seconds: number | null): string => {
  if (seconds === null) return '—';
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? '<1 menit' : `${minutes} menit`;
};

export default async function DashboardPage() {
  const summary = await api<DashboardSummary>('/v1/dashboard/summary');

  const daily: BarItem[] = summary.daily.map((d) => ({
    label: t.dashboard.days[(new Date(`${d.date}T00:00:00`).getDay() + 6) % 7],
    value: d.count,
  }));

  const channels: BarItem[] = summary.channels.map((c) => ({
    label: t.channels[c.kind] ?? c.kind,
    value: c.count,
  }));

  const pipeline: BarItem[] = summary.pipeline.map((s) => ({
    label: s.stageName, value: toIdr(s.amountMicros), display: rp(toIdr(s.amountMicros)),
    tone: s.isWon ? 'good' : undefined,
  }));

  const salesDelta = pctDelta(toIdr(summary.salesThisMonthMicros), toIdr(summary.salesLastMonthMicros));

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.dashboard.title}</h1>
          <p className="subtitle">Ringkasan toko Anda.</p>
        </div>
        <span className="spacer" />
      </div>

      <div className="scroll pad stack">
        <div className="grid c4">
          <StatTile label={t.dashboard.statClients} value={String(summary.totalClients)}
                    delta={`+${summary.newClientsThisWeek} minggu ini`} direction="up" />
          <StatTile label={t.dashboard.statUnanswered} value={String(summary.unansweredCount)} />
          <StatTile label={t.dashboard.statSales} value={rp(toIdr(summary.salesThisMonthMicros))}
                    delta={salesDelta?.label} direction={salesDelta?.direction} />
          <StatTile label={t.dashboard.statReplyTime} value={replyTimeLabel(summary.avgReplySeconds)} />
        </div>

        <div className="grid c3">
          <div className="panel">
            <header><h2>{t.dashboard.panelDaily}</h2></header>
            <div className="body"><BarList items={daily} /></div>
          </div>
          <div className="panel">
            <header><h2>{t.dashboard.panelChannels}</h2></header>
            <div className="body">
              {channels.length > 0 ? <BarList items={channels} /> : <p className="dim">Belum ada pesan.</p>}
            </div>
          </div>
          <div className="panel">
            <header><h2>{t.dashboard.panelPipeline}</h2></header>
            <div className="body"><BarList items={pipeline} /></div>
          </div>
        </div>

        <div className="panel">
          <header><h2>{t.dashboard.panelRecent}</h2></header>
          <table className="odoo-table">
            <thead>
              <tr>
                <th>{t.dashboard.tableName}</th>
                <th>{t.dashboard.tablePhone}</th>
                <th>{t.dashboard.tableTag}</th>
                <th className="num">{t.dashboard.tableWhen}</th>
              </tr>
            </thead>
            <tbody>
              {summary.recentContacts.length === 0 && (
                <tr><td colSpan={4} className="dim">Belum ada client.</td></tr>
              )}
              {summary.recentContacts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span className="avatar" aria-hidden>{initials(c.displayName ?? '?')}</span>
                      <b>{c.displayName ?? '(tanpa nama)'}</b>
                    </span>
                  </td>
                  <td className="mono">{c.phone ?? '—'}</td>
                  <td>
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {c.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
                    </span>
                  </td>
                  <td className="num">{ago(c.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
