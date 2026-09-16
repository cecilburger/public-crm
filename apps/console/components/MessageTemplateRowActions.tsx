'use client';

import { useRef } from 'react';
import { useActionState } from 'react';
import { removeMessageTemplate, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { MessageTemplate } from '@/lib/api';

/** Delete, with a confirm dialog — same shape as every other row-delete in the app. */
export function MessageTemplateRowActions({ template }: { template: MessageTemplate }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, deleteAction, deleting] = useActionState<ActionResult | null, FormData>(removeMessageTemplate, null);

  return (
    <>
      <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
              onClick={() => dialogRef.current?.showModal()}>
        {t.messageTemplate.delete}
      </button>

      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.messageTemplate.deleteTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.messageTemplate.discard}
          </button>
        </header>
        <div className="modal-body">
          <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
            <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
            <span>{t.messageTemplate.deleteWarning(template.name)}</span>
          </div>
          {state?.error ? <p className="error" style={{ fontSize: 12.5 }}>{state.error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.messageTemplate.discard}
            </button>
            <form action={deleteAction}>
              <CsrfField />
              <input type="hidden" name="id" value={template.id} />
              <button className="btn primary" type="submit" disabled={deleting}
                      style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.messageTemplate.deleteConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </>
  );
}
