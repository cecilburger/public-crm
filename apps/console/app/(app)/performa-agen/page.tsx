import { t } from '@/lib/copy';
import { initials } from '@/lib/format';
import { StatTile, BarList, type BarItem } from '@/components/DashboardWidgets';
import { BarChart, RingChart, type ColumnItem, type RingItem } from '@/components/ChartWidgets';

// Placeholder data — no live query here yet. Exists so the shell of an agent
// performance view (KPIs, charts, a detail table) has somewhere to live
// before it's wired to real per-agent aggregates.
const AGENTS = [
  { name: 'Dimas Arya', handled: 62, waiting: 2, avgReply: '6 menit', resolution: 94, rating: 4.8, chat: 88, respon: 93, speed: 82 },
  { name: 'Sinta Larasati', handled: 51, waiting: 0, avgReply: '5 menit', resolution: 97, rating: 4.9, chat: 95, respon: 97, speed: 90 },
  { name: 'Budi Santoso', handled: 38, waiting: 4, avgReply: '11 menit', resolution: 85, rating: 4.4, chat: 70, respon: 82, speed: 65 },
  { name: 'Wulan Sari', handled: 29, waiting: 1, avgReply: '9 menit', resolution: 88, rating: 4.6, chat: 78, respon: 88, speed: 74 },
];

const HANDLED: ColumnItem[] = AGENTS.map((a) => ({ label: a.name.split(' ')[0], value: a.handled }));
const RESOLUTION: BarItem[] = AGENTS.map((a) => ({
  label: a.name, value: a.resolution, display: `${a.resolution}%`,
  tone: a.resolution >= 90 ? 'good' : undefined,
}));

// Team-wide, not per-agent — each ring is a different measure of the same
// week, scored against its own target so the three sit on one 0-100 scale.
const RINGS: RingItem[] = [
  { label: t.agentPerformance.ringChat, value: 82, colorVar: '--chart-1' },
  { label: t.agentPerformance.ringRespon, value: 91, colorVar: '--chart-2' },
  { label: t.agentPerformance.ringSpeed, value: 76, colorVar: '--chart-3' },
];

export const dynamic = 'force-static';

export default function AgentPerformancePage() {
  const totalHandled = AGENTS.reduce((sum, a) => sum + a.handled, 0);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.agentPerformance.title}</h1>
          <p className="subtitle">{t.agentPerformance.subtitle}</p>
        </div>
        <span className="spacer" />
        <span className="chip">{t.agentPerformance.dummyNote}</span>
      </div>

      <div className="scroll pad stack">
        <div className="grid c4">
          <StatTile label={t.agentPerformance.statActive} value={String(AGENTS.length)}
                    delta={t.agentPerformance.statActiveDelta} direction="up" />
          <StatTile label={t.agentPerformance.statAvgReply} value="7 menit"
                    delta={t.agentPerformance.statAvgReplyDelta} direction="down" />
          <StatTile label={t.agentPerformance.statHandled} value={String(totalHandled)}
                    delta={t.agentPerformance.statHandledDelta} direction="up" />
          <StatTile label={t.agentPerformance.statResolution} value="91%"
                    delta={t.agentPerformance.statResolutionDelta} direction="up" />
        </div>

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
              {AGENTS.map((a) => {
                const score = Math.round((a.chat + a.respon + a.speed) / 3);
                const agentRings: RingItem[] = [
                  { label: t.agentPerformance.ringChat, value: a.chat, colorVar: '--chart-1' },
                  { label: t.agentPerformance.ringRespon, value: a.respon, colorVar: '--chart-2' },
                  { label: t.agentPerformance.ringSpeed, value: a.speed, colorVar: '--chart-3' },
                ];
                return (
                  <div className="ring-card" key={a.name}>
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
                <th className="num">{t.agentPerformance.tableRating}</th>
              </tr>
            </thead>
            <tbody>
              {AGENTS.map((a) => (
                <tr key={a.name}>
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
                  <td>{a.avgReply}</td>
                  <td className="num">{a.resolution}%</td>
                  <td className="num"><span className="chip good">{a.rating.toFixed(1)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
