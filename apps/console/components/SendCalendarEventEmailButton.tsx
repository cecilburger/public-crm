'use client';

import { useActionState, useEffect, useRef } from 'react';
import { sendCalendarEventEmail, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { GoogleCalendarEvent } from '@/lib/api';

/**
 * Same idea as `SendMeetingEmailButton`, for a Google Calendar event pulled
 * into the Tugas view instead of a task — there's no row in this database to
 * look up by id, so the event's own fields (already in hand from the fetch
 * that rendered it) travel straight through to the API.
 */
export function SendCalendarEventEmailButton({ event }: { event: GoogleCalendarEvent }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(sendCalendarEventEmail, null);

  useEffect(() => {
    if (state?.ok) dialogRef.current?.close();
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
          <input type="hidden" name="eventId" value={event.id} />
          <input type="hidden" name="title" value={event.title} />
          <input type="hidden" name="start" value={event.start} />
          <input type="hidden" name="meetingLink" value={event.meetingLink ?? ''} />
          <div className="record-field">
            <label htmlFor="send-gcal-email-to">{t.tasks.sendEmailTo}</label>
            <input className="line-input" id="send-gcal-email-to" name="to" type="email" required
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
