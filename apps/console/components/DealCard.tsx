'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { moveDeal, quickCreateTaskFromDeal, type ActionResult } from '@/app/(app)/actions';
import { rp, dueLabel, initials } from '@/lib/format';
import { t } from '@/lib/copy';
import type { Deal, Member, Stage } from '@/lib/api';
import { CsrfField } from '@/components/Csrf';
import { KIND_ICON_PATHS } from '@/components/KindIcon';

const ACTION_KINDS = ['meeting', 'call', 'online_meet'] as const;
const ACTION_TITLE: Record<(typeof ACTION_KINDS)[number], string> = {
  meeting: t.sales.actionMeeting, call: t.sales.actionCall, online_meet: t.sales.actionOnlineMeet,
};

/**
 * Moving a deal is a dropdown, not a drag.
 *
 * Drag-and-drop is fiddly on a trackpad, impossible on a phone and unreachable
 * by keyboard. A labelled list of stages is faster for everyone and needs no
 * explaining.
 */
export function DealCard({
  deal, stages, members, conversationId,
}: { deal: Deal; stages: Stage[]; members: Member[]; conversationId?: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(moveDeal, null);
  const [taskState, taskAction, taskPending] = useActionState<ActionResult | null, FormData>(quickCreateTaskFromDeal, null);
  const quiet = deal.status === 'open' && deal.rots_at !== null && new Date(deal.rots_at) < new Date();
  const ownerName = deal.owner_id ? members.find((m) => m.id === deal.owner_id)?.name ?? null : null;
  const due = dueLabel(deal.expected_close_on);
  const dueUrgent = due === 'Hari ini' || (due !== null && due.startsWith('Terlambat'));
  const dotCls = deal.status === 'won' ? 'good' : deal.status === 'lost' ? 'muted' : quiet ? 'warn' : 'open';

  return (
    <article className="deal">
      <Link href={`/deal/${deal.id}`} className="title">{deal.brand_name ?? deal.title}</Link>
      {deal.brand_category ? <div className="line">{deal.brand_category}</div> : null}
      <div className="line">{deal.contact_name ?? '—'}</div>

      {quiet || deal.status === 'won' || deal.status === 'lost' ? (
        <div className="deal-tags">
          {quiet ? <span className="chip warn">{t.sales.quietChip}</span> : null}
          {deal.status === 'won' ? <span className="chip good">{t.sales.wonChip}</span> : null}
          {deal.status === 'lost' ? <span className="chip">{t.sales.lostChip}</span> : null}
        </div>
      ) : null}

      {due ? <div className={`deal-due ${dueUrgent ? 'warn' : ''}`}>{due}</div> : null}

      <div className="foot">
        <span className="avatar" title={ownerName ?? t.dealDetail.noOwner}>{initials(ownerName)}</span>
        <span className="amt">{rp(deal.amount_idr)}</span>
        <span className={`deal-dot ${dotCls}`} title={t.sales.table.status} />
      </div>

      <form action={taskAction} className="deal-quick-actions">
        <CsrfField />
        <input type="hidden" name="contactId" value={deal.contact_id} />
        <input type="hidden" name="dealId" value={deal.id} />
        <input type="hidden" name="contactName" value={deal.contact_name ?? ''} />
        {ACTION_KINDS.map((kind) => (
          <button key={kind} type="submit" name="kind" value={kind} className={`deal-quick-icon ${kind}`}
                  disabled={taskPending} title={ACTION_TITLE[kind]}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {KIND_ICON_PATHS[kind]}
            </svg>
          </button>
        ))}
        {conversationId ? (
          <Link href={`/obrolan/${conversationId}`} className="deal-quick-icon chat" title={t.sales.actionChat}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {KIND_ICON_PATHS.chat}
            </svg>
          </Link>
        ) : (
          <span className="deal-quick-icon chat disabled" title={t.sales.actionNoChat}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {KIND_ICON_PATHS.chat}
            </svg>
          </span>
        )}
      </form>
      {taskState?.error ? <p className="error" style={{ fontSize: 11 }}>{taskState.error}</p> : null}

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
