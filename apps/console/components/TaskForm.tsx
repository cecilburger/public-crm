'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { createTask, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { Contact, Member, Deal } from '@/lib/api';

export function TaskForm({ contacts, members, deals }: { contacts: Contact[]; members: Member[]; deals: Deal[] }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createTask, null);

  return (
    <form id="task-form" action={formAction} className="odoo-form-wrapper" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <CsrfField />

      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <Link href="/tugas" style={{ color: 'var(--ink-2)', marginRight: 8, textDecoration: 'none' }}>
              {t.tasks.title}
            </Link>
            <span style={{ color: 'var(--ink-3)', marginRight: 8 }}>/</span>
            <h1>{t.tasks.newTitle}</h1>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.tasks.saving : t.tasks.save}
            </button>
            <Link href="/tugas" className="btn ghost">{t.customers.discard}</Link>
          </div>
        </div>
      </div>

      <div className="main-content-area" style={{ padding: 16 }}>
        <div className="record-sheet" style={{ margin: '0 auto', width: '100%', maxWidth: 720, marginTop: 16 }}>
          {contacts.length === 0 ? (
            <p className="empty" style={{ padding: '24px 0' }}>{t.tasks.noContacts}</p>
          ) : (
            <div className="record-grid">
              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="contactId">{t.tasks.formContact}</label>
                <select className="line-input" id="contactId" name="contactId" required defaultValue="">
                  <option value="" disabled>{t.tasks.chooseContact}</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>{c.displayName ?? c.phone ?? c.id}</option>
                  ))}
                </select>
              </div>

              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="title">{t.tasks.formTitle}</label>
                <input className="line-input" id="title" name="title" required
                       placeholder={t.tasks.titlePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="dueAt">{t.tasks.formDueAt}</label>
                <input className="line-input" id="dueAt" name="dueAt" type="datetime-local" required />
              </div>

              <div className="record-field">
                <label htmlFor="assigneeId">{t.tasks.formAssignee}</label>
                <select className="line-input" id="assigneeId" name="assigneeId" defaultValue="">
                  <option value="">{t.tasks.unassigned}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>

              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="dealId">{t.tasks.formDeal}</label>
                <select className="line-input" id="dealId" name="dealId" defaultValue="">
                  <option value="">{t.tasks.noDeal}</option>
                  {deals.map((d) => (
                    <option key={d.id} value={d.id}>{d.title}{d.contact_name ? ` — ${d.contact_name}` : ''}</option>
                  ))}
                </select>
              </div>

              <div className="record-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="notes">{t.tasks.formNotes}</label>
                <textarea className="line-input" id="notes" name="notes" rows={3}
                          placeholder={t.tasks.notesPlaceholder} />
              </div>
            </div>
          )}

          {state?.error ? <p className="error" style={{ marginTop: 18 }}>{state.error}</p> : null}
        </div>
      </div>
    </form>
  );
}
