'use client';

import { useEffect, useRef, useState } from 'react';
import { useActionState } from 'react';
import { createDealAction, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { Brand, Contact } from '@/lib/api';

/**
 * The "+" on a kanban column, Odoo-style — a deal is really a brand
 * opportunity now, so the title isn't typed by hand here: it's set to
 * whichever brand gets picked, the same fallback every other Deal view
 * already shows (`brand_name ?? title`).
 */
export function QuickAddDealDrawer({
  stageId, stageName, contacts, brands, onClose,
}: { stageId: string | null; stageName: string; contacts: Contact[]; brands: Brand[]; onClose: () => void }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createDealAction, null);
  const ref = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [brandId, setBrandId] = useState('');

  useEffect(() => {
    if (stageId) { ref.current?.showModal(); setBrandId(''); }
    else ref.current?.close();
  }, [stageId]);

  useEffect(() => {
    if (state?.ok) { formRef.current?.reset(); onClose(); }
    // Only react to a fresh successful submit, not to `onClose` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!stageId) return null;
  const brandName = brands.find((b) => b.id === brandId)?.name ?? '';

  return (
    <dialog ref={ref} className="modal" onClose={onClose}>
      <header className="modal-head">
        <h2>{t.sales.addTitle(stageName)}</h2>
        <button type="button" className="btn ghost sm" onClick={onClose}>{t.sales.discard}</button>
      </header>
      <form ref={formRef} action={formAction} className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <CsrfField />
        <input type="hidden" name="stageId" value={stageId} />
        <input type="hidden" name="title" value={brandName} />

        <div className="record-field">
          <label htmlFor="qd-brand">{t.dealDetail.brand}</label>
          <select className="line-input" id="qd-brand" name="brandId" required
                  value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="" disabled>{t.dealDetail.chooseBrand}</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>

        <div className="record-field">
          <label htmlFor="qd-contact">{t.dealDetail.contact}</label>
          <select className="line-input" id="qd-contact" name="contactId" required defaultValue="">
            <option value="" disabled>{t.sales.chooseContact}</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.displayName ?? c.phone ?? c.id}</option>)}
          </select>
        </div>

        <div className="record-field">
          <label htmlFor="qd-amount">{t.dealDetail.amount}</label>
          <input className="line-input" id="qd-amount" name="amountIdr" type="number" min={0} step={1000}
                 defaultValue={0} required />
        </div>

        {state?.error ? <p className="error" style={{ fontSize: 12.5 }}>{state.error}</p> : null}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>{t.sales.discard}</button>
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? t.dealDetail.saving : t.dealDetail.save}
          </button>
        </div>
      </form>
    </dialog>
  );
}
