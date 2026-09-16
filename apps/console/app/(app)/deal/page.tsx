import { api, type Brand, type ConversationSummary, type Deal, type Member, type Stage, type Task } from '@/lib/api';
import { rp } from '@/lib/format';
import { t } from '@/lib/copy';
import { DealBoard } from '@/components/DealBoard';
import { AddDealButton } from '@/components/AddDealButton';

export const dynamic = 'force-dynamic';

export default async function DealPage() {
  const [deals, pipelines, members, brands, conversations, tasks] = await Promise.all([
    api<Deal[]>('/v1/deals'),
    api<{ stages: Stage[] }>('/v1/pipelines'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Brand[]>('/v1/brands').catch(() => [] as Brand[]),
    api<ConversationSummary[]>('/v1/conversations?limit=200').catch(() => [] as ConversationSummary[]),
    api<Task[]>('/v1/tasks').catch(() => [] as Task[]),
  ]);

  // The Chat quick-action on a deal card jumps straight to a live thread —
  // newest conversation per contact wins, same rule the Pelanggan kanban
  // already uses for its own Chat button.
  const conversationByContact: Record<string, string> = {};
  for (const c of conversations) {
    if (!(c.contact_id in conversationByContact)) conversationByContact[c.contact_id] = c.id;
  }

  const stages = pipelines.stages;
  const openValue = deals.filter((d) => d.status === 'open').reduce((s, d) => s + Number(d.amount_idr), 0);
  const wonValue = deals.filter((d) => d.status === 'won').reduce((s, d) => s + Number(d.amount_idr), 0);
  const quiet = deals.filter((d) => d.status === 'open' && d.rots_at && new Date(d.rots_at) < new Date());

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.sales.title}</h1>
            <p className="subtitle">{t.sales.subtitle}</p>
          </div>
          <div className="odoo-cp-right">
            <span className="chip">{rp(openValue)} {t.sales.inProgress}</span>
            <span className="chip good">{rp(wonValue)} {t.sales.won}</span>
            {quiet.length ? <span className="chip warn">{quiet.length} {t.sales.quiet}</span> : null}
            <span className="mono dim">{t.sales.autoNote}</span>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <AddDealButton stages={stages} brands={brands} />
          </div>
        </div>
      </div>

      <DealBoard deals={deals} stages={stages} members={members} brands={brands}
                 conversationByContact={conversationByContact} tasks={tasks} />
    </>
  );
}
