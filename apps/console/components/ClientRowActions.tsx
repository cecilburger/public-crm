'use client';

import { useRef } from 'react';
import { deleteClient } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

/**
 * Edit, delete, and Jadwal Meeting, right on the row — Detail/Edit both open
 * the same slide-in `ClientDetailDrawer` (see `ClientTable`), same as
 * clicking the name now does; the full page at `/client/[id]` is still one
 * click away from inside that drawer. Jadwal Meeting opens the same
 * quick-add task drawer as the toolbar's "Tambah Tugas" button, just
 * pre-aimed at this client with kind=meeting — see
 * `ClientQuickAddTaskDrawer`'s `presetContact`.
 */
export function ClientRowActions({
  id, name, onOpenDetail, onScheduleMeeting,
}: {
  id: string; name: string; onOpenDetail: () => void;
  onScheduleMeeting: (contact: { id: string; name: string }) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <span style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        <button type="button" className="btn ghost sm" onClick={onOpenDetail}>{t.client.detail}</button>
        <button type="button" className="btn ghost sm" onClick={onOpenDetail}>{t.client.edit}</button>
        <button type="button" className="btn ghost sm" onClick={() => onScheduleMeeting({ id, name })}>
          {t.tasks.kindLabel.meeting}
        </button>
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
