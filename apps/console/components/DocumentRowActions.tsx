'use client';

import { useRef } from 'react';
import { deleteDocument } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { DocRecord } from '@/lib/api';
import { withBase } from '@/lib/basePath';

/** Detail (opens the slide-in drawer) and Delete — everything a row needs
 *  without leaving the list. */
export function DocumentRowActions({ doc, onDetail }: { doc: DocRecord; onDetail: (doc: DocRecord) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <span style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        <a href={withBase(`/api/dokumen/${doc.id}/generate`)} target="_blank" rel="noreferrer" className="btn ghost sm">
          {t.document.generate}
        </a>
        <button type="button" className="btn ghost sm" onClick={() => onDetail(doc)}>{t.document.detail}</button>
        <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
                onClick={() => dialogRef.current?.showModal()}>
          {t.document.delete}
        </button>
      </span>

      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.document.deleteTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.document.discard}
          </button>
        </header>
        <div className="modal-body">
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
            <span>{t.document.deleteWarning(doc.name)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.document.discard}
            </button>
            <form action={deleteDocument}>
              <CsrfField />
              <input type="hidden" name="id" value={doc.id} />
              <button className="btn primary" type="submit"
                      style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.document.deleteConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
