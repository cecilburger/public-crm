import { api, type AgentPerformanceSummary } from '@/lib/api';
import { t } from '@/lib/copy';
import { initials } from '@/lib/format';
import { StatTile, BarList, type BarItem } from '@/components/DashboardWidgets';
import { BarChart, RingChart, type ColumnItem, type RingItem } from '@/components/ChartWidgets';

export const dynamic = 'force-dynamic';

const replyLabel = (seconds: number | null): string => {
  if (seconds === null) return '—';
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? '<1 menit' : `${minutes} menit`;
};

/** No stored target to compare against (see the audit that added this page's
 *  real data) — 0 minutes scores 100, an hour or slower scores 0, linear
 *  between. A fixed, disclosed scale, not a fabricated per-agent goal. */
const speedScore = (seconds: number | null): number => {
  if (seconds === null) return 0;
  return Math.max(0, Math.min(100, Math.round(100 - (seconds / 3600) * 100)));
};

const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 100) : 0);

export default async function AgentPerformancePage() {
  const s = await api<AgentPerformanceSummary>('/v1/agent-performance');
  const agents = s.agents;

  const totalHandled = agents.reduce((sum, a) => sum + a.handled, 0);
  const totalWaiting = agents.reduce((sum, a) => sum + a.waiting, 0);
  const totalResolved = agents.reduce((sum, a) => sum + a.resolved, 0);

  const HANDLED: ColumnItem[] = agents.map((a) => ({ label: a.name.split(' ')[0]!, value: a.handled }));
  const RESOLUTION: BarItem[] = agents.map((a) => {
    const p = pct(a.resolved, a.handled);
    return { label: a.name, value: p, display: `${p}%`, tone: p >= 90 ? 'good' : undefined };
  });

  const RINGS: RingItem[] = [
    { label: t.agentPerformance.ringChat, value: pct(totalHandled - totalWaiting, totalHandled), colorVar: '--chart-1' },
    { label: t.agentPerformance.ringRespon, value: pct(totalResolved, totalHandled), colorVar: '--chart-2' },
    { label: t.agentPerformance.ringSpeed, value: speedScore(s.avgReplySeconds), colorVar: '--chart-3' },
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.agentPerformance.title}</h1>
          <p className="subtitle">{t.agentPerformance.subtitle}</p>
        </div>
        <span className="spacer" />
      </div>

      <div className="scroll pad stack">
        <div className="grid c4">
          <StatTile label={t.agentPerformance.statActive} value={String(s.activeAgents)} />
          <StatTile label={t.agentPerformance.statAvgReply} value={replyLabel(s.avgReplySeconds)} />
          <StatTile label={t.agentPerformance.statHandled} value={String(s.handledToday)} />
          <StatTile label={t.agentPerformance.statResolution}
                    value={s.resolutionPct === null ? '—' : `${s.resolutionPct}%`} />
        </div>

        {agents.length === 0 ? (
          <div className="panel"><div className="body"><p className="dim">Belum ada agen aktif.</p></div></div>
        ) : (
          <>
            <div className="grid c2">
              <div className="panel">
                <header><h2>{t.agentPerformance.panelHandled}</h2></header>
                <div className="body"><BarChart items={HANDLED} /></div>
              </div>
              <div className="panel">
                <header><h2>{t.agentPerformance.panelResolution}</h2></header>
                <div className="body"><BarList items={RESOLUTION} /></div>
              </div>
            </div>

            <div className="panel">
              <header>
                <h2>{t.agentPerformance.panelRings}</h2>
                <span className="dim" style={{ fontSize: 12 }}>{t.agentPerformance.panelRingsNote}</span>
              </header>
              <div className="body"><RingChart items={RINGS} /></div>
            </div>

            <div className="panel">
              <header>
                <h2>{t.agentPerformance.panelRingsPerAgent}</h2>
                <span className="dim" style={{ fontSize: 12 }}>{t.agentPerformance.panelRingsPerAgentNote}</span>
              </header>
              <div className="body">
                <div className="ring-legend" style={{ flexDirection: 'row', gap: 20, marginBottom: 18 }}>
                  {RINGS.map((r) => (
                    <div className="ring-legend-row" key={r.label} style={{ fontSize: 12 }}>
                      <span className="ring-legend-swatch" style={{ background: `var(${r.colorVar})` }} />
                      <span className="ring-legend-label">{r.label}</span>
                    </div>
                  ))}
                </div>
                <div className="ring-grid">
                  {agents.map((a) => {
                    const chat = pct(a.handled - a.waiting, a.handled);
                    const respon = pct(a.resolved, a.handled);
                    const speed = speedScore(a.avgReplySeconds);
                    const score = Math.round((chat + respon + speed) / 3);
                    const agentRings: RingItem[] = [
                      { label: t.agentPerformance.ringChat, value: chat, colorVar: '--chart-1' },
                      { label: t.agentPerformance.ringRespon, value: respon, colorVar: '--chart-2' },
                      { label: t.agentPerformance.ringSpeed, value: speed, colorVar: '--chart-3' },
                    ];
                    return (
                      <div className="ring-card" key={a.userId}>
                        <RingChart items={agentRings} size={124} strokeWidth={8} gap={2} showLegend={false}
                                   center={{ value: `${score}%`, label: t.agentPerformance.ringScoreLabel }} />
                        <span className="ring-card-name">{a.name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="panel">
              <header><h2>{t.agentPerformance.panelDetail}</h2></header>
              <table className="odoo-table">
                <thead>
                  <tr>
                    <th>{t.agentPerformance.tableAgent}</th>
                    <th className="num">{t.agentPerformance.tableHandled}</th>
                    <th className="num">{t.agentPerformance.tableWaiting}</th>
                    <th>{t.agentPerformance.tableAvgReply}</th>
                    <th className="num">{t.agentPerformance.tableResolution}</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.userId}>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <span className="avatar" aria-hidden>{initials(a.name)}</span>
                          <b>{a.name}</b>
                        </span>
                      </td>
                      <td className="num">{a.handled}</td>
                      <td className="num">
                        {a.waiting > 0 ? <span className="chip warn">{a.waiting}</span> : <span className="dim">0</span>}
                      </td>
                      <td>{replyLabel(a.avgReplySeconds)}</td>
                      <td className="num">{pct(a.resolved, a.handled)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
