'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { deleteCustomer } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

/**
 * Edit and delete, right on the row — clicking the name still opens the same
 * full form, this just means you don't have to.
 */
export function CustomerRowActions({ id, name }: { id: string; name: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <span style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        <Link href={`/pelanggan/${id}`} className="btn ghost sm">{t.customers.edit}</Link>
        <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
                onClick={() => dialogRef.current?.showModal()}>
          {t.customers.delete}
        </button>
      </span>

      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.customers.deleteTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.customers.discard}
          </button>
        </header>
        <div className="modal-body">
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
            <span>{t.customers.deleteWarning(name)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.customers.discard}
            </button>
            <form action={deleteCustomer}>
              <CsrfField />
              <input type="hidden" name="id" value={id} />
              <button className="btn primary" type="submit"
                      style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.customers.deleteConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
