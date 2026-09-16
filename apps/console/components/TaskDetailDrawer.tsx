'use client';

import { useActionState, useEffect, useState } from 'react';
import { updateTask, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { toDatetimeLocal } from '@/lib/format';
import { CsrfField } from '@/components/Csrf';
import { TaskKindField } from '@/components/TaskKindField';
import { SendMeetingEmailButton } from '@/components/SendMeetingEmailButton';
import { taskPartyName } from '@/lib/taskHelpers';
import type { Task, Member, Deal, TaskKind } from '@/lib/api';

/**
 * Opens on the task's name in the table — same slide-in shell as `TaskDrawer`,
 * but pre-filled and saving through `updateTask` instead of creating a new
 * row. The contact a task is about doesn't move here; that's a bigger change
 * than this view offers.
 */
export function TaskDetailDrawer({
  task: incoming, open, onClose, members, deals, taskKinds,
}: {
  task: Task | null;
  open: boolean;
  onClose: () => void;
  members: Member[];
  deals: Deal[];
  taskKinds: TaskKind[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(updateTask, null);
  const [kind, setKind] = useState(incoming?.kind ?? 'follow_up');
  const [repeatUnit, setRepeatUnit] = useState(incoming?.repeatUnit ?? '');
  // The caller clears `task` to null the moment it closes the drawer, so the
  // panel would otherwise vanish instantly instead of sliding out — this
  // keeps rendering the last task while `open` drives the CSS transition.
  const [task, setTask] = useState<Task | null>(incoming);

  useEffect(() => {
    if (incoming) { setTask(incoming); setKind(incoming.kind); setRepeatUnit(incoming.repeatUnit ?? ''); }
  }, [incoming]);

  useEffect(() => {
    if (state?.ok) onClose();
    // Only react to a fresh successful submit, not to `onClose` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!task) return null;

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={t.tasks.detailTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2>{t.tasks.detailTitle}</h2>
            {/* Outside the edit form below on purpose — its own dialog holds
                its own <form>, and a form cannot nest inside another form. */}
            {kind === 'meeting' ? <SendMeetingEmailButton taskId={task.id} /> : null}
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.tasks.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <form key={task.id} action={formAction} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <CsrfField />
          <input type="hidden" name="taskId" value={task.id} />
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label>{task.brandId ? t.tasks.formBrand : t.tasks.formContact}</label>
                <p style={{ margin: 0 }}>{taskPartyName(task) ?? '—'}</p>
              </div>

              <div className="record-field">
                <label htmlFor="e-title">{t.tasks.formTitle}</label>
                <input className="line-input" id="e-title" name="title" required
                       defaultValue={task.title} placeholder={t.tasks.titlePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="e-dueAt">{t.tasks.formDueAt}</label>
                <input className="line-input" id="e-dueAt" name="dueAt" type="datetime-local" required
                       defaultValue={toDatetimeLocal(task.dueAt)} />
              </div>

              <TaskKindField id="e-kind" name="kind" value={kind} onChange={setKind} initialCustomKinds={taskKinds} />

              <div className="record-field">
                <label htmlFor="e-priority">{t.tasks.formPriority}</label>
                <select className="line-input" id="e-priority" name="priority" defaultValue={task.priority}>
                  {(['low', 'medium', 'high', 'urgent'] as const).map((p) => (
                    <option key={p} value={p}>{t.tasks.priorityLabel[p]}</option>
                  ))}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="e-repeatUnit">{t.tasks.repeat}</label>
                <select className="line-input" id="e-repeatUnit" name="repeatUnit" value={repeatUnit}
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
                    <label htmlFor="e-repeatInterval">{t.tasks.repeatEvery}</label>
                    <input className="line-input" id="e-repeatInterval" name="repeatInterval" type="number"
                           min={1} max={365} defaultValue={task.repeatInterval} />
                  </div>
                  <div className="record-field">
                    <label htmlFor="e-repeatUntil">{t.tasks.repeatUntil}</label>
                    <input className="line-input" id="e-repeatUntil" name="repeatUntil" type="date"
                           defaultValue={task.repeatUntil ? task.repeatUntil.slice(0, 10) : ''} />
                    <p className="record-hint">{t.tasks.repeatUntilHint}</p>
                  </div>
                </>
              ) : null}

              {kind === 'meeting' ? (
                <div className="record-field">
                  <label htmlFor="e-meetingLink">{t.tasks.formMeetingLink}</label>
                  <input className="line-input" id="e-meetingLink" name="meetingLink" type="url"
                         defaultValue={task.meetingLink ?? ''} placeholder={t.tasks.meetingLinkPlaceholder} />
                </div>
              ) : null}

              <div className="record-field">
                <label htmlFor="e-assigneeId">{t.tasks.formAssignee}</label>
                <select className="line-input" id="e-assigneeId" name="assigneeId" defaultValue={task.assigneeId ?? ''}>
                  <option value="">{t.tasks.unassigned}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="e-dealId">{t.tasks.formDeal}</label>
                <select className="line-input" id="e-dealId" name="dealId" defaultValue={task.dealId ?? ''}>
                  <option value="">{t.tasks.noDeal}</option>
                  {deals.map((d) => (
                    <option key={d.id} value={d.id}>{d.title}{d.contact_name ? ` — ${d.contact_name}` : ''}</option>
                  ))}
                </select>
              </div>

              <div className="record-field">
                <label htmlFor="e-notes">{t.tasks.formNotes}</label>
                <textarea className="line-input" id="e-notes" name="notes" rows={3}
                          defaultValue={task.notes ?? ''} placeholder={t.tasks.notesPlaceholder} />
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
