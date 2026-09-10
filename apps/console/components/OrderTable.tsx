'use client';

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import type { Order } from '@/lib/api';
import { rp, ago, initials } from '@/lib/format';
import { t } from '@/lib/copy';
import { markOrderPaid, fulfillOrder, cancelOrder } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';

const STATUS_CHIP: Record<Order['status'], string> = {
  draft: 'chip', awaiting_payment: 'chip warn', paid: 'chip brand',
  fulfilled: 'chip good', cancelled: 'chip danger',
};

const TABS: { key: 'all' | Order['status']; label: string }[] = [
  { key: 'all', label: t.orders.filterAll },
  { key: 'awaiting_payment', label: t.orders.filterAwaiting },
  { key: 'paid', label: t.orders.filterPaid },
  { key: 'fulfilled', label: t.orders.filterFulfilled },
  { key: 'draft', label: t.orders.filterDraft },
  { key: 'cancelled', label: t.orders.filterCancelled },
];

function CancelOrderButton({ order }: { order: Order }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
              onClick={() => dialogRef.current?.showModal()}>
        {t.orders.cancel}
      </button>
      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.orders.cancelTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.orders.discard}
          </button>
        </header>
        <div className="modal-body">
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
            <span>{t.orders.cancelWarning(order.code)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.orders.discard}
            </button>
            <form action={cancelOrder}>
              <CsrfField />
              <input type="hidden" name="orderId" value={order.id} />
              <button className="btn primary" type="submit"
                      style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.orders.cancelConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}

export function OrderTable({ orders }: { orders: Order[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | Order['status']>('all');

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const o of orders) c[o.status] = (c[o.status] ?? 0) + 1;
    return c;
  }, [orders]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (status !== 'all' && o.status !== status) return false;
      if (!q) return true;
      const haystack = [o.code, o.displayName, o.phone].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [orders, query, status]);

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.orders.title}</h1>
          </div>
          <div className="odoo-cp-search">
            <div className="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input className="line-search-input" value={query} onChange={(e) => setQuery(e.target.value)}
                     placeholder={t.orders.searchPlaceholder} aria-label={t.orders.searchPlaceholder} />
            </div>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions" role="navigation" aria-label="Saring pesanan">
            {TABS.map((tab) => (
              <button key={tab.key} type="button" className={`btn sm ${status === tab.key ? 'primary' : 'ghost'}`}
                      onClick={() => setStatus(tab.key)} aria-current={status === tab.key ? 'page' : undefined}>
                {tab.label}{tab.key !== 'all' && counts[tab.key] ? ` (${counts[tab.key]})` : ''}
              </button>
            ))}
          </div>
          <div className="odoo-cp-right">
            <span className="dim tnum" style={{ fontSize: 12.5 }}>
              {filtered.length} {t.orders.title.toLowerCase()}
            </span>
          </div>
        </div>
      </div>

      <div className="main-content-area">
        {filtered.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>
              {orders.length === 0 ? t.orders.empty : t.orders.noMatches}
            </p>
          </div>
        ) : (
          <div className="panel" style={{ marginTop: 14, border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.orders.code}</th>
                  <th>{t.orders.customer}</th>
                  <th className="num">{t.orders.items}</th>
                  <th className="num">{t.orders.total}</th>
                  <th>{t.orders.area}</th>
                  <th className="num">{t.orders.created}</th>
                  <th>{t.orders.status}</th>
                  <th style={{ textAlign: 'center' }}>{t.orders.actions}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.code}</td>
                    <td>
                      <Link href={`/pelanggan/${o.contactId}`} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span className="avatar" aria-hidden>{initials(o.displayName)}</span>
                        <span>
                          <b>{o.displayName ?? o.phone ?? '—'}</b>
                          {o.displayName && o.phone ? <span className="mono dim" style={{ display: 'block', fontSize: 11 }}>{o.phone}</span> : null}
                        </span>
                      </Link>
                    </td>
                    <td className="num">{t.orders.itemsCount(o.itemCount)}</td>
                    <td className="num">{rp(o.totalIdr)}</td>
                    <td>{o.shipArea ?? t.orders.noArea}</td>
                    <td className="num">{ago(o.createdAt)}</td>
                    <td><span className={STATUS_CHIP[o.status]}>{t.orders.statusLabel[o.status] ?? o.status}</span></td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {o.status === 'awaiting_payment' ? (
                          <>
                            <form action={markOrderPaid}>
                              <CsrfField />
                              <input type="hidden" name="orderId" value={o.id} />
                              <button className="btn ghost sm" type="submit">{t.orders.markPaid}</button>
                            </form>
                            <CancelOrderButton order={o} />
                          </>
                        ) : o.status === 'paid' ? (
                          <form action={fulfillOrder}>
                            <CsrfField />
                            <input type="hidden" name="orderId" value={o.id} />
                            <button className="btn ghost sm" type="submit">{t.orders.fulfill}</button>
                          </form>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
