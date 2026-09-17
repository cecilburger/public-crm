'use client';

import { useActionState, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { createClient, updateClient, deleteClient, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { initials } from '@/lib/format';
import { ContactTimeline } from '@/components/ContactTimeline';
import { ClientPurchases } from '@/components/ClientPurchases';
import { ClientActivities } from '@/components/ClientActivities';
import { ClientTaskDrawer } from '@/components/ClientTaskDrawer';
import type { ContactDetail, ContactOrder, ContactTimelineEvent, Member, Task, Deal, TaskKind } from '@/lib/api';

/**
 * One sheet, two callers: a blank one for `/client/baru`, a filled-in one
 * for `/client/[id]`. Whether `contact` is set decides which — present,
 * it's an edit (and Delete and the activity timeline become available);
 * absent, whatever gets typed here becomes a new contact.
 */
export function ClientForm({
  contact, conversationId = null, timeline, members = [], orders = [], tasks = [], deals = [], taskKinds = [],
}: {
  contact: ContactDetail | null; conversationId?: string | null;
  timeline?: ContactTimelineEvent[]; members?: Member[]; orders?: ContactOrder[]; tasks?: Task[];
  deals?: Deal[]; taskKinds?: TaskKind[];
}) {
  const action = contact ? updateClient : createClient;
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);

  // Preview only — nothing here is submitted with the form yet, there is
  // nowhere on the backend to put it. The `name`-less file input below is
  // what keeps it out of the FormData the server action receives.
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const onPhotoChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPhotoPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  // A masked number ("+62•••••••706") is not something anyone should be able
  // to save back as-is — disabling the field means the browser never submits
  // it, so editing the name or tags can't accidentally wipe out a real number.
  const phoneMasked = contact?.phone?.includes('•') ?? false;

  return (
    <>
      <form id="client-form" action={formAction} className="odoo-form-wrapper" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <CsrfField />
        {contact ? <input type="hidden" name="id" value={contact.id} /> : null}

        <div className="odoo-control-panel">
          <div className="odoo-cp-top">
            <div className="odoo-cp-breadcrumb">
              <Link href="/client" style={{ color: 'var(--ink-2)', marginRight: 8, textDecoration: 'none' }}>
                {t.client.title}
              </Link>
              <span style={{ color: 'var(--ink-3)', marginRight: 8 }}>/</span>
              <h1>{contact ? (contact.displayName || contact.phone || '—') : t.client.newClient}</h1>
            </div>
          </div>
          <div className="odoo-cp-bottom">
            <div className="odoo-cp-actions">
              <button type="submit" className="btn primary" disabled={pending}>
                {pending ? t.client.saving : t.client.save}
              </button>
              <Link href="/client" className="btn ghost">{t.client.discard}</Link>
              {contact ? (
                <button type="button" className="btn ghost"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => deleteDialogRef.current?.showModal()}>
                  {t.client.delete}
                </button>
              ) : null}
              {contact ? (
                <button type="button" className="btn ghost" onClick={() => setTaskDrawerOpen(true)}>
                  {t.tasks.add}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="main-content-area" style={{ padding: '16px' }}>
          <div className="record-with-side" style={{ maxWidth: contact ? 1560 : 1240, margin: '0 auto', marginTop: 16 }}>
            <div className="record-sheet" style={{ flex: '1 1 auto', minWidth: 0, maxWidth: 1240 }}>
            <div className="record-header">
              <label className="record-avatar" style={{ cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>
                {photoPreview ? (
                  <img src={photoPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span aria-hidden>{initials(contact?.displayName ?? null)}</span>
                )}
                <span className="record-avatar-badge" aria-hidden>{t.client.photoChange}</span>
                <input type="file" accept="image/*" onChange={onPhotoChange}
                      style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                      aria-label={t.client.photoUpload} />
              </label>
              <div className="record-title">
                <input name="displayName" defaultValue={contact?.displayName ?? ''}
                      placeholder={t.client.namePlaceholder} aria-label={t.client.name} />
              </div>
            </div>

            <div className="record-grid">
              <div className="record-field">
                <label htmlFor="phone">{t.client.phone}</label>
                <input className="line-input" id="phone" name="phone" defaultValue={contact?.phone ?? ''}
                      placeholder="+62812xxxxxxx" disabled={phoneMasked} />
                {phoneMasked ? <p className="record-hint">{t.client.phoneMaskedHint}</p> : null}
              </div>
              <div className="record-field">
                <label htmlFor="email">{t.client.email}</label>
                <input className="line-input" id="email" name="email" type="email"
                      defaultValue={contact?.email ?? ''} placeholder="nama@email.com" />
              </div>
              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="address">{t.client.address}</label>
                <input className="line-input" id="address" name="address"
                      defaultValue={contact?.address ?? ''} placeholder={t.client.addressPlaceholder} />
              </div>
              {/* Label field removed from the form — the tags themselves (incl.
                  `customer`, which every Client list filters on) still ride
                  along as a hidden field so saving never wipes them out. */}
              <input type="hidden" name="tags" value={contact?.tags.join(', ') ?? ''} />
              {contact ? (
                <div className="record-field">
                  <label>{t.client.chat}</label>
                  {conversationId ? (
                    <Link href={`/obrolan/${conversationId}`} className="btn ghost" style={{ width: 'fit-content' }}>
                      {t.client.chat}
                    </Link>
                  ) : (
                    <p className="record-hint" style={{ marginTop: 6 }}>{t.client.noChat}</p>
                  )}
                </div>
              ) : null}
              <div className="record-field">
                <label htmlFor="storeName">{t.client.storeName}</label>
                <input className="line-input" id="storeName" name="storeName"
                      defaultValue={contact?.storeName ?? ''} placeholder={t.client.storeNamePlaceholder} />
              </div>
              <div className="record-field">
                <label htmlFor="storeStatus">{t.client.storeStatus}</label>
                <select className="line-input" id="storeStatus" name="storeStatus"
                        defaultValue={contact?.storeStatus ?? ''}>
                  <option value="">{t.client.storeStatusPlaceholder}</option>
                  {Object.entries(t.client.storeStatusLabel).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="record-field">
                <label htmlFor="scheduleMeeting">{t.client.scheduleMeeting}</label>
                <input className="line-input" id="scheduleMeeting" name="scheduleMeeting" type="datetime-local"
                      defaultValue={contact?.scheduleMeeting ?? ''} />
              </div>
              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="notes">{t.client.notes}</label>
                <textarea className="line-input" id="notes" name="notes" rows={3}
                          defaultValue={contact?.notes ?? ''} placeholder={t.client.notesPlaceholder} />
              </div>
            </div>

            {contact ? <ClientPurchases orders={orders} /> : null}

            {contact && timeline ? (
              <div className="record-timeline">
                <h3>{t.timeline.title}</h3>
                <ContactTimeline events={timeline} members={members} />
              </div>
            ) : null}

            {state?.error ? <p className="error" style={{ marginTop: 18 }}>{state.error}</p> : null}
          </div>

          {contact ? (
            <aside className="record-side">
              <ClientActivities tasks={tasks} members={members} />
            </aside>
          ) : null}
          </div>
        </div>
      </form>

      {contact ? (
        <dialog ref={deleteDialogRef} className="modal">
          <header className="modal-head">
            <h2>{t.client.deleteTitle}</h2>
            <button type="button" className="btn ghost sm" onClick={() => deleteDialogRef.current?.close()}>
              {t.client.discard}
            </button>
          </header>
          <div className="modal-body">
            <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
              <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
              <span>{t.client.deleteWarning(contact.displayName ?? contact.phone ?? '—')}</span>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => deleteDialogRef.current?.close()}>
                {t.client.discard}
              </button>
              <form action={deleteClient}>
                <CsrfField />
                <input type="hidden" name="id" value={contact.id} />
                <button className="btn primary" type="submit"
                        style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                  {t.client.deleteConfirm}
                </button>
              </form>
            </div>
          </div>
        </dialog>
      ) : null}

      {contact ? (
        <ClientTaskDrawer open={taskDrawerOpen} onClose={() => setTaskDrawerOpen(false)}
                          contact={contact} members={members} deals={deals} taskKinds={taskKinds} />
      ) : null}
    </>
  );
}
