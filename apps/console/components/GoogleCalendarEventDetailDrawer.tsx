'use client';

import { useEffect } from 'react';
import { t } from '@/lib/copy';
import { formatTaskDue } from '@/lib/taskHelpers';
import { SendCalendarEventEmailButton } from '@/components/SendCalendarEventEmailButton';
import type { GoogleCalendarEvent } from '@/lib/api';

function formatEventWhen(event: GoogleCalendarEvent): string {
  if (event.allDay) {
    return `${t.tasks.allDay} — ${new Date(event.start).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  }
  return formatTaskDue(event.start);
}

/**
 * Read-only, same as `TaskViewDrawer` but for a Google Calendar event pulled
 * into Tugas — there's no row in this database to edit, so unlike the task
 * drawer this one never grows a save form. No outer `<form>` to worry about
 * nesting inside, either, so `SendCalendarEventEmailButton` (its own dialog
 * with its own form) sits straight in the footer.
 */
export function GoogleCalendarEventDetailDrawer({
  event, onClose,
}: { event: GoogleCalendarEvent | null; onClose: () => void }) {
  const open = event !== null;

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
          <h2>{t.tasks.googleEventDetailTitle}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.tasks.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {event ? (
          <div className="drawer-body">
            <div className="record-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div className="record-field">
                <label>{t.tasks.formTitle}</label>
                <p style={{ margin: 0 }}>{event.title}</p>
              </div>

              <div className="record-field">
                <label>{t.tasks.formDueAt}</label>
                <p style={{ margin: 0 }}>{formatEventWhen(event)}</p>
              </div>

              <div className="record-field">
                <label>{t.tasks.source}</label>
                <p style={{ margin: 0 }}>
                  <span className="chip"><span className="google-dot" aria-hidden /> {t.tasks.googleSource}</span>
                </p>
              </div>

              {event.meetingLink ? (
                <div className="record-field">
                  <label>{t.tasks.formMeetingLink}</label>
                  <p style={{ margin: 0 }}>
                    <a href={event.meetingLink} target="_blank" rel="noreferrer">{event.meetingLink}</a>
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="drawer-foot">
          {event ? (
            <a href={event.htmlLink} target="_blank" rel="noreferrer" className="btn primary">
              {t.tasks.openInGoogle}
            </a>
          ) : null}
          {event?.meetingLink ? <SendCalendarEventEmailButton event={event} /> : null}
          <button type="button" className="btn ghost" onClick={onClose}>{t.tasks.close}</button>
        </div>
      </div>
    </>
  );
}
