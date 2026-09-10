'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { moveDeal, type ActionResult } from '@/app/(app)/actions';
import { rp } from '@/lib/format';
import { t } from '@/lib/copy';
import type { Deal, Stage } from '@/lib/api';
import { CsrfField } from '@/components/Csrf';

/**
 * Moving a deal is a dropdown, not a drag.
 *
 * Drag-and-drop is fiddly on a trackpad, impossible on a phone and unreachable
 * by keyboard. A labelled list of stages is faster for everyone and needs no
 * explaining.
 */
export function DealCard({ deal, stages }: { deal: Deal; stages: Stage[] }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(moveDeal, null);
  const quiet = deal.status === 'open' && deal.rots_at !== null && new Date(deal.rots_at) < new Date();

  return (
    <article className={`deal ${quiet ? 'rotting' : ''}`}>
      <Link href={`/penjualan/${deal.id}`} className="title" style={{ display: 'block' }}>{deal.title}</Link>
      <div className="mono dim">{deal.contact_name ?? '—'}</div>
      <div className="amt" style={{ marginTop: 6 }}>{rp(deal.amount_idr)}</div>

      {quiet || deal.status !== 'open' ? (
        <div className="foot">
          {quiet ? <span className="chip warn">{t.sales.quietChip}</span> : null}
          {deal.status === 'won' ? <span className="chip good">{t.sales.wonChip}</span> : null}
          {deal.status === 'lost' ? <span className="chip">{t.sales.lostChip}</span> : null}
        </div>
      ) : null}

      <form action={action} style={{ marginTop: 8 }}>
        <CsrfField />
        <input type="hidden" name="dealId" value={deal.id} />
        <label className="mono dim" htmlFor={`stage-${deal.id}`} style={{ display: 'block', marginBottom: 3 }}>
          {t.sales.moveTo}
        </label>
        <select
          className="input" id={`stage-${deal.id}`} name="stageId"
          defaultValue={deal.stage_id} disabled={pending}
          style={{ padding: '5px 7px', fontSize: 12.5 }}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        >
          {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <noscript><button className="btn sm" type="submit" style={{ marginTop: 6 }}>{t.sales.moveTo}</button></noscript>
      </form>

      {state?.error ? <p className="error" style={{ marginTop: 6, fontSize: 11.5 }}>{state.error}</p> : null}
    </article>
  );
}
