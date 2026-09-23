import { t } from '@/lib/copy';

/**
 * The two badges a task carries when it exists both here and as a Google
 * Calendar event — "CRM" (this row: editable, has its own Detail/Tandai
 * Selesai/Hapus) and "Google Calendar" (the event sitting behind it).
 *
 * Two chips rather than one combined label: a single "Tersambung Google
 * Calendar" chip, sitting right next to the task's own action buttons, read
 * as if the row itself were sourced from Google — the same wording
 * `googleSource` already uses for a row that genuinely has no task behind
 * it at all (a pulled-in Google-only event). Separating them says which
 * half is which.
 *
 * `googleLink` makes the Google chip a link out to the event when one is
 * known (`task.calendarEventLink`) and a plain chip otherwise — a task
 * matched to its Google event by Meet link rather than by id (see
 * `TaskCalendar.tsx`'s `googleLinkedTaskIds`) has nothing to link to yet.
 *
 * Wrapped in one inline-flex span rather than returned as a bare pair: every
 * place this renders sits in a `flexWrap: 'wrap'` row alongside other chips
 * (status, priority, …), and a wrap point could otherwise land between the
 * two — confirmed live, "CRM" staying on the status/priority line while
 * "GOOGLE CALENDAR" dropped to a line by itself. One flex item wraps as one
 * unit; the pair now moves together or not at all.
 */
export function SyncBadges({ googleLink }: { googleLink?: string | null }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <span className="chip brand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
             strokeLinejoin="round" width="11" height="11" aria-hidden>
          <path d="M6 3h12a1 1 0 0 1 1 1v16l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
        </svg>
        {t.tasks.crmLabel}
      </span>
      {googleLink ? (
        <a href={googleLink} target="_blank" rel="noreferrer" className="chip good" title={t.tasks.viewInGoogleCalendar}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" width="11" height="11" aria-hidden>
            <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" />
          </svg>
          {t.tasks.googleSource}
        </a>
      ) : (
        <span className="chip good">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               strokeLinejoin="round" width="11" height="11" aria-hidden>
            <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" />
          </svg>
          {t.tasks.googleSource}
        </span>
      )}
    </span>
  );
}
