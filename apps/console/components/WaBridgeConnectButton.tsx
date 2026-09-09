'use client';

import { useActionState, useEffect, useRef } from 'react';
import { createWaBridgeSession, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

export function WaBridgeConnectButton() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(createWaBridgeSession, null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      dialogRef.current?.close();
    }
  }, [state]);

  return (
    <>
      <button type="button" className="btn primary sm" onClick={() => dialogRef.current?.showModal()}>
        {t.waBridge.connect}
      </button>
      <dialog ref={dialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.waBridge.addNumber}</h2>
          <button type="button" className="btn ghost sm" onClick={() => dialogRef.current?.close()}>
            {t.waBridge.cancel}
          </button>
        </header>
        <form action={action} ref={formRef} className="modal-body">
          <CsrfField />
          <div className="field">
            <label htmlFor="displayName">{t.waBridge.addNumber}</label>
            <input className="input" id="displayName" name="displayName" required autoFocus
                   placeholder={t.waBridge.namePlaceholder} />
          </div>
          {state?.error ? <p className="error">{state.error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>
              {t.waBridge.cancel}
            </button>
            <button className="btn primary" type="submit" disabled={pending}>
              {pending ? t.waBridge.connecting : t.waBridge.connect}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
