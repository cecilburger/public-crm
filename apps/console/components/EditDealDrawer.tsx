'use client';

import { useEffect, useRef, useState } from 'react';
import { useActionState } from 'react';
import { updateDealDetails, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { Brand, Deal } from '@/lib/api';

/**
 * Slide-in edit panel for a deal's brand and amount — the two fields the
 * list page's Aksi column can change without a trip to the full detail page.
 * Same drawer chrome as adding a deal and as the Tugas quick-add.
 */
export function EditDealDrawer({
  deal, brands, onClose,
}: { deal: Deal | null; brands: Brand[]; onClose: () => void }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(updateDealDetails, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [brandId, setBrandId] = useState('');
  const open = deal !== null;

  useEffect(() => {
    if (deal) setBrandId(deal.brand_id ?? '');
  }, [deal]);

  useEffect(() => {
    if (state?.ok) { formRef.current?.reset(); onClose(); }
    // Only react to a fresh successful submit, not to `onClose` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const brandName = brands.find((b) => b.id === brandId)?.name ?? '';
  const title = deal ? t.sales.editTitle(deal.brand_name ?? deal.title) : '';

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={title} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.sales.discard}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form key={deal?.id ?? 'closed'} ref={formRef} action={formAction}
              style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <CsrfField />
          <input type="hidden" name="id" value={deal?.id ?? ''} />
          <input type="hidden" name="brandId" value={brandId} />
          <input type="hidden" name="title" value={brandName} />

          <div className="drawer-body">
            {brands.length === 0 ? (
              <p className="empty" style={{ padding: '24px 0' }}>{t.tasks.noBrands}</p>
            ) : (
              <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="record-field">
                  <label htmlFor="ed-brand">{t.dealDetail.brand}</label>
                  <select className="line-input" id="ed-brand" required
                          value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                    <option value="" disabled>{t.dealDetail.chooseBrand}</option>
                    {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>

                <div className="record-field">
                  <label htmlFor="ed-amount">{t.dealDetail.amount}</label>
                  <input className="line-input" id="ed-amount" name="amountIdr" type="number" min={0} step={1000}
                         defaultValue={deal?.amount_idr ?? 0} required />
                </div>
              </div>
            )}
            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending || brands.length === 0}>
              {pending ? t.dealDetail.saving : t.dealDetail.save}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.sales.discard}</button>
          </div>
        </form>
      </div>
    </>
  );
}
