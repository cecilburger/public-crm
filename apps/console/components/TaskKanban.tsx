'use client';

import Link from 'next/link';
import { t } from '@/lib/copy';
import { formatTaskDue, isTaskOverdue, isTaskDueToday } from '@/lib/taskHelpers';
import { markTaskDone } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { CancelTaskButton } from '@/components/CancelTaskButton';
import { KindIcon } from '@/components/KindIcon';
import type { Task, Member, GoogleCalendarEvent } from '@/lib/api';

const COLUMNS: { key: Task['status']; label: string }[] = [
  { key: 'open', label: t.tasks.filterDue },
  { key: 'done', label: t.tasks.filterDone },
  { key: 'cancelled', label: t.tasks.filterCancelled },
];

const PRIORITY_CHIP: Record<Task['priority'], string> = {
  low: 'chip', medium: 'chip brand', high: 'chip warn', urgent: 'chip danger',
};

/** One column per status — the same shape as the Deal board, so a
 *  follow-up reads the same way a deal does: cards you move by finishing
 *  or dropping them, not by dragging. Google Calendar gets its own column
 *  rather than being folded into "Berjalan" — an event has no open/done/
 *  cancelled state of its own to sit under. */
export function TaskKanban({
  tasks, members, googleEvents, showGoogleColumn,
}: { tasks: Task[]; members: Member[]; googleEvents: GoogleCalendarEvent[]; showGoogleColumn: boolean }) {
  const names = new Map(members.map((m) => [m.id, m.name]));

  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const cards = tasks.filter((tk) => tk.status === col.key);
        return (
          <section key={col.key} className={`column ${col.key === 'done' ? 'won' : ''} ${col.key === 'cancelled' ? 'lost' : ''}`}>
            <header>
              <h2>{col.label}</h2>
              <span className="n tnum">{cards.length}</span>
            </header>
            <div className="cards">
              {cards.length === 0 ? (
                <p className="dim" style={{ fontSize: 12, padding: '6px 2px' }}>{t.sales.empty}</p>
              ) : cards.map((tk) => (
                <article key={tk.id} className="deal">
                  <KindIcon kind={tk.kind} title={t.tasks.kindLabel[tk.kind] ?? tk.kind} />
                  <div className="title">{tk.title}</div>
                  <Link href={`/pelanggan/${tk.contactId}`} className="mono dim" style={{ fontSize: 11 }}>
                    {tk.contactName ?? tk.contactPhone ?? '—'}
                  </Link>
                  <div style={{ fontSize: 11.5, marginTop: 6 }}>{formatTaskDue(tk.dueAt)}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    {isTaskOverdue(tk) ? <span className="chip danger">{t.tasks.overdue}</span> : null}
                    {!isTaskOverdue(tk) && isTaskDueToday(tk) ? <span className="chip warn">{t.tasks.dueToday}</span> : null}
                    <span className={PRIORITY_CHIP[tk.priority]}>{t.tasks.priorityLabel[tk.priority] ?? tk.priority}</span>
                    <span className="chip">{tk.assigneeId ? names.get(tk.assigneeId) ?? '—' : t.tasks.unassigned}</span>
                  </div>
                  {tk.status === 'open' ? (
                    <div className="foot">
                      <form action={markTaskDone}>
                        <CsrfField />
                        <input type="hidden" name="taskId" value={tk.id} />
                        <button className="btn ghost sm" type="submit">{t.tasks.markDone}</button>
                      </form>
                      <CancelTaskButton task={tk} />
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        );
      })}

      {showGoogleColumn ? (
        <section className="column">
          <header>
            <h2><span className="google-dot" aria-hidden /> {t.tasks.googleColumn}</h2>
            <span className="n tnum">{googleEvents.length}</span>
          </header>
          <div className="cards">
            {googleEvents.length === 0 ? (
              <p className="dim" style={{ fontSize: 12, padding: '6px 2px' }}>{t.tasks.googleUpcomingEmpty}</p>
            ) : googleEvents.map((ev) => (
              <article key={ev.id} className="deal">
                {ev.meetingLink ? <KindIcon kind="meeting" title={t.tasks.kindLabel.meeting} /> : null}
                <a href={ev.htmlLink} target="_blank" rel="noreferrer" className="title" style={{ display: 'block' }}>
                  {ev.title}
                </a>
                <div className="mono dim" style={{ fontSize: 11, marginTop: 6 }}>
                  {new Date(ev.start).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}
                  {ev.allDay ? '' : ` · ${new Date(ev.start).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`}
                </div>
                {ev.meetingLink ? (
                  <a href={ev.meetingLink} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, marginTop: 6, display: 'inline-block' }}>
                    {t.tasks.joinMeeting}
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
