'use client';

import { useEffect, useRef } from 'react';
import { useActionState } from 'react';
import { createClientInline, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';

/**
 * The "Tambah Client" quick-add panel on the Client Deal/On Proses tables —
 * same slide-in shell as the Tugas page's own `TaskDrawer`. The full-page
 * form at `/client/baru` is untouched and still reachable directly; this is
 * an additional, faster path in, not a replacement for it.
 */
export function ClientAddDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createClientInline, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      // A notice (e.g. "saved, but Google Calendar isn't connected") is
      // worth reading before the drawer disappears — only a plain success
      // closes it right away.
      if (!state.notice) onClose();
    }
    // Only react to a fresh successful submit, not to `onClose` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={t.client.newClient} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.client.newClient}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.client.discard}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form ref={formRef} action={formAction} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <CsrfField />
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label htmlFor="cad-displayName">{t.client.name}</label>
                <input className="line-input" id="cad-displayName" name="displayName"
                       placeholder={t.client.namePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="cad-phone">{t.client.phone}</label>
                <input className="line-input" id="cad-phone" name="phone" placeholder="+62812xxxxxxx" />
              </div>

              <div className="record-field">
                <label htmlFor="cad-email">{t.client.email}</label>
                <input className="line-input" id="cad-email" name="email" type="email" placeholder="nama@email.com" />
              </div>

              <div className="record-field">
                <label htmlFor="cad-igUsername">{t.client.igUsername}</label>
                <input className="line-input" id="cad-igUsername" name="igUsername" placeholder="username" />
              </div>

              <div className="record-field">
                <label htmlFor="cad-clientStatus">{t.client.clientStatus}</label>
                <select className="line-input" id="cad-clientStatus" name="clientStatus" defaultValue="on_progress">
                  {Object.entries(t.client.clientStatusLabel).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="cad-address">{t.client.address}</label>
                <input className="line-input" id="cad-address" name="address" placeholder={t.client.addressPlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="cad-storeName">{t.client.storeName}</label>
                <input className="line-input" id="cad-storeName" name="storeName"
                       placeholder={t.client.storeNamePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="cad-storeStatus">{t.client.storeStatus}</label>
                <select className="line-input" id="cad-storeStatus" name="storeStatus" defaultValue="">
                  <option value="">{t.client.storeStatusPlaceholder}</option>
                  {Object.entries(t.client.storeStatusLabel).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="cad-scheduleMeeting">{t.client.scheduleMeeting}</label>
                <input className="line-input" id="cad-scheduleMeeting" name="scheduleMeeting" type="datetime-local" />
              </div>

              <div className="record-field">
                <label htmlFor="cad-notes">{t.client.notes}</label>
                <textarea className="line-input" id="cad-notes" name="notes" rows={3}
                          placeholder={t.client.notesPlaceholder} />
              </div>
            </div>
            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
            {state?.notice ? <p className="dim" style={{ marginTop: 14 }}>{state.notice}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.client.saving : t.client.save}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.client.discard}</button>
          </div>
        </form>
      </div>
    </>
  );
}
