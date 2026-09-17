'use client';

import { useEffect, useRef, useState } from 'react';
import { useActionState } from 'react';
import { createTask, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { TaskKindField } from '@/components/TaskKindField';
import type { ContactDetail, Member, Deal, TaskKind } from '@/lib/api';

/**
 * The "Tambah Tugas" button on a Client's own page — same slide-in shell as
 * the Tugas page's own quick-add drawer (and `BrandTaskDrawer`'s twin for
 * Brand), but the client is fixed (no picker, this page already is one), and
 * saving redirects to Tugas instead of just closing the panel — `createTask`
 * (not `createTaskInline`) is what does that.
 */
export function ClientTaskDrawer({
  open, onClose, contact, members, deals, taskKinds,
}: {
  open: boolean;
  onClose: () => void;
  contact: ContactDetail;
  members: Member[];
  deals: Deal[];
  taskKinds: TaskKind[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createTask, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState('follow_up');
  const [repeatUnit, setRepeatUnit] = useState('');

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
          <input type="hidden" name="contactId" value={contact.id} />
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label>{t.tasks.formContact}</label>
                <p style={{ margin: 0 }}>{contact.displayName || contact.phone || '—'}</p>
              </div>

              <div className="record-field">
                <label htmlFor="cd-title">{t.tasks.formTitle}</label>
                <input className="line-input" id="cd-title" name="title" required
                       placeholder={t.tasks.titlePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="cd-dueAt">{t.tasks.formDueAt}</label>
                <input className="line-input" id="cd-dueAt" name="dueAt" type="datetime-local" required />
              </div>

              <TaskKindField id="cd-kind" name="kind" value={kind} onChange={setKind} initialCustomKinds={taskKinds} />

              {kind === 'meeting' ? (
                <div className="record-field">
                  <label htmlFor="cd-meetingLink">{t.tasks.formMeetingLink}</label>
                  <input className="line-input" id="cd-meetingLink" name="meetingLink" type="url"
                         placeholder={t.tasks.meetingLinkPlaceholder} />
                </div>
              ) : null}

              <div className="record-field">
                <label htmlFor="cd-priority">{t.tasks.formPriority}</label>
                <select className="line-input" id="cd-priority" name="priority" defaultValue="medium">
                  {(['low', 'medium', 'high', 'urgent'] as const).map((p) => (
                    <option key={p} value={p}>{t.tasks.priorityLabel[p]}</option>
                  ))}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="cd-repeatUnit">{t.tasks.repeat}</label>
                <select className="line-input" id="cd-repeatUnit" name="repeatUnit" value={repeatUnit}
                        onChange={(e) => setRepeatUnit(e.target.value)}>
                  <option value="">{t.tasks.repeatNone}</option>
                  {(['day', 'week', 'month', 'year'] as const).map((u) => (
                    <option key={u} value={u}>{t.tasks.repeatUnitLabel[u]}</option>
                  ))}
                </select>
              </div>

              {repeatUnit ? (
                <>
                  <div className="record-field">
                    <label htmlFor="cd-repeatInterval">{t.tasks.repeatEvery}</label>
                    <input className="line-input" id="cd-repeatInterval" name="repeatInterval" type="number"
                           min={1} max={365} defaultValue={1} />
                  </div>
                  <div className="record-field">
                    <label htmlFor="cd-repeatUntil">{t.tasks.repeatUntil}</label>
                    <input className="line-input" id="cd-repeatUntil" name="repeatUntil" type="date" />
                    <p className="record-hint">{t.tasks.repeatUntilHint}</p>
                  </div>
                </>
              ) : null}

              <div className="record-field">
                <label htmlFor="cd-assigneeId">{t.tasks.formAssignee}</label>
                <select className="line-input" id="cd-assigneeId" name="assigneeId" defaultValue="">
                  <option value="">{t.tasks.unassigned}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="cd-dealId">{t.tasks.formDeal}</label>
                <select className="line-input" id="cd-dealId" name="dealId" defaultValue="">
                  <option value="">{t.tasks.noDeal}</option>
                  {deals.map((d) => (
                    <option key={d.id} value={d.id}>{d.title}{d.brand_name ? ` — ${d.brand_name}` : ''}</option>
                  ))}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="cd-notes">{t.tasks.formNotes}</label>
                <textarea className="line-input" id="cd-notes" name="notes" rows={3}
                          placeholder={t.tasks.notesPlaceholder} />
              </div>
            </div>
            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending}>
              {pending ? t.tasks.saving : t.tasks.save}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.client.discard}</button>
          </div>
        </form>
      </div>
    </>
  );
}
