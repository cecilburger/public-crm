'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { setBrandStatus, deleteBrand } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { Brand } from '@/lib/api';

const STATUSES: Brand['status'][] = ['not_contacted', 'contacted', 'replied', 'interested', 'rejected'];

/** A status dropdown that submits itself, plus Edit and Delete — everything
 *  a row needs without opening the full record. */
export function BrandRowActions({ brand }: { brand: Brand }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <span style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}>
        <form action={setBrandStatus}>
          <CsrfField />
          <input type="hidden" name="id" value={brand.id} />
          <select className="input" name="status" defaultValue={brand.status}
                  style={{ padding: '5px 7px', fontSize: 12.5 }}
                  aria-label={t.brand.status}
                  onChange={(e) => e.currentTarget.form?.requestSubmit()}>
            {STATUSES.map((s) => <option key={s} value={s}>{t.brand.statusLabel[s]}</option>)}
          </select>
        </form>
        <Link href={`/brand/${brand.id}`} className="btn ghost sm">{t.brand.edit}</Link>
        <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
                onClick={() => dialogRef.current?.showModal()}>
          {t.brand.delete}
        </button>
      </span>

      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.brand.deleteTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.brand.discard}
          </button>
        </header>
        <div className="modal-body">
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
            <span>{t.brand.deleteWarning(brand.name)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.brand.discard}
            </button>
            <form action={deleteBrand}>
              <CsrfField />
              <input type="hidden" name="id" value={brand.id} />
              <button className="btn primary" type="submit"
                      style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.brand.deleteConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
