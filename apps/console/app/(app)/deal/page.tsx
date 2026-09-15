import { api, type Brand, type Contact, type ConversationSummary, type Deal, type Member, type Stage } from '@/lib/api';
import { rp } from '@/lib/format';
import { t } from '@/lib/copy';
import { DealBoard } from '@/components/DealBoard';

export const dynamic = 'force-dynamic';

export default async function DealPage() {
  const [deals, pipelines, members, contacts, brands, conversations] = await Promise.all([
    api<Deal[]>('/v1/deals'),
    api<{ stages: Stage[] }>('/v1/pipelines'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Contact[]>('/v1/contacts').catch(() => [] as Contact[]),
    api<Brand[]>('/v1/brands').catch(() => [] as Brand[]),
    api<ConversationSummary[]>('/v1/conversations?limit=200').catch(() => [] as ConversationSummary[]),
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

      <DealBoard deals={deals} stages={stages} members={members} contacts={contacts} brands={brands}
                 conversationByContact={conversationByContact} />
    </>
  );
}
