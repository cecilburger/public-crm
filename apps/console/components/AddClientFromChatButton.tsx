'use client';

import { useEffect, useRef } from 'react';
import { useActionState } from 'react';
import { addClientFromChat, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

/**
 * "Tambah Client" on a Chat WA/Chat IG thread — this contact already exists
 * (they messaged in), so the form just tags them `customer`, which alone is
 * enough to land them on Client On Proses (see `prosesContacts`). The
 * meeting date is optional and purely additional: filling it in also
 * creates a real meeting task (see `addClientFromChat`) so it shows in the
 * "Jadwal Meeting" column — a client added without one just shows there with
 * no date yet, since it might only get scheduled later. Hidden by the caller
 * once the contact already carries the `customer` tag.
 */
export function AddClientFromChatButton({
  contactId, contactName,
}: { contactId: string; contactName: string | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(addClientFromChat, null);

  useEffect(() => {
    // A notice (e.g. "saved, but Google Calendar isn't connected") is worth
    // reading before the dialog disappears — only a plain success closes it.
    if (state?.ok && !state.notice) dialogRef.current?.close();
  }, [state]);

  return (
    <>
      <button type="button" className="btn primary sm" onClick={() => dialogRef.current?.showModal()}>
        {t.client.add}
      </button>

      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.chats.addClientTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.client.discard}
          </button>
        </header>
        <form action={formAction} className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <CsrfField />
          <input type="hidden" name="contactId" value={contactId} />
          <p className="record-hint" style={{ margin: 0 }}>{t.chats.addClientHint}</p>

          <div className="record-field">
            <label htmlFor="acfc-displayName">{t.client.name}</label>
            <input className="line-input" id="acfc-displayName" name="displayName"
                   defaultValue={contactName ?? ''} placeholder={t.client.namePlaceholder} />
          </div>

          <div className="record-field">
            <label htmlFor="acfc-scheduleMeeting">{t.client.scheduleMeeting} (opsional)</label>
            <input className="line-input" id="acfc-scheduleMeeting" name="scheduleMeeting" type="datetime-local" />
          </div>

          {state?.error ? <p className="error" style={{ fontSize: 12.5 }}>{state.error}</p> : null}
          {state?.notice ? <p className="dim" style={{ fontSize: 12.5 }}>{state.notice}</p> : null}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.client.discard}
            </button>
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.chats.addClientSaving : t.client.add}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
