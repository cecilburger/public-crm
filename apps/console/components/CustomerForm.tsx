'use client';

import { useActionState, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { createCustomer, updateCustomer, deleteCustomer, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { initials } from '@/lib/format';
import { ContactTimeline } from '@/components/ContactTimeline';
import { CustomerPurchases } from '@/components/CustomerPurchases';
import type { ContactDetail, ContactOrder, ContactTimelineEvent, Member } from '@/lib/api';

/**
 * One sheet, two callers: a blank one for `/pelanggan/baru`, a filled-in one
 * for `/pelanggan/[id]`. Whether `contact` is set decides which — present,
 * it's an edit (and Delete and the activity timeline become available);
 * absent, whatever gets typed here becomes a new contact.
 */
export function CustomerForm({
  contact, conversationId = null, timeline, members = [], orders = [],
}: {
  contact: ContactDetail | null; conversationId?: string | null;
  timeline?: ContactTimelineEvent[]; members?: Member[]; orders?: ContactOrder[];
}) {
  const action = contact ? updateCustomer : createCustomer;
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

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
      <form id="customer-form" action={formAction} className="odoo-form-wrapper" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <CsrfField />
        {contact ? <input type="hidden" name="id" value={contact.id} /> : null}

        <div className="odoo-control-panel">
          <div className="odoo-cp-top">
            <div className="odoo-cp-breadcrumb">
              <Link href="/pelanggan" style={{ color: 'var(--ink-2)', marginRight: 8, textDecoration: 'none' }}>
                {t.customers.title}
              </Link>
              <span style={{ color: 'var(--ink-3)', marginRight: 8 }}>/</span>
              <h1>{contact ? (contact.displayName || contact.phone || '—') : t.customers.newCustomer}</h1>
            </div>
          </div>
          <div className="odoo-cp-bottom">
            <div className="odoo-cp-actions">
              <button type="submit" className="btn primary" disabled={pending}>
                {pending ? t.customers.saving : t.customers.save}
              </button>
              <Link href="/pelanggan" className="btn ghost">{t.customers.discard}</Link>
              {contact ? (
                <button type="button" className="btn ghost"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => deleteDialogRef.current?.showModal()}>
                  {t.customers.delete}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="main-content-area" style={{ padding: '16px' }}>
          <div className="record-sheet" style={{ margin: '0 auto', width: '100%', maxWidth: 1240, marginTop: 16 }}>
            <div className="record-header">
              <label className="record-avatar" style={{ cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>
                {photoPreview ? (
                  <img src={photoPreview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span aria-hidden>{initials(contact?.displayName ?? null)}</span>
                )}
                <span className="record-avatar-badge" aria-hidden>{t.customers.photoChange}</span>
                <input type="file" accept="image/*" onChange={onPhotoChange}
                      style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                      aria-label={t.customers.photoUpload} />
              </label>
              <div className="record-title">
                <input name="displayName" defaultValue={contact?.displayName ?? ''}
                      placeholder={t.customers.namePlaceholder} aria-label={t.customers.name} />
              </div>
            </div>

            <div className="record-grid">
              <div className="record-field">
                <label htmlFor="phone">{t.customers.phone}</label>
                <input className="line-input" id="phone" name="phone" defaultValue={contact?.phone ?? ''}
                      placeholder="+62812xxxxxxx" disabled={phoneMasked} />
                {phoneMasked ? <p className="record-hint">{t.customers.phoneMaskedHint}</p> : null}
              </div>
              <div className="record-field">
                <label htmlFor="email">{t.customers.email}</label>
                <input className="line-input" id="email" name="email" type="email"
                      defaultValue={contact?.email ?? ''} placeholder="nama@email.com" />
              </div>
              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="address">{t.customers.address}</label>
                <input className="line-input" id="address" name="address"
                      defaultValue={contact?.address ?? ''} placeholder={t.customers.addressPlaceholder} />
              </div>
              <div className="record-field">
                <label htmlFor="tags">{t.customers.tags}</label>
                <input className="line-input" id="tags" name="tags" defaultValue={contact?.tags.join(', ') ?? ''} />
                <p className="record-hint">{t.customers.tagsHint}</p>
              </div>
              {contact ? (
                <div className="record-field">
                  <label>{t.customers.chat}</label>
                  {conversationId ? (
                    <Link href={`/obrolan/${conversationId}`} className="btn ghost" style={{ width: 'fit-content' }}>
                      {t.customers.chat}
                    </Link>
                  ) : (
                    <p className="record-hint" style={{ marginTop: 6 }}>{t.customers.noChat}</p>
                  )}
                </div>
              ) : null}
              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="notes">{t.customers.notes}</label>
                <textarea className="line-input" id="notes" name="notes" rows={3}
                          defaultValue={contact?.notes ?? ''} placeholder={t.customers.notesPlaceholder} />
              </div>
            </div>

            {contact ? <CustomerPurchases orders={orders} /> : null}

            {contact && timeline ? (
              <div className="record-timeline">
                <h3>{t.timeline.title}</h3>
                <ContactTimeline events={timeline} members={members} />
              </div>
            ) : null}

            {state?.error ? <p className="error" style={{ marginTop: 18 }}>{state.error}</p> : null}
          </div>
        </div>
      </form>

      {contact ? (
        <dialog ref={deleteDialogRef} className="modal">
          <header className="modal-head">
            <h2>{t.customers.deleteTitle}</h2>
            <button type="button" className="btn ghost sm" onClick={() => deleteDialogRef.current?.close()}>
              {t.customers.discard}
            </button>
          </header>
          <div className="modal-body">
            <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
              <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
              <span>{t.customers.deleteWarning(contact.displayName ?? contact.phone ?? '—')}</span>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => deleteDialogRef.current?.close()}>
                {t.customers.discard}
              </button>
              <form action={deleteCustomer}>
                <CsrfField />
                <input type="hidden" name="id" value={contact.id} />
                <button className="btn primary" type="submit"
                        style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                  {t.customers.deleteConfirm}
                </button>
              </form>
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
