import { api, type Deal, type Stage } from '@/lib/api';
import { rp } from '@/lib/format';
import { t } from '@/lib/copy';
import { DealCard } from '@/components/DealCard';

export const dynamic = 'force-dynamic';

export default async function SalesPage() {
  const [deals, pipelines] = await Promise.all([
    api<Deal[]>('/v1/deals'),
    api<{ stages: Stage[] }>('/v1/pipelines'),
  ]);

  const stages = pipelines.stages;
  const openValue = deals.filter((d) => d.status === 'open').reduce((s, d) => s + Number(d.amount_idr), 0);
  const wonValue = deals.filter((d) => d.status === 'won').reduce((s, d) => s + Number(d.amount_idr), 0);
  const quiet = deals.filter((d) => d.status === 'open' && d.rots_at && new Date(d.rots_at) < new Date());

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{t.sales.title}</h1>
          <p className="subtitle">{t.sales.subtitle}</p>
        </div>
        <span className="chip">{rp(openValue)} {t.sales.inProgress}</span>
        <span className="chip good">{rp(wonValue)} {t.sales.won}</span>
        {quiet.length ? <span className="chip warn">{quiet.length} {t.sales.quiet}</span> : null}
        <span className="spacer" />
        <span className="mono dim">{t.sales.autoNote}</span>
      </div>

      {deals.length === 0 ? (
        <div className="empty" style={{ margin: 'auto' }}>
          <h2>{t.sales.noneYet}</h2>
          <p>{t.sales.noneYetHelp}</p>
        </div>
      ) : (
        <div className="board">
          {stages.map((stage) => {
            const cards = deals.filter((d) => d.stage_id === stage.id);
            const value = cards.reduce((s, d) => s + Number(d.amount_idr), 0);
            return (
              <section key={stage.id} className={`column ${stage.is_won ? 'won' : ''} ${stage.is_lost ? 'lost' : ''}`}>
                <header>
                  <h2>{stage.name}</h2>
                  <span className="n tnum">{cards.length}</span>
                </header>
                <div className="cards">
                  {value > 0 ? <span className="mono dim" style={{ padding: '0 2px 2px' }}>{rp(value)}</span> : null}
                  {cards.length === 0
                    ? <p className="dim" style={{ fontSize: 12, padding: '6px 2px' }}>{t.sales.empty}</p>
                    : cards.map((deal) => <DealCard key={deal.id} deal={deal} stages={stages} />)}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
