'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { createTaskInline, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import { TaskKindField } from '@/components/TaskKindField';
import type { Contact, Member, Deal, TaskKind } from '@/lib/api';

/**
 * The "Jadwal Meeting" button in the Client toolbar, next to "Tambah Client" —
 * same slide-in shell and `createTaskInline` (stay on the page, just close
 * and refresh) as the Tugas page's own quick-add `TaskDrawer`, but the picker
 * here is a Client (contact), not a Brand — this button lives on the Client
 * list, so that is the party it makes sense to pick from. The generic
 * "Tambah Tugas" entry point is gone from this page, so kind always starts
 * on `meeting` — this drawer's only job here now is scheduling a meeting
 * (the kind field stays editable for the rare exception).
 *
 * `presetContact` is how the per-row "Jadwal Meeting" action opens this same
 * drawer already aimed at one client: the picker is replaced with a fixed
 * name (same pattern as `BrandTaskDrawer`). Saving goes through the same
 * `createTaskInline`, so the result is a real task on Tugas/Kalender, not
 * the old dead `scheduleMeeting` text field on Contact.
 */
export function ClientQuickAddTaskDrawer({
  open, onClose, contacts, members, deals, taskKinds, presetContact = null,
}: {
  open: boolean;
  onClose: () => void;
  contacts: Contact[];
  members: Member[];
  deals: Deal[];
  taskKinds: TaskKind[];
  presetContact?: { id: string; name: string } | null;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(createTaskInline, null);
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState('meeting');
  const [repeatUnit, setRepeatUnit] = useState('');

  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      setKind('meeting');
      setRepeatUnit('');
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

  // Each open aims fresh — a leftover title/date from the last client this
  // drawer was opened for is worse than an empty form.
  useEffect(() => {
    if (!open) return;
    formRef.current?.reset();
    setKind('meeting');
    setRepeatUnit('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetContact?.id]);

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
            {!presetContact && contacts.length === 0 ? (
              <p className="empty" style={{ padding: '24px 0' }}>{t.client.noClients}</p>
            ) : (
              <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
                {presetContact ? (
                  <div className="record-field">
                    <label>{t.tasks.formContact}</label>
                    <p style={{ margin: 0 }}>{presetContact.name}</p>
                    <input type="hidden" name="contactId" value={presetContact.id} />
                  </div>
                ) : (
                  <div className="record-field">
                    <label htmlFor="qc-contactId">{t.tasks.formContact}</label>
                    <select className="line-input" id="qc-contactId" name="contactId" required defaultValue="">
                      <option value="" disabled>{t.tasks.chooseContact}</option>
                      {contacts.map((c) => (
                        <option key={c.id} value={c.id}>{c.displayName || c.phone || '—'}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="record-field">
                  <label htmlFor="qc-title">{t.tasks.formTitle}</label>
                  <input className="line-input" id="qc-title" name="title" required
                         placeholder={t.tasks.titlePlaceholder} />
                </div>

                <div className="record-field">
                  <label htmlFor="qc-dueAt">{t.tasks.formDueAt}</label>
                  <input className="line-input" id="qc-dueAt" name="dueAt" type="datetime-local" required />
                </div>

                <TaskKindField id="qc-kind" name="kind" value={kind} onChange={setKind} initialCustomKinds={taskKinds} />

                {kind === 'meeting' ? (
                  <div className="record-field">
                    <label htmlFor="qc-meetingLink">{t.tasks.formMeetingLink}</label>
                    <input className="line-input" id="qc-meetingLink" name="meetingLink" type="url"
                           placeholder={t.tasks.meetingLinkPlaceholder} />
                  </div>
                ) : null}

                <div className="record-field">
                  <label htmlFor="qc-priority">{t.tasks.formPriority}</label>
                  <select className="line-input" id="qc-priority" name="priority" defaultValue="medium">
                    {(['low', 'medium', 'high', 'urgent'] as const).map((p) => (
                      <option key={p} value={p}>{t.tasks.priorityLabel[p]}</option>
                    ))}
                  </select>
                </div>

                <div className="record-field">
                  <label htmlFor="qc-repeatUnit">{t.tasks.repeat}</label>
                  <select className="line-input" id="qc-repeatUnit" name="repeatUnit" value={repeatUnit}
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
                      <label htmlFor="qc-repeatInterval">{t.tasks.repeatEvery}</label>
                      <input className="line-input" id="qc-repeatInterval" name="repeatInterval" type="number"
                             min={1} max={365} defaultValue={1} />
                    </div>
                    <div className="record-field">
                      <label htmlFor="qc-repeatUntil">{t.tasks.repeatUntil}</label>
                      <input className="line-input" id="qc-repeatUntil" name="repeatUntil" type="date" />
                      <p className="record-hint">{t.tasks.repeatUntilHint}</p>
                    </div>
                  </>
                ) : null}

                <div className="record-field">
                  <label htmlFor="qc-assigneeId">{t.tasks.formAssignee}</label>
                  <select className="line-input" id="qc-assigneeId" name="assigneeId" defaultValue="">
                    <option value="">{t.tasks.unassigned}</option>
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>

                <div className="record-field">
                  <label htmlFor="qc-dealId">{t.tasks.formDeal}</label>
                  <select className="line-input" id="qc-dealId" name="dealId" defaultValue="">
                    <option value="">{t.tasks.noDeal}</option>
                    {deals.map((d) => (
                      <option key={d.id} value={d.id}>{d.title}{d.contact_name ? ` — ${d.contact_name}` : ''}</option>
                    ))}
                  </select>
                </div>

                <div className="record-field">
                  <label htmlFor="qc-notes">{t.tasks.formNotes}</label>
                  <textarea className="line-input" id="qc-notes" name="notes" rows={3}
                            placeholder={t.tasks.notesPlaceholder} />
                </div>
              </div>
            )}
            {state?.error ? <p className="error" style={{ marginTop: 14 }}>{state.error}</p> : null}
          </div>

          <div className="drawer-foot">
            <button type="submit" className="btn primary" disabled={pending || (!presetContact && contacts.length === 0)}>
              {pending ? t.tasks.saving : t.tasks.save}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>{t.client.discard}</button>
          </div>
        </form>
      </div>
    </>
  );
}
