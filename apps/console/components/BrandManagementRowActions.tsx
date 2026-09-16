'use client';

import { useRef } from 'react';
import { useActionState } from 'react';
import { deleteBrandFromManagement, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { Brand } from '@/lib/api';

/** Edit and delete, right on the row — same shape as Pelanggan's own row actions. */
export function BrandManagementRowActions({ brand }: { brand: Brand }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, deleteAction, deleting] =
    useActionState<ActionResult | null, FormData>(deleteBrandFromManagement, null);

  return (
    <>
      <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
              onClick={() => dialogRef.current?.showModal()}>
        {t.brand.delete}
      </button>

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
          {state?.error ? <p className="error" style={{ fontSize: 12.5 }}>{state.error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.brand.discard}
            </button>
            <form action={deleteAction}>
              <CsrfField />
              <input type="hidden" name="id" value={brand.id} />
              <button className="btn primary" type="submit" disabled={deleting}
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
