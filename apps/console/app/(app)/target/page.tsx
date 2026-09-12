import { api, type SalesTarget, type Deal, type Member } from '@/lib/api';
import { rp, dateOnly, initials } from '@/lib/format';
import { t } from '@/lib/copy';
import { SalesTargetEditor } from '@/components/SalesTargetEditor';

export const dynamic = 'force-dynamic';

/** Never stored — always summed fresh from won deals closed inside the target's range. */
function achievedFor(target: SalesTarget, deals: Deal[]): number {
  const start = new Date(target.periodStart).getTime();
  const end = new Date(`${target.periodEnd}T23:59:59.999`).getTime();
  return deals
    .filter((d) => d.status === 'won' && d.closed_at
      && (target.ownerId ? d.owner_id === target.ownerId : true))
    .filter((d) => {
      const closed = new Date(d.closed_at!).getTime();
      return closed >= start && closed <= end;
    })
    .reduce((sum, d) => sum + Number(d.amount_idr), 0);
}

export default async function TargetPage() {
  const [targets, deals, members] = await Promise.all([
    api<SalesTarget[]>('/v1/sales-targets'),
    api<Deal[]>('/v1/deals'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
  ]);
  const names = new Map(members.map((m) => [m.id, m.name]));

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.target.title}</h1>
          <p className="subtitle">{t.target.subtitle}</p>
        </div>
      </div>

      <div className="scroll pad stack">
        {targets.length === 0 ? (
          <div className="empty" style={{ margin: 'auto' }}>
            <h2>{t.target.empty}</h2>
          </div>
        ) : (
          <div className="grid c3">
            {targets.map((tg) => {
              const achieved = achievedFor(tg, deals);
              const pct = Math.min(100, Math.round((achieved / tg.amountIdr) * 100));
              const done = achieved >= tg.amountIdr;
              const scope = tg.ownerId ? (names.get(tg.ownerId) ?? t.target.wholeTeam) : t.target.wholeTeam;

              return (
                <div className="panel" key={tg.id}>
                  <div className="body">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      {tg.ownerId ? <span className="avatar" aria-hidden>{initials(scope)}</span> : null}
                      <span className="mono dim upper">{scope}</span>
                      <span style={{ marginLeft: 'auto' }}>
                        {done
                          ? <span className="chip good">{t.target.statusDone}</span>
                          : <span className="chip">{t.target.statusBehind}</span>}
                      </span>
                    </div>
                    <div className="bignum" style={{ marginTop: 6 }}>{rp(achieved)}</div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                      {t.target.ofTarget} {rp(tg.amountIdr)}
                    </div>
                    <div className={`meter ${done ? 'good' : ''}`} style={{ marginTop: 10 }}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                      {dateOnly(tg.periodStart)} – {dateOnly(tg.periodEnd)}
                    </div>
                    {tg.notes ? <p className="dim" style={{ fontSize: 12.5, marginTop: 6 }}>{tg.notes}</p> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <SalesTargetEditor targets={targets} members={members} />
      </div>
    </>
  );
}
