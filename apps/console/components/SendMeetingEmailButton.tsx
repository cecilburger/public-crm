'use client';

import { useActionState, useEffect, useRef } from 'react';
import { sendMeetingEmail, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

/**
 * The "Kirim Email" action on a Meeting task — its own dialog rather than a
 * field inside the task's edit form, since a `<dialog>` holding a `<form>`
 * can't live nested inside that outer form without breaking HTML's own
 * nesting rule (the exact bug a nested form caused elsewhere in this app).
 * Sent synchronously: the agent is waiting to see it land, not scheduling it.
 */
export function SendMeetingEmailButton({ taskId }: { taskId: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(sendMeetingEmail, null);

  useEffect(() => {
    if (state?.ok) dialogRef.current?.close();
    // Only react to a fresh successful submit, not to identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.showModal()}>
        {t.tasks.sendEmail}
      </button>

      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.tasks.sendEmailTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.client.discard}
          </button>
        </header>
        <form action={formAction} className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <CsrfField />
          <input type="hidden" name="taskId" value={taskId} />
          <div className="record-field">
            <label htmlFor="send-email-to">{t.tasks.sendEmailTo}</label>
            <input className="line-input" id="send-email-to" name="to" type="email" required
                   placeholder="nama@email.com" />
          </div>

          {state?.error ? <p className="error" style={{ fontSize: 12.5 }}>{state.error}</p> : null}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.client.discard}
            </button>
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.tasks.sendingEmail : t.tasks.sendEmail}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
