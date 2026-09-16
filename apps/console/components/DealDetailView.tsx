'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { updateDealDetails, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { rp, ago, dateOnly, initials } from '@/lib/format';
import { CsrfField } from '@/components/Csrf';
import { DealStageFlow } from '@/components/DealStageFlow';
import type { Brand, DealDetailResponse, Member, Stage } from '@/lib/api';

const ORDER_STATUS_CHIP: Record<string, string> = {
  draft: 'chip', awaiting_payment: 'chip warn', paid: 'chip brand', fulfilled: 'chip good', cancelled: 'chip danger',
};

export function DealDetailView({
  data, members, brands, stages,
}: { data: DealDetailResponse; members: Member[]; brands: Brand[]; stages: Stage[] }) {
  const { deal, orders } = data;
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(updateDealDetails, null);

  const names = new Map(members.map((m) => [m.id, m.name]));
  const ownerName = deal.ownerId ? names.get(deal.ownerId) ?? null : null;

  const statusChip = deal.isWon ? 'chip good' : deal.isLost ? 'chip danger' : 'chip brand';
  const statusLabel = deal.isWon ? t.sales.wonChip : deal.isLost ? t.sales.lostChip : t.dealDetail.openChip;

  const countedOrders = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'draft');
  const ordersTotal = countedOrders.reduce((sum, o) => sum + o.totalIdr, 0);

  return (
    <form action={formAction} className="odoo-form-wrapper" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <CsrfField />
      <input type="hidden" name="id" value={deal.id} />

      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <Link href="/deal" style={{ color: 'var(--ink-2)', marginRight: 8, textDecoration: 'none' }}>
              {t.dealDetail.back}
            </Link>
            <span style={{ color: 'var(--ink-3)', marginRight: 8 }}>/</span>
            <h1>{deal.brandName ?? deal.title}</h1>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.dealDetail.saving : t.dealDetail.save}
            </button>
            <Link href="/deal" className="btn ghost">{t.client.discard}</Link>
            <span className={statusChip}>{statusLabel}</span>
            <span className="chip">{deal.stageName}</span>
          </div>
        </div>
      </div>

      <div className="main-content-area" style={{ padding: '16px' }}>
        <div className="record-with-side" style={{ maxWidth: 1560, margin: '0 auto', marginTop: 16 }}>
          <div className="record-sheet" style={{ flex: '1 1 auto', minWidth: 0, maxWidth: 1240 }}>
            <div className="record-header" style={{ alignItems: 'center' }}>
              <span className="record-avatar"><span aria-hidden>{initials(deal.brandName ?? deal.title)}</span></span>
              <div className="record-title" style={{ paddingTop: 0 }}>
                <h1 style={{ margin: 0, fontFamily: 'var(--f-display)', fontSize: 24, fontWeight: 800, letterSpacing: '-.01em' }}>
                  {deal.brandName ?? deal.title}
                </h1>
              </div>
            </div>

            <div className="record-grid">
              {deal.contactId ? (
                <div className="record-field">
                  <label>{t.dealDetail.contact}</label>
                  <Link href={`/client/${deal.contactId}`} className="record-static" style={{ color: 'var(--brand)' }}>
                    {deal.contactName ?? deal.contactPhone ?? '—'}
                  </Link>
                </div>
              ) : null}
              <div className="record-field">
                <label htmlFor="brandId">{t.dealDetail.brand}</label>
                <select className="line-input" id="brandId" name="brandId" defaultValue={deal.brandId ?? ''}>
                  <option value="">{t.dealDetail.chooseBrand}</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div className="record-field">
                <label>{t.dealDetail.category}</label>
                <span className="record-static">{deal.brandCategory ?? t.dealDetail.noCategory}</span>
              </div>
              <div className="record-field">
                <label>{t.dealDetail.amount}</label>
                <span className="record-static">{rp(deal.amountIdr)}</span>
              </div>
              <div className="record-field">
                <label>{t.dealDetail.owner}</label>
                <span className="record-static">{ownerName ?? t.dealDetail.noOwner}</span>
              </div>
              <div className="record-field">
                <label htmlFor="expectedCloseOn">{t.dealDetail.expectedClose}</label>
                <input className="line-input" id="expectedCloseOn" name="expectedCloseOn" type="date"
                       defaultValue={deal.expectedCloseOn ?? ''} />
              </div>
              <div className="record-field">
                <label>{t.dealDetail.created}</label>
                <span className="record-static">{ago(deal.createdAt)}</span>
              </div>
              {deal.isLost && deal.lostReason ? (
                <div className="record-field">
                  <label>{t.dealDetail.lostReason}</label>
                  <span className="record-static">{deal.lostReason}</span>
                </div>
              ) : null}
              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="notes">{t.dealDetail.notes}</label>
                <textarea className="line-input" id="notes" name="notes" rows={4}
                          defaultValue={deal.notes ?? ''} placeholder={t.dealDetail.notesPlaceholder} />
              </div>
            </div>

            <div className="record-timeline">
              <h3>{t.dealDetail.relatedOrders}</h3>
              {orders.length === 0 ? (
                <p className="record-hint">{t.dealDetail.noOrders}</p>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 24, margin: '4px 0 14px' }}>
                    <div>
                      <div className="dim" style={{ fontSize: 12 }}>{t.client.purchases.count}</div>
                      <div className="bignum" style={{ fontSize: 20 }}>{countedOrders.length}</div>
                    </div>
                    <div>
                      <div className="dim" style={{ fontSize: 12 }}>{t.client.purchases.column}</div>
                      <div className="bignum" style={{ fontSize: 20 }}>{rp(ordersTotal)}</div>
                    </div>
                  </div>
                  <div className="timeline-list">
                    {orders.map((o) => (
                      <div key={o.id} className="timeline-row">
                        <span className="timeline-dot" aria-hidden />
                        <div className="timeline-body">
                          <div className="timeline-head">
                            <b className="mono">{o.code}</b>
                            <span className={ORDER_STATUS_CHIP[o.status] ?? 'chip'}>{t.orders.statusLabel[o.status] ?? o.status}</span>
                            <span className="mono dim" style={{ marginLeft: 'auto' }}>{dateOnly(o.createdAt)}</span>
                          </div>
                          <span className="dim" style={{ fontSize: 12.5 }}>
                            {o.shipArea ?? t.orders.noArea} · {rp(o.totalIdr)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {state?.error ? <p className="error" style={{ marginTop: 18 }}>{state.error}</p> : null}
          </div>

          <aside className="record-side">
            <DealStageFlow stages={stages} deal={deal} />
          </aside>
        </div>
      </div>
    </form>
  );
}
