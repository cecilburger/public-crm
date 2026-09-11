'use client';

import { useActionState, useEffect, useRef } from 'react';
import { createTaskInline, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { Contact, Member, Deal } from '@/lib/api';

/**
 * A quick-add panel that slides in from the right, so adding a follow-up
 * doesn't leave the table. The full-page form at `/tugas/baru` is untouched
 * and still reachable directly — this is an additional, faster path in, not
 * a replacement for it.
 */
export function TaskDrawer({
  open, onClose, contacts, members, deals,
}: {
  open: boolean;
  onClose: () => void;
  contacts: Contact[];
  members: Member[];
  deals: Deal[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createTaskInline, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      onClose();
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
           aria-label={t.tasks.newTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.tasks.newTitle}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.tasks.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form ref={formRef} action={formAction} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <CsrfField />
          <div className="drawer-body">
            {contacts.length === 0 ? (
              <p className="empty" style={{ padding: '24px 0' }}>{t.tasks.noContacts}</p>
            ) : (
              <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
                <div className="record-field">
                  <label htmlFor="d-contactId">{t.tasks.formContact}</label>
                  <select className="line-input" id="d-contactId" name="contactId" required defaultValue="">
                    <option value="" disabled>{t.tasks.chooseContact}</option>
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>{c.displayName ?? c.phone ?? c.id}</option>
                    ))}
                  </select>
                </div>

                <div className="record-field">
                  <label htmlFor="d-title">{t.tasks.formTitle}</label>
                  <input className="line-input" id="d-title" name="title" required
                         placeholder={t.tasks.titlePlaceholder} />
                </div>

                <div className="record-field">
                  <label htmlFor="d-dueAt">{t.tasks.formDueAt}</label>
                  <input className="line-input" id="d-dueAt" name="dueAt" type="datetime-local" required />
                </div>

                <div className="record-field">
                  <label htmlFor="d-assigneeId">{t.tasks.formAssignee}</label>
                  <select className="line-input" id="d-assigneeId" name="assigneeId" defaultValue="">
                    <option value="">{t.tasks.unassigned}</option>
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>

                <div className="record-field">
                  <label htmlFor="d-dealId">{t.tasks.formDeal}</label>
                  <select className="line-input" id="d-dealId" name="dealId" defaultValue="">
                    <option value="">{t.tasks.noDeal}</option>
                    {deals.map((d) => (
                      <option key={d.id} value={d.id}>{d.title}{d.contact_name ? ` — ${d.contact_name}` : ''}</option>
                    ))}
                  </select>
                </div>

                <div className="record-field">
                  <label htmlFor="d-notes">{t.tasks.formNotes}</label>
                  <textarea className="line-input" id="d-notes" name="notes" rows={3}
                            placeholder={t.tasks.notesPlaceholder} />
                </div>
              </div>
            )}
            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending || contacts.length === 0}>
              {pending ? t.tasks.saving : t.tasks.save}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.customers.discard}</button>
          </div>
        </form>
      </div>
    </>
  );
}
