import { api, type Deal, type Stage } from '@/lib/api';
import { rp } from '@/lib/format';
import { t } from '@/lib/copy';
import { SalesBoard } from '@/components/SalesBoard';

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

      <SalesBoard deals={deals} stages={stages} />
    </>
  );
}
