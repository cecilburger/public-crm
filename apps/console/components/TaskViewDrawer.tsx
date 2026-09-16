'use client';

import { useEffect } from 'react';
import { t } from '@/lib/copy';
import { formatTaskDue, taskPartyName } from '@/lib/taskHelpers';
import type { Task, Member } from '@/lib/api';

/**
 * Read-only preview of a task, opened from its indicator icon on a deal's
 * kanban card — same drawer chrome as the editable Tugas views, but nothing
 * here is editable. The full edit form still lives on the Tugas page.
 */
export function TaskViewDrawer({
  task, onClose, members,
}: { task: Task | null; onClose: () => void; members: Member[] }) {
  const open = task !== null;
  const assigneeName = task?.assigneeId ? members.find((m) => m.id === task.assigneeId)?.name ?? null : null;

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
           aria-label={t.tasks.detailTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.tasks.detailTitle}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.tasks.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {task ? (
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label>{task.brandId ? t.tasks.formBrand : t.tasks.formContact}</label>
                <p style={{ margin: 0 }}>{taskPartyName(task) ?? '—'}</p>
              </div>

              <div className="record-field">
                <label>{t.tasks.formTitle}</label>
                <p style={{ margin: 0 }}>{task.title}</p>
              </div>

              <div className="record-field">
                <label>{t.tasks.formDueAt}</label>
                <p style={{ margin: 0 }}>{formatTaskDue(task.dueAt)}</p>
              </div>

              <div className="record-field">
                <label>{t.tasks.kind}</label>
                <p style={{ margin: 0 }}>{t.tasks.kindLabel[task.kind] ?? task.kind}</p>
              </div>

              {task.meetingLink ? (
                <div className="record-field">
                  <label>{t.tasks.formMeetingLink}</label>
                  <p style={{ margin: 0 }}>
                    <a href={task.meetingLink} target="_blank" rel="noreferrer">{task.meetingLink}</a>
                  </p>
                </div>
              ) : null}

              <div className="record-field">
                <label>{t.tasks.priority}</label>
                <p style={{ margin: 0 }}>{t.tasks.priorityLabel[task.priority]}</p>
              </div>

              <div className="record-field">
                <label>{t.tasks.assignee}</label>
                <p style={{ margin: 0 }}>{assigneeName ?? t.tasks.unassigned}</p>
              </div>

              {task.notes ? (
                <div className="record-field">
                  <label>{t.tasks.formNotes}</label>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{task.notes}</p>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="drawer-foot">
          <button type="button" className="btn ghost" onClick={onClose}>{t.tasks.close}</button>
        </div>
      </div>
    </>
  );
}
