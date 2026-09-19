'use client';

import { useActionState, useEffect, useState } from 'react';
import { updateTask, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { toDatetimeLocal } from '@/lib/format';
import { CsrfField } from '@/components/Csrf';
import { SendMeetingEmailButton } from '@/components/SendMeetingEmailButton';
import type { Task } from '@/lib/api';

/**
 * What the "Meeting" action opens once a client already has an open meeting
 * (see `ClientTable.openScheduleMeeting`) — same field set as
 * `ClientQuickAddTaskDrawer`'s create form (Client/Judul/Tanggal/Link Video
 * Conference/Catatan), not the full Tugas-page `TaskDetailDrawer` this used
 * to reuse, plus the one thing only an existing meeting has: the synced
 * Google Calendar event's own link. Kind/priority/repeat/assignee/deal stay
 * whatever they already were on the task — this view can't see them, so it
 * carries them along as hidden fields rather than risk `updateTask`
 * silently clearing them.
 */
export function ClientMeetingDetailDrawer({
  task: incoming, open, onClose,
}: {
  task: Task | null;
  open: boolean;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(updateTask, null);
  // Same reasoning as `TaskDetailDrawer`: keep rendering the last task while
  // `open` drives the CSS transition, instead of vanishing the instant the
  // caller clears it to null.
  const [task, setTask] = useState<Task | null>(incoming);

  useEffect(() => {
    if (incoming) setTask(incoming);
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
           aria-label={t.client.meetingDetailTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2>{t.client.meetingDetailTitle}</h2>
            {/* Outside the edit form below on purpose — its own dialog holds
                its own <form>, and a form cannot nest inside another form. */}
            <SendMeetingEmailButton taskId={task.id} />
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
          <input type="hidden" name="kind" value="meeting" />
          <input type="hidden" name="priority" value={task.priority} />
          <input type="hidden" name="dealId" value={task.dealId ?? ''} />
          <input type="hidden" name="assigneeId" value={task.assigneeId ?? ''} />
          <input type="hidden" name="repeatUnit" value={task.repeatUnit ?? ''} />
          <input type="hidden" name="repeatInterval" value={task.repeatInterval} />
          <input type="hidden" name="repeatUntil" value={task.repeatUntil ?? ''} />
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label>{t.tasks.formContact}</label>
                <p style={{ margin: 0 }}>{task.contactName ?? task.brandName ?? '—'}</p>
              </div>

              <div className="record-field">
                <label htmlFor="cm-title">{t.tasks.formTitle}</label>
                <input className="line-input" id="cm-title" name="title" required
                       defaultValue={task.title} placeholder={t.tasks.titlePlaceholder} />
              </div>

              <div className="record-field">
                <label htmlFor="cm-dueAt">{t.client.scheduleMeetingDateLabel}</label>
                <input className="line-input" id="cm-dueAt" name="dueAt" type="datetime-local" required
                       defaultValue={toDatetimeLocal(task.dueAt)} />
              </div>

              <div className="record-field">
                <label htmlFor="cm-meetingLink">{t.tasks.formMeetingLink}</label>
                <input className="line-input" id="cm-meetingLink" name="meetingLink" type="url"
                       defaultValue={task.meetingLink ?? ''} placeholder={t.tasks.meetingLinkPlaceholder} />
              </div>

              <div className="record-field">
                <label>{t.client.meetingCalendarLinkLabel}</label>
                {task.calendarEventLink ? (
                  <p style={{ margin: 0 }}>
                    <a href={task.calendarEventLink} target="_blank" rel="noreferrer">
                      {t.tasks.viewInGoogleCalendar}
                    </a>
                  </p>
                ) : (
                  <p className="dim" style={{ margin: 0 }}>{t.client.meetingCalendarLinkNotSynced}</p>
                )}
              </div>

              <div className="record-field">
                <label htmlFor="cm-notes">{t.tasks.formNotes}</label>
                <textarea className="line-input" id="cm-notes" name="notes" rows={3}
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
