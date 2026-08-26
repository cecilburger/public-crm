import { api, type AutopilotSettings, type KnowledgeRow } from '@/lib/api';
import { rp, num } from '@/lib/format';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';
import { ModeSwitch } from '@/components/ModeSwitch';

export const dynamic = 'force-dynamic';

export default async function AutopilotPage() {
  const [config, knowledge] = await Promise.all([
    api<AutopilotSettings>('/v1/autopilot'),
    api<KnowledgeRow[]>('/v1/knowledge').catch(() => [] as KnowledgeRow[]),
  ]);

  const mode = config.settings?.mode ?? 'suggest';
  const s = config.last30Days;
  const stats = [
    { label: t.autopilot.statPending, n: s.pending ?? 0 },
    { label: t.autopilot.statUsed, n: s.used ?? 0 },
    { label: t.autopilot.statEdited, n: s.edited ?? 0 },
    { label: t.autopilot.statAuto, n: s.auto_sent ?? 0 },
    { label: t.autopilot.statBlocked, n: s.blocked ?? 0 },
    { label: t.autopilot.statDiscarded, n: s.discarded ?? 0 },
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.autopilot.title}</h1>
          <p className="subtitle">{t.autopilot.subtitle}</p>
        </div>
      </div>
      <SettingsTabs />

      <div className="scroll pad stack">
        <ModeSwitch current={mode} />

        <div className="panel">
          <header><h2>{t.autopilot.guardTitle}</h2></header>
          <div className="body">
            <ul className="checklist">
              {t.autopilot.guards.map((line) => (
                <li key={line}><span className="tick" aria-hidden>✓</span>{line}</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="panel">
          <header><h2>{t.autopilot.capTitle}</h2></header>
          <div className="body">
            <p className="muted" style={{ maxWidth: '62ch', lineHeight: 1.6 }}>
              {config.settings?.max_replies_per_hour
                ? t.autopilot.capBody(config.settings.max_replies_per_hour)
                : t.autopilot.capOff}
            </p>
          </div>
        </div>

        <div className="panel">
          <header><h2>{t.autopilot.stats}</h2></header>
          <div className="body">
            <div className="grid c3">
              {stats.map((stat) => (
                <div key={stat.label}>
                  <div className="bignum">{num(stat.n)}</div>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{stat.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="panel">
          <header>
            <h2>{t.autopilot.catalogue}</h2>
            <span className="mono dim" style={{ marginLeft: 'auto' }}>{t.autopilot.catalogueNote}</span>
          </header>
          {knowledge.length === 0 ? (
            <p className="empty">{t.autopilot.emptyCatalogue}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t.autopilot.kind}</th><th>{t.autopilot.itemTitle}</th>
                  <th>{t.autopilot.sku}</th>
                  <th className="num">{t.autopilot.price}</th><th className="num">{t.autopilot.stock}</th>
                </tr>
              </thead>
              <tbody>
                {knowledge.filter((k) => k.active).map((k) => (
                  <tr key={k.id}>
                    <td><span className="chip">{t.autopilot.kinds[k.kind] ?? k.kind}</span></td>
                    <td><b>{k.title}</b>{k.body ? <><br /><span className="muted" style={{ fontSize: 12.5 }}>{k.body}</span></> : null}</td>
                    <td className="mono dim">{k.sku ?? '—'}</td>
                    <td className="num">{k.price_idr ? rp(k.price_idr) : '—'}</td>
                    <td className="num">
                      {k.stock === null ? '—'
                        : k.stock === 0 ? <span className="chip warn">0</span>
                        : k.stock}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
