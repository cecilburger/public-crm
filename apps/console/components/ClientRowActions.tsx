'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { deleteClient } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

/**
 * Edit and delete, right on the row — clicking the name still opens the same
 * full form, this just means you don't have to.
 */
export function ClientRowActions({ id, name }: { id: string; name: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <span style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        <Link href={`/client/${id}`} className="btn ghost sm">{t.client.detail}</Link>
        <Link href={`/client/${id}`} className="btn ghost sm">{t.client.edit}</Link>
        <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
                onClick={() => dialogRef.current?.showModal()}>
          {t.client.delete}
        </button>
      </span>

      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.client.deleteTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.client.discard}
          </button>
        </header>
        <div className="modal-body">
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
            <span>{t.client.deleteWarning(name)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.client.discard}
            </button>
            <form action={deleteClient}>
              <CsrfField />
              <input type="hidden" name="id" value={id} />
              <button className="btn primary" type="submit"
                      style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.client.deleteConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
