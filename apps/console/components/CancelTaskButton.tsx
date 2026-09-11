'use client';

import { useRef } from 'react';
import type { Task } from '@/lib/api';
import { t } from '@/lib/copy';
import { cancelTask } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';

/** Shared by the table and kanban views — same confirm dialog either way. */
export function CancelTaskButton({ task }: { task: Task }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
              onClick={() => dialogRef.current?.showModal()}>
        {t.tasks.cancel}
      </button>
      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.tasks.cancelTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.tasks.discard}
          </button>
        </header>
        <div className="modal-body">
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
            <span>{t.tasks.cancelWarning(task.title)}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.tasks.discard}
            </button>
            <form action={cancelTask}>
              <CsrfField />
              <input type="hidden" name="taskId" value={task.id} />
              <button className="btn primary" type="submit"
                      style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.tasks.cancelConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
