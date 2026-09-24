'use client';

import { useRef } from 'react';
import Link from '@/components/FastLink';
import { deleteDeal } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { Deal } from '@/lib/api';

/** The Aksi column on the Deal list — detail, edit (opens the slide-in drawer), and delete. */
export function DealRowActions({ deal, onEdit }: { deal: Deal; onEdit: (deal: Deal) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const name = deal.brand_name ?? deal.title;

  return (
    <>
      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Link href={`/deal/${deal.id}`} className="btn ghost sm">{t.sales.detail}</Link>
        <button type="button" className="btn ghost sm" onClick={() => onEdit(deal)}>{t.sales.edit}</button>
        <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
                onClick={() => dialogRef.current?.showModal()}>
          {t.sales.delete}
        </button>
      </span>

      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.sales.deleteTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.sales.discard}
          </button>
        </header>
        <div className="modal-body">
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
            <span>{t.sales.deleteWarning(name)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.sales.discard}
            </button>
            <form action={deleteDeal}>
              <CsrfField />
              <input type="hidden" name="id" value={deal.id} />
              <button className="btn primary" type="submit"
                      style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.sales.deleteConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
