'use client';

import { useEffect } from 'react';
import { useActionState } from 'react';
import Link from 'next/link';
import { updateClient, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { toDatetimeLocal } from '@/lib/format';
import type { Contact, Task } from '@/lib/api';

/**
 * The "Detail" / "Edit" quick-access panel on the Client Deal/On Proses
 * tables — same slide-in shell as `ClientAddDrawer`, prefilled from the row
 * already loaded in the table (no extra fetch, same reasoning as
 * `TaskDetailDrawer`). The full page at `/client/[id]` (Riwayat Pembelian,
 * linimasa, chat) is untouched and still reachable directly — this is a
 * faster path for the fields that matter day to day, not a replacement.
 */
export function ClientDetailDrawer({
  contact, nextMeeting = null, open, onClose,
}: { contact: Contact | null; nextMeeting?: Task | null; open: boolean; onClose: () => void }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(updateClient, null);

  useEffect(() => {
    // A notice (e.g. "saved, but Google Calendar isn't connected") is worth
    // reading before the drawer disappears — only a plain success closes it.
    if (state?.ok && !state.notice) onClose();
    // Only react to a fresh successful submit, not to `onClose` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const phoneMasked = contact?.phone?.includes('•') ?? false;

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={t.client.detailTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.client.detailTitle}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.client.discard}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {contact ? (
          <form action={formAction} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <CsrfField />
            <input type="hidden" name="id" value={contact.id} />
            <input type="hidden" name="tags" value={contact.tags.join(', ')} />
            <div className="drawer-body">
              <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="record-field">
                  <label htmlFor="cdd-displayName">{t.client.name}</label>
                  <input className="line-input" id="cdd-displayName" name="displayName"
                         defaultValue={contact.displayName ?? ''} placeholder={t.client.namePlaceholder} />
                </div>

                <div className="record-field">
                  <label htmlFor="cdd-phone">{t.client.phone}</label>
                  <input className="line-input" id="cdd-phone" name="phone" defaultValue={contact.phone ?? ''}
                         placeholder="+62812xxxxxxx" disabled={phoneMasked} />
                  {phoneMasked ? <p className="record-hint">{t.client.phoneMaskedHint}</p> : null}
                </div>

                <div className="record-field">
                  <label htmlFor="cdd-email">{t.client.email}</label>
                  <input className="line-input" id="cdd-email" name="email" type="email"
                         defaultValue={contact.email ?? ''} placeholder="nama@email.com" />
                </div>

                <div className="record-field">
                  <label htmlFor="cdd-igUsername">{t.client.igUsername}</label>
                  <input className="line-input" id="cdd-igUsername" name="igUsername"
                         defaultValue={contact.igUsername ?? ''} placeholder="username" />
                </div>

                <div className="record-field">
                  <label htmlFor="cdd-clientStatus">{t.client.clientStatus}</label>
                  <select className="line-input" id="cdd-clientStatus" name="clientStatus"
                          defaultValue={contact.clientStatus ?? 'on_progress'}>
                    {Object.entries(t.client.clientStatusLabel).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>

                <div className="record-field">
                  <label htmlFor="cdd-address">{t.client.address}</label>
                  <input className="line-input" id="cdd-address" name="address"
                         defaultValue={contact.address ?? ''} placeholder={t.client.addressPlaceholder} />
                </div>

                <div className="record-field">
                  <label htmlFor="cdd-storeName">{t.client.storeName}</label>
                  <input className="line-input" id="cdd-storeName" name="storeName"
                         defaultValue={contact.storeName ?? ''} placeholder={t.client.storeNamePlaceholder} />
                </div>

                <div className="record-field">
                  <label htmlFor="cdd-storeStatus">{t.client.storeStatus}</label>
                  <select className="line-input" id="cdd-storeStatus" name="storeStatus"
                          defaultValue={contact.storeStatus ?? ''}>
                    <option value="">{t.client.storeStatusPlaceholder}</option>
                    {Object.entries(t.client.storeStatusLabel).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>

                <div className="record-field">
                  <label htmlFor="cdd-scheduleMeeting">{t.client.scheduleMeeting}</label>
                  <input className="line-input" id="cdd-scheduleMeeting" name="scheduleMeeting" type="datetime-local"
                         defaultValue={nextMeeting ? toDatetimeLocal(nextMeeting.dueAt) : ''} />
                  <p className="record-hint">{t.client.scheduleMeetingHint}</p>
                </div>
                {/* See `ClientForm`'s own copy of this field for why. */}
                <input type="hidden" name="meetingTask" value={nextMeeting ? JSON.stringify(nextMeeting) : ''} />

                <div className="record-field">
                  <label htmlFor="cdd-notes">{t.client.notes}</label>
                  <textarea className="line-input" id="cdd-notes" name="notes" rows={3}
                            defaultValue={contact.notes ?? ''} placeholder={t.client.notesPlaceholder} />
                </div>
              </div>

              {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
              {state?.notice ? <p className="dim" style={{ marginTop: 14 }}>{state.notice}</p> : null}

              <Link href={`/client/${contact.id}`} className="btn ghost sm" style={{ marginTop: 14 }}>
                {t.client.openFullPage}
              </Link>
            </div>

            <div className="drawer-foot">
              <button type="submit" className="btn primary" disabled={pending}>
                {pending ? t.client.saving : t.client.save}
              </button>
              <button type="button" className="btn ghost" onClick={onClose}>{t.client.discard}</button>
            </div>
          </form>
        ) : null}
      </div>
    </>
  );
}
