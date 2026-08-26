import { api, type AuditRow, type Member } from '@/lib/api';
import { ago } from '@/lib/format';
import { t } from '@/lib/copy';
import { SettingsTabs } from '@/components/SettingsTabs';

export const dynamic = 'force-dynamic';

/** Machine event names, said in words — with the raw name kept underneath. */
function describe(action: string): { label: string; raw: string } {
  return { label: t.events[action] ?? action, raw: action };
}

/**
 * Details as readable pairs rather than raw JSON. Braces and quotes read as
 * something broken to anyone who does not write code; unknown keys are still
 * shown, so nothing is hidden from whoever needs it.
 */
function details(meta: Record<string, unknown>, names: Map<string, string>): string {
  const entries = Object.entries(meta ?? {});
  if (entries.length === 0) return '—';
  return entries
    .map(([k, v]) => {
      const raw = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      // An id tells a person nothing; the name it belongs to tells them everything.
      return `${t.metaKeys[k] ?? k}: ${names.get(raw) ?? raw}`;
    })
    .join(' · ');
}

export default async function HistoryPage() {
  const [rows, verdict, members] = await Promise.all([
    api<AuditRow[]>('/v1/audit?limit=200').catch(() => [] as AuditRow[]),
    api<{ ok: boolean; brokenAt?: number }>('/v1/audit/verify').catch(() => ({ ok: true })),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
  ]);
  const names = new Map(members.map((m) => [m.id, m.name]));

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.settings.historyTitle}</h1>
          <p className="subtitle">{t.settings.historySubtitle}</p>
        </div>
        {verdict.ok
          ? <span className="chip good">{t.settings.intact}</span>
          : <span className="chip danger">{t.settings.broken}</span>}
      </div>
      <SettingsTabs />

      <div className="scroll pad">
        <div className="panel">
          {rows.length === 0 ? <p className="empty">{t.settings.noHistory}</p> : (
            <table>
              <thead>
                <tr>
                  <th>{t.settings.what}</th><th>{t.settings.who}</th>
                  <th>{t.settings.detail}</th><th className="num">{t.settings.when}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = describe(r.action);
                  return (
                    <tr key={r.id}>
                      <td><b>{d.label}</b><br /><span className="mono dim">{d.raw}</span></td>
                      <td>
                        <span className="chip">{t.actors[r.actor_type] ?? r.actor_type}</span>
                        {r.actor_id && names.has(r.actor_id)
                          ? <><br /><span className="mono dim">{names.get(r.actor_id)}</span></> : null}
                      </td>
                      <td className="muted" style={{ fontSize: 12.5, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {details(r.meta, names)}
                      </td>
                      <td className="num">{ago(r.created_at)}</td>
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
