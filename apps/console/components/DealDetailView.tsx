'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { updateDealDetails, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { rp, ago } from '@/lib/format';
import { CsrfField } from '@/components/Csrf';
import type { DealDetailResponse, Member } from '@/lib/api';

const ORDER_STATUS_CHIP: Record<string, string> = {
  draft: 'chip', awaiting_payment: 'chip warn', paid: 'chip brand', fulfilled: 'chip good', cancelled: 'chip danger',
};

/** Machine event names, said in words — same convention as Riwayat. */
function activityLabel(action: string): string {
  return t.events[action] ?? action;
}

function activityDetails(meta: Record<string, unknown>, names: Map<string, string>): string {
  const entries = Object.entries(meta ?? {});
  if (entries.length === 0) return '—';
  return entries
    .map(([k, v]) => {
      const raw = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      return `${t.metaKeys[k] ?? k}: ${names.get(raw) ?? raw}`;
    })
    .join(' · ');
}

export function DealDetailView({ data, members }: { data: DealDetailResponse; members: Member[] }) {
  const { deal, orders, activity } = data;
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(updateDealDetails, null);

  const names = new Map(members.map((m) => [m.id, m.name]));
  const ownerName = deal.ownerId ? names.get(deal.ownerId) ?? null : null;

  const statusChip = deal.isWon ? 'chip good' : deal.isLost ? 'chip danger' : 'chip brand';
  const statusLabel = deal.isWon ? t.sales.wonChip : deal.isLost ? t.sales.lostChip : t.dealDetail.openChip;

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <Link href="/penjualan" style={{ color: 'var(--ink-2)', marginRight: 8, textDecoration: 'none' }}>
              {t.dealDetail.back}
            </Link>
            <span style={{ color: 'var(--ink-3)', marginRight: 8 }}>/</span>
            <h1>{deal.title}</h1>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <span className={statusChip}>{statusLabel}</span>
            <span className="chip">{deal.stageName}</span>
            {deal.isLost && deal.lostReason ? (
              <span className="dim" style={{ fontSize: 12.5 }}>{t.dealDetail.lostReason}: {deal.lostReason}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="main-content-area">
        <div className="grid c2" style={{ marginTop: 14, alignItems: 'start' }}>
          <div className="panel">
            <header><h2>{t.dealDetail.summary}</h2></header>
            <div className="body">
              <div className="kv">
                <span>{t.dealDetail.contact}</span>
                <span className="v">
                  <Link href={`/pelanggan/${deal.contactId}`} style={{ color: 'var(--brand)' }}>
                    {deal.contactName ?? deal.contactPhone ?? '—'}
                  </Link>
                </span>
              </div>
              <div className="kv"><span>{t.dealDetail.amount}</span><span className="v">{rp(deal.amountIdr)}</span></div>
              <div className="kv"><span>{t.dealDetail.owner}</span><span className="v">{ownerName ?? t.dealDetail.noOwner}</span></div>
              <div className="kv"><span>{t.dealDetail.created}</span><span className="v">{ago(deal.createdAt)}</span></div>
            </div>
          </div>

          <div className="panel">
            <header><h2>{t.dealDetail.notes}</h2></header>
            <form action={formAction} className="body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <CsrfField />
              <input type="hidden" name="id" value={deal.id} />
              <div className="record-field">
                <label htmlFor="expectedCloseOn">{t.dealDetail.expectedClose}</label>
                <input className="line-input" id="expectedCloseOn" name="expectedCloseOn" type="date"
                       defaultValue={deal.expectedCloseOn ?? ''} />
              </div>
              <div className="record-field">
                <label htmlFor="notes">{t.dealDetail.notes}</label>
                <textarea className="line-input" id="notes" name="notes" rows={5}
                          defaultValue={deal.notes ?? ''} placeholder={t.dealDetail.notesPlaceholder} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="submit" className="btn primary sm" disabled={pending}>
                  {pending ? t.dealDetail.saving : t.dealDetail.save}
                </button>
                {state?.ok ? <span className="dim" style={{ fontSize: 12.5 }}>{t.dealDetail.saved}</span> : null}
                {state?.error ? <span className="error" style={{ fontSize: 12.5 }}>{state.error}</span> : null}
              </div>
            </form>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 14 }}>
          <header><h2>{t.dealDetail.relatedOrders}</h2></header>
          {orders.length === 0 ? (
            <p className="empty" style={{ padding: '24px 0' }}>{t.dealDetail.noOrders}</p>
          ) : (
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.orders.code}</th>
                  <th className="num">{t.orders.total}</th>
                  <th>{t.orders.area}</th>
                  <th className="num">{t.orders.created}</th>
                  <th>{t.orders.status}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.code}</td>
                    <td className="num">{rp(o.totalIdr)}</td>
                    <td>{o.shipArea ?? t.orders.noArea}</td>
                    <td className="num">{ago(o.createdAt)}</td>
                    <td><span className={ORDER_STATUS_CHIP[o.status] ?? 'chip'}>{t.orders.statusLabel[o.status] ?? o.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel" style={{ marginTop: 14 }}>
          <header><h2>{t.dealDetail.activity}</h2></header>
          {activity.length === 0 ? (
            <p className="empty" style={{ padding: '24px 0' }}>{t.dealDetail.noActivity}</p>
          ) : (
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.settings.what}</th>
                  <th>{t.settings.who}</th>
                  <th>{t.settings.detail}</th>
                  <th className="num">{t.settings.when}</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((a) => (
                  <tr key={a.id}>
                    <td><b>{activityLabel(a.action)}</b><br /><span className="mono dim">{a.action}</span></td>
                    <td>
                      <span className="chip">{t.actors[a.actorType] ?? a.actorType}</span>
                      {a.actorId && names.has(a.actorId) ? <><br /><span className="mono dim">{names.get(a.actorId)}</span></> : null}
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{activityDetails(a.meta, names)}</td>
                    <td className="num">{ago(a.createdAt)}</td>
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
