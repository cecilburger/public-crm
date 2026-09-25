'use client';

import Link from '@/components/FastLink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/lib/copy';
import { formatTaskDue, isTaskOverdue, taskPartyName, taskPartyHref } from '@/lib/taskHelpers';
import { clock, initials } from '@/lib/format';
import {
  addDays, addMonths, monthGrid, sameDay, shiftAnchor, startOfMonth, startOfWeek, weekDays,
} from '@/lib/calendarHelpers';
import type { CalendarMode } from '@/lib/calendarHelpers';
import type { Task, GoogleCalendarEvent, GoogleCalendarStatus } from '@/lib/api';
import { markTaskDone } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { CancelTaskButton } from '@/components/CancelTaskButton';
import { SyncBadges } from '@/components/SyncBadges';
import { formatEventWhen } from '@/components/GoogleCalendarEventDetailDrawer';
import { withBase } from '@/lib/basePath';

const ROW_H = 42;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DOW_SHORT = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const MINI_DOW = ['Sn', 'Sl', 'Rb', 'Km', 'Jm', 'Sb', 'Mg'];
const STATUSES: Task['status'][] = ['open', 'done', 'cancelled'];
const STATUS_CHIP: Record<Task['status'], string> = {
  open: 'chip brand', done: 'chip good', cancelled: 'chip danger',
};
const PRIORITY_CHIP: Record<Task['priority'], string> = {
  low: 'chip', medium: 'chip brand', high: 'chip warn', urgent: 'chip danger',
};

function pillClass(tk: Task): string {
  if (tk.status === 'cancelled') return 'cancelled';
  if (tk.status === 'done') return 'done';
  if (isTaskOverdue(tk)) return 'overdue';
  return '';
}

function groupByDay(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const tk of tasks) {
    const key = new Date(tk.dueAt).toDateString();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(tk);
  }
  return map;
}

function groupGoogleByDay(events: GoogleCalendarEvent[]): Map<string, GoogleCalendarEvent[]> {
  const map = new Map<string, GoogleCalendarEvent[]>();
  for (const ev of events) {
    const key = new Date(ev.start).toDateString();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ev);
  }
  return map;
}

/**
 * The same grouping the hour grids use for tasks.
 *
 * Day and Week place things in an hour row, so a by-day map cannot reach
 * them — which is exactly why Google events were fetched on those views and
 * then silently dropped: only Month ever received them. All-day events have
 * no hour to sit in and stay out of the hour grids rather than being pinned
 * to an arbitrary 00:00.
 */
function groupGoogleByDayHour(events: GoogleCalendarEvent[]): Map<string, GoogleCalendarEvent[]> {
  const map = new Map<string, GoogleCalendarEvent[]>();
  for (const ev of events) {
    if (ev.allDay) continue;
    const at = new Date(ev.start);
    const key = `${at.toDateString()}#${at.getHours()}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ev);
  }
  return map;
}

/** One Google event in an hour grid. A link out, not a button: these are
 *  read-only here — the integration never writes back to Google. */
function GooglePill({ event }: { event: GoogleCalendarEvent }) {
  return (
    <a href={event.htmlLink} target="_blank" rel="noreferrer"
       className="time-event google"
       title={event.title} onClick={(e) => e.stopPropagation()}>
      {event.title}
    </a>
  );
}

/** The visible window worth asking Google for, per calendar mode — the month
 *  grid always shows a few days of the neighbouring months too, so its range
 *  is the grid's own first/last cell, not just the 1st–30th. */
function periodRange(mode: CalendarMode, anchor: Date): { from: Date; to: Date } {
  if (mode === 'day') {
    const from = new Date(anchor);
    from.setHours(0, 0, 0, 0);
    return { from, to: addDays(from, 1) };
  }
  if (mode === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7) };
  }
  if (mode === 'year') {
    return { from: new Date(anchor.getFullYear(), 0, 1), to: new Date(anchor.getFullYear() + 1, 0, 1) };
  }
  const grid = monthGrid(startOfMonth(anchor));
  return { from: grid[0]!, to: addDays(grid[grid.length - 1]!, 1) };
}

function groupByDayHour(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const tk of tasks) {
    const d = new Date(tk.dueAt);
    const key = `${d.toDateString()}#${d.getHours()}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(tk);
  }
  return map;
}

function periodLabel(mode: CalendarMode, anchor: Date): string {
  if (mode === 'day') {
    return anchor.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  if (mode === 'week') {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    const startLabel = start.toLocaleDateString('id-ID', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
    const endLabel = end.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    return `${startLabel} – ${endLabel}`;
  }
  if (mode === 'year') return String(anchor.getFullYear());
  return anchor.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
}

/** The "Agenda Hari Ini" card's own time row. Just the clock face — no
 *  minute/hour hands positioned to a real time, this is a label glyph, not a
 *  clock reading itself. */
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
         strokeLinejoin="round" width="12" height="12" aria-hidden style={{ flex: 'none' }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** `synced` means a Google Calendar event was matched to this task and its own
 *  pill suppressed — see `googleLinkedTaskIds`. The dot is what says so. */
function EventPill({ task, compact, synced }: { task: Task; compact?: boolean; synced?: boolean }) {
  const party = taskPartyName(task);
  const label = compact ? task.title : `${task.title}${party ? ` · ${party}` : ''}`;
  return (
    <span className={`time-event ${pillClass(task)}`}
          title={`${task.title}${party ? ` — ${party}` : ''}${synced ? ` (${t.tasks.crmAndGoogle})` : ''}`}>
      {synced ? <span className="google-dot" aria-hidden /> : null}
      {label}
    </span>
  );
}

function MiniMonth({
  month, selected, today, dayStatus, onPick, onPrev, onNext, onHeaderClick, compact,
}: {
  month: Date; selected: Date | null; today: Date;
  /** Which days carry something, and what colour that earns the date number
   *  — 'open'/'done'/'cancelled' from a task's own status (priority: any
   *  open task wins, so a day that still needs something doesn't read as
   *  finished because something else on it is done), 'google' for a day
   *  whose only occupant is a bare Calendar event with no task behind it. */
  dayStatus: Map<string, 'open' | 'done' | 'cancelled' | 'google'>;
  onPick: (d: Date) => void; onPrev?: () => void; onNext?: () => void;
  onHeaderClick?: () => void; compact?: boolean;
}) {
  const grid = useMemo(() => monthGrid(month), [month]);
  const label = month.toLocaleDateString('id-ID', compact ? { month: 'short' } : { month: 'long', year: 'numeric' });
  return (
    <div className={`mini-cal ${compact ? 'compact' : ''}`}>
      <div className="mini-cal-head">
        {onHeaderClick ? (
          <button type="button" className="mini-cal-title-btn" onClick={onHeaderClick}><b>{label}</b></button>
        ) : <b>{label}</b>}
        {(onPrev || onNext) ? (
          <div className="mini-cal-nav">
            <button type="button" className="btn ghost sm" onClick={onPrev} aria-label={t.tasks.prevMonth}>‹</button>
            <button type="button" className="btn ghost sm" onClick={onNext} aria-label={t.tasks.nextMonth}>›</button>
          </div>
        ) : null}
      </div>
      <div className="mini-cal-grid">
        {MINI_DOW.map((d) => <span key={d} className="mini-cal-dow">{d}</span>)}
        {grid.map((d) => {
          const inMonth = d.getMonth() === month.getMonth();
          const status = dayStatus.get(d.toDateString());
          const isToday = sameDay(d, today);
          const isSelected = selected ? sameDay(d, selected) : false;
          return (
            <button type="button" key={d.toISOString()}
                    className={`mini-cal-day ${inMonth ? '' : 'outside'} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${status ? `has-events status-${status}` : ''}`}
                    onClick={() => onPick(d)}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DayGrid({ anchor, eventsByDayHour, googleByDayHour, today, googleLinkedTaskIds }: {
  anchor: Date; eventsByDayHour: Map<string, Task[]>;
  googleByDayHour: Map<string, GoogleCalendarEvent[]>; today: Date;
  googleLinkedTaskIds: Set<string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: ROW_H * 6 }); }, [anchor]);
  const isToday = sameDay(anchor, today);
  const nowHour = today.getHours();
  return (
    <div className="time-grid">
      <div className="time-scroll" ref={scrollRef}>
        {HOURS.map((h) => {
          const items = eventsByDayHour.get(`${anchor.toDateString()}#${h}`) ?? [];
          const googleItems = googleByDayHour.get(`${anchor.toDateString()}#${h}`) ?? [];
          return (
            <div key={h} className={`time-row ${isToday && h === nowHour ? 'current-hour' : ''}`}>
              <div className="time-row-label">{String(h).padStart(2, '0')}:00</div>
              <div className="time-row-slot">
                {items.map((tk) => (
                  <EventPill key={tk.id} task={tk} synced={googleLinkedTaskIds.has(tk.id)} />
                ))}
                {googleItems.map((ev) => <GooglePill key={ev.id} event={ev} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekGrid({ anchor, eventsByDayHour, googleByDayHour, today, googleLinkedTaskIds }: {
  anchor: Date; eventsByDayHour: Map<string, Task[]>;
  googleByDayHour: Map<string, GoogleCalendarEvent[]>; today: Date;
  googleLinkedTaskIds: Set<string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => weekDays(startOfWeek(anchor)), [anchor]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: ROW_H * 6 }); }, [anchor]);
  const nowHour = today.getHours();
  return (
    <div className="time-grid">
      <div className="time-week-head">
        <div />
        {days.map((d) => (
          <div key={d.toISOString()} className={`time-daycol-head ${sameDay(d, today) ? 'today' : ''}`}>
            {DOW_SHORT[(d.getDay() + 6) % 7]} <b>{d.getDate()}</b>
          </div>
        ))}
      </div>
      <div className="time-scroll" ref={scrollRef}>
        {HOURS.map((h) => (
          <div key={h} className={`time-row-week ${h === nowHour ? 'current-hour' : ''}`}>
            <div className="time-row-label">{String(h).padStart(2, '0')}:00</div>
            {days.map((d) => {
              const items = eventsByDayHour.get(`${d.toDateString()}#${h}`) ?? [];
              const googleItems = googleByDayHour.get(`${d.toDateString()}#${h}`) ?? [];
              return (
                <div key={d.toISOString()} className={`time-row-slot ${sameDay(d, today) ? 'today' : ''}`}>
                  {items.map((tk) => (
                    <EventPill key={tk.id} task={tk} compact synced={googleLinkedTaskIds.has(tk.id)} />
                  ))}
                  {googleItems.map((ev) => <GooglePill key={ev.id} event={ev} />)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Clicking the cell itself (its empty area or date number) opens the day's
 * full list; clicking one task's own pill instead opens just that task's
 * detail — a nested `<button>` inside the day's own clickable area would be
 * invalid HTML, so the cell is a `div` acting as a button and the pills are
 * the real (stopPropagation'd) buttons inside it.
 */
function MonthGrid({
  anchor, eventsByDay, googleEventsByDay, today, onSelectDay, onSelectTask, googleLinkedTaskIds,
}: {
  anchor: Date; eventsByDay: Map<string, Task[]>; googleEventsByDay: Map<string, GoogleCalendarEvent[]>; today: Date;
  onSelectDay: (d: Date) => void; onSelectTask: (task: Task) => void;
  googleLinkedTaskIds: Set<string>;
}) {
  const month = startOfMonth(anchor);
  const days = useMemo(() => monthGrid(month), [month]);
  return (
    <div className="calendar-grid">
      {MINI_DOW.map((d, i) => <div key={d} className="calendar-dow">{DOW_SHORT[i]}</div>)}
      {days.map((d) => {
        const inMonth = d.getMonth() === month.getMonth();
        const items = eventsByDay.get(d.toDateString()) ?? [];
        const visible = items.slice(0, 3);
        const extra = items.length - visible.length;
        const googleItems = googleEventsByDay.get(d.toDateString()) ?? [];
        const googleVisible = googleItems.slice(0, 2);
        const googleExtra = googleItems.length - googleVisible.length;
        return (
          <div key={d.toISOString()} role="button" tabIndex={0} onClick={() => onSelectDay(d)}
               onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectDay(d); } }}
               className={`calendar-day ${inMonth ? '' : 'outside'} ${sameDay(d, today) ? 'today' : ''}`}>
            <span className="calendar-daynum">{d.getDate()}</span>
            {visible.map((tk) => {
              const synced = googleLinkedTaskIds.has(tk.id);
              return (
                <button type="button" key={tk.id} className={`calendar-pill ${pillClass(tk)}`}
                        title={`${tk.title}${taskPartyName(tk) ? ` — ${taskPartyName(tk)}` : ''}${synced ? ` (${t.tasks.crmAndGoogle})` : ''}`}
                        onClick={(e) => { e.stopPropagation(); onSelectTask(tk); }}>
                  {synced ? <span className="google-dot" aria-hidden /> : null}
                  {tk.title}
                </button>
              );
            })}
            {extra > 0 ? <span className="calendar-more">{t.tasks.moreCount(extra)}</span> : null}
            {googleVisible.map((ev) => (
              <a key={ev.id} href={ev.htmlLink} target="_blank" rel="noreferrer" className="calendar-pill google"
                 title={ev.title} onClick={(e) => e.stopPropagation()}>
                {ev.title}
              </a>
            ))}
            {googleExtra > 0 ? <span className="calendar-more">{t.tasks.moreCount(googleExtra)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Full detail for one day's tasks — the month grid only has room for a
 *  couple of truncated pills, so clicking a date opens this instead. */
function DayDetailModal({
  date, tasks, googleEvents, onClose, onOpenTaskDetail, googleLinkedTaskIds,
}: {
  date: Date | null; tasks: Task[]; googleEvents: GoogleCalendarEvent[]; onClose: () => void;
  onOpenTaskDetail: (task: Task) => void; googleLinkedTaskIds: Set<string>;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (date) ref.current?.showModal();
    else ref.current?.close();
  }, [date]);

  const label = date
    ? date.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  return (
    <dialog ref={ref} className="modal wide" onClose={onClose}>
      <header className="modal-head">
        <h2 style={{ textTransform: 'capitalize' }}>{label}</h2>
        <button type="button" className="btn ghost sm" onClick={onClose}>{t.tasks.close}</button>
      </header>
      <div className="modal-body">
        {tasks.length === 0 && googleEvents.length === 0 ? (
          <p className="empty" style={{ padding: '12px 0' }}>{t.tasks.calendarEmpty}</p>
        ) : (
          <div className="day-detail-list">
            {tasks.map((tk) => (
              <div key={tk.id} className="day-detail-row">
                <div style={{ minWidth: 0 }}>
                  <b>{tk.title}</b>
                  {tk.dealTitle ? <div className="mono dim" style={{ fontSize: 11 }}>{tk.dealTitle}</div> : null}
                  <div style={{ fontSize: 12, marginTop: 3 }}>{formatTaskDue(tk.dueAt)}</div>
                  {taskPartyHref(tk) ? (
                    <Link href={taskPartyHref(tk)!} className="mono dim" style={{ fontSize: 11.5 }}>
                      {taskPartyName(tk) ?? '—'}
                    </Link>
                  ) : (
                    <span className="mono dim" style={{ fontSize: 11.5 }}>{taskPartyName(tk) ?? '—'}</span>
                  )}
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    <span className={STATUS_CHIP[tk.status]}>{t.tasks.statusLabel[tk.status] ?? tk.status}</span>
                    {isTaskOverdue(tk) ? <span className="chip danger">{t.tasks.overdue}</span> : null}
                    <span className={PRIORITY_CHIP[tk.priority]}>{t.tasks.priorityLabel[tk.priority] ?? tk.priority}</span>
                    {/* Same reasoning as the pill's own dot: the day list only
                        ever shows the task's own row for a synced meeting, so
                        this is what says a Google event sits behind it too. */}
                    {googleLinkedTaskIds.has(tk.id) ? <SyncBadges googleLink={tk.calendarEventLink} /> : null}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                  <button type="button" className="btn ghost sm" onClick={() => onOpenTaskDetail(tk)}>
                    {t.tasks.detail}
                  </button>
                  {tk.status === 'open' ? (
                    <>
                      <form action={markTaskDone}>
                        <CsrfField />
                        <input type="hidden" name="taskId" value={tk.id} />
                        <button className="btn ghost sm" type="submit">{t.tasks.markDone}</button>
                      </form>
                      <CancelTaskButton task={tk} />
                    </>
                  ) : null}
                </div>
              </div>
            ))}
            {/* Genuinely Google-only — nothing in this database, so no
                Detail/Tandai Selesai/Hapus and no status/priority chips to
                show. Confirmed live: a day holding one of these alongside
                real tasks showed only the tasks here, while its own pill sat
                right there in the month cell behind this modal — this list
                was reading `tasks` alone and had no idea the event existed. */}
            {googleEvents.map((ev) => (
              <div key={ev.id} className="day-detail-row">
                <div style={{ minWidth: 0 }}>
                  <b>{ev.title}</b>
                  <div style={{ fontSize: 12, marginTop: 3 }}>{formatEventWhen(ev)}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    <span className="chip good">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                           strokeLinejoin="round" width="11" height="11" aria-hidden>
                        <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" />
                      </svg>
                      {t.tasks.googleSource}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                  <a href={ev.htmlLink} target="_blank" rel="noreferrer" className="btn ghost sm">
                    {t.tasks.openInGoogle}
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}

/** The "Bulan" period rendered as a flat list instead of a grid — the
 *  "Agenda" half of the Grid Bulan/Agenda toggle. Every task and Google event
 *  in the anchored month, day by day in order, using the same card design as
 *  the sidebar's own "Agenda Hari Ini" (that one just never spans more than a
 *  single day). Days with nothing in them are skipped outright: a wall of
 *  empty dates is exactly what an agenda view exists to avoid. */
function MonthAgenda({
  anchor, byDay, googleByDay, onOpenTaskDetail,
}: {
  anchor: Date; byDay: Map<string, Task[]>; googleByDay: Map<string, GoogleCalendarEvent[]>;
  onOpenTaskDetail: (task: Task) => void;
}) {
  const days = useMemo(() => {
    const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    return Array.from({ length: daysInMonth }, (_, i) => new Date(anchor.getFullYear(), anchor.getMonth(), i + 1))
      .filter((d) => (byDay.get(d.toDateString())?.length ?? 0) > 0 || (googleByDay.get(d.toDateString())?.length ?? 0) > 0);
  }, [anchor, byDay, googleByDay]);

  if (days.length === 0) return <p className="empty calendar-empty-msg">{t.tasks.monthAgendaEmpty}</p>;

  return (
    <div className="month-agenda">
      {days.map((d) => (
        <div key={d.toDateString()} className="month-agenda-day">
          <h4 className="month-agenda-daylabel">
            {d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' })}
          </h4>
          <div className="month-agenda-items">
            {(byDay.get(d.toDateString()) ?? []).map((tk) => {
              const party = taskPartyName(tk);
              return (
                <button type="button" key={tk.id} onClick={() => onOpenTaskDetail(tk)}
                        className={`agenda-item ${pillClass(tk)}`}
                        style={{ width: '100%', textAlign: 'left', background: 'none', cursor: 'pointer' }}>
                  <div className="agenda-item-head">
                    <span className="agenda-item-title">{tk.title}</span>
                    {tk.status !== 'open' ? (
                      <span className="agenda-badge"
                            style={tk.status === 'done'
                              ? { color: 'var(--good)', background: 'var(--good-soft)' }
                              : { color: 'var(--danger)', background: 'var(--danger-soft)' }}>
                        {t.tasks.statusLabel[tk.status] ?? tk.status}
                      </span>
                    ) : null}
                  </div>
                  <span className="agenda-item-time"><ClockIcon /> {clock(tk.dueAt)} WIB</span>
                  <div className="agenda-item-foot">
                    {tk.meetingLink ? (
                      <span className="agenda-meet-pill">{t.tasks.googleMeetBadge}</span>
                    ) : party ? (
                      <span className="avatar agenda-item-avatar" title={party}>{initials(party)}</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
            {(googleByDay.get(d.toDateString()) ?? []).map((ev) => (
              <a key={ev.id} href={ev.htmlLink} target="_blank" rel="noreferrer" className="agenda-item">
                <div className="agenda-item-head">
                  <span className="agenda-item-title">{ev.title}</span>
                </div>
                <span className="agenda-item-time">
                  <ClockIcon /> {ev.allDay ? t.tasks.allDay : `${clock(ev.start)} WIB`}
                </span>
                {ev.meetingLink ? (
                  <div className="agenda-item-foot"><span className="agenda-meet-pill">{t.tasks.googleMeetBadge}</span></div>
                ) : null}
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function YearGrid({
  anchor, dayStatus, today, onPickDay, onPickMonth,
}: {
  anchor: Date; dayStatus: Map<string, 'open' | 'done' | 'cancelled' | 'google'>; today: Date;
  onPickDay: (d: Date) => void; onPickMonth: (d: Date) => void;
}) {
  const year = anchor.getFullYear();
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => new Date(year, i, 1)), [year]);
  return (
    <div className="year-grid">
      {months.map((m) => (
        <MiniMonth key={m.getMonth()} month={m} selected={null} today={today} dayStatus={dayStatus}
                    onPick={onPickDay} onHeaderClick={() => onPickMonth(m)} compact />
      ))}
    </div>
  );
}

/** Odoo-style calendar: Day/Week/Month/Year modes, a mini calendar + status
 *  filter in the sidebar, sharing the same tab-filtered task list the table
 *  and kanban views use. */
export function TaskCalendar({
  tasks, onAddTask, onOpenTaskDetail, googleStatus,
}: {
  tasks: Task[]; onAddTask?: () => void; onOpenTaskDetail: (task: Task) => void;
  googleStatus: GoogleCalendarStatus;
}) {
  const [mode, setMode] = useState<CalendarMode>('month');
  // How the anchored period renders, independent of which period it is.
  // 'timeline' is not a real state here — its button stays disabled until a
  // task actually carries a duration to draw a bar from, so nothing ever
  // sets this to that value.
  const [contentView, setContentView] = useState<'grid' | 'agenda'>('grid');
  const [anchor, setAnchor] = useState(() => new Date());
  const [visible, setVisible] = useState<Record<Task['status'], boolean>>({ open: true, done: true, cancelled: true });
  const [detailDay, setDetailDay] = useState<Date | null>(null);
  const [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([]);
  const today = useMemo(() => new Date(), []);

  const visibleTasks = useMemo(() => tasks.filter((tk) => visible[tk.status]), [tasks, visible]);
  // Every task the tenant has, not just the ones the filter is currently
  // showing — a count that shrinks the moment you check its own box would be
  // useless for deciding whether to check it.
  const statusCounts = useMemo(() => {
    const counts: Record<Task['status'], number> = { open: 0, done: 0, cancelled: 0 };
    for (const tk of tasks) counts[tk.status] += 1;
    return counts;
  }, [tasks]);
  const byDay = useMemo(() => groupByDay(visibleTasks), [visibleTasks]);
  const byDayHour = useMemo(() => groupByDayHour(visibleTasks), [visibleTasks]);
  const detailTasks = detailDay ? byDay.get(detailDay.toDateString()) ?? [] : [];

  // Refetched from Google on every navigation rather than once — the range
  // that matters follows whatever the agent is currently looking at.
  useEffect(() => {
    if (!googleStatus.connected) { setGoogleEvents([]); return; }
    const { from, to } = periodRange(mode, anchor);
    const controller = new AbortController();
    fetch(withBase(`/api/google-calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`), { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { events?: GoogleCalendarEvent[] }) => setGoogleEvents(data.events ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [mode, anchor, googleStatus.connected]);

  // A meeting task that has been pushed to Google comes back from Google's own
  // events fetch too — same meeting, two pills, purple and yellow, right next
  // to each other.
  //
  // Matched on two keys, both exact. `calendarEventId` is the proper link, but
  // it is null on everything the BD chatbot booked: that path creates the
  // Google event through `trained-cb` and the event id is dropped before the
  // task row is written. The Meet link survives that trip and is unique per
  // event, so it closes the same join. Titles deliberately are NOT used —
  // confirmed live, the CRM writes "Meeting wilson x MCN Asia" while Google
  // holds "Meeting Online wilson X MCN Asia" for that very meeting.
  //
  // Follows the status filter rather than every task the tenant has: hiding
  // "Selesai" hides its pill, and the Google pill for that same meeting should
  // reappear rather than vanish with nothing left standing in for it.
  const { dedupedGoogleEvents, googleLinkedTaskIds } = useMemo(() => {
    // Lists, not single ids: the same meeting can legitimately sit on more
    // than one task row, and when it does every one of them is on Google and
    // should say so. Keying to one id labelled whichever happened to be last.
    const push = (map: Map<string, string[]>, key: string, id: string) => {
      const existing = map.get(key);
      if (existing) existing.push(id);
      else map.set(key, [id]);
    };

    const byEventId = new Map<string, string[]>();
    const byMeetLink = new Map<string, string[]>();
    for (const tk of visibleTasks) {
      if (tk.calendarEventId) push(byEventId, tk.calendarEventId, tk.id);
      if (tk.meetingLink) push(byMeetLink, tk.meetingLink, tk.id);
    }

    const linked = new Set<string>();
    const kept: GoogleCalendarEvent[] = [];
    for (const ev of googleEvents) {
      const taskIds = byEventId.get(ev.id) ?? (ev.meetingLink ? byMeetLink.get(ev.meetingLink) : undefined);
      if (taskIds?.length) for (const id of taskIds) linked.add(id);
      else kept.push(ev);
    }
    return { dedupedGoogleEvents: kept, googleLinkedTaskIds: linked };
  }, [visibleTasks, googleEvents]);

  const googleByDay = useMemo(() => groupGoogleByDay(dedupedGoogleEvents), [dedupedGoogleEvents]);
  const googleByDayHour = useMemo(() => groupGoogleByDayHour(dedupedGoogleEvents), [dedupedGoogleEvents]);
  // The mini calendar's own "something is here" dot, and what colour it
  // earns — confirmed live: today carried two Google-only meetings and no
  // CRM task, and the dot never lit up, because `MiniMonth` was only ever
  // handed `byDay`. A day with an open task is 'open' even if it also holds
  // a done one — the thing still outstanding is what a glance at the
  // calendar should surface, not whatever happens to be done. Google-only
  // days fall back to 'google' precisely because there is no task status to
  // read at all.
  const dayStatus = useMemo(() => {
    const map = new Map<string, 'open' | 'done' | 'cancelled' | 'google'>();
    for (const [key, dayTasks] of byDay) {
      if (dayTasks.some((tk) => tk.status === 'open')) map.set(key, 'open');
      else if (dayTasks.some((tk) => tk.status === 'cancelled')) map.set(key, 'cancelled');
      else if (dayTasks.some((tk) => tk.status === 'done')) map.set(key, 'done');
    }
    for (const key of googleByDay.keys()) {
      if (!map.has(key)) map.set(key, 'google');
    }
    return map;
  }, [byDay, googleByDay]);
  // Already excludes anything matched to a task above — the day card's own
  // list, same as the month cell's own pills.
  const detailGoogleEvents = detailDay ? googleByDay.get(detailDay.toDateString()) ?? [] : [];
  // The sidebar's own "Jadwal Hari Ini" box, next to the mini calendar — same
  // two sources as the day card, just always pinned to today rather than
  // whatever date was last clicked, so today's agenda is visible without
  // clicking anything.
  const todayTasks = byDay.get(today.toDateString()) ?? [];
  const todayGoogleEvents = googleByDay.get(today.toDateString()) ?? [];

  // Counts Google's events too, or a day carrying nothing but those would
  // show them *and* the "nothing here" line underneath at the same time.
  const hasAnyInPeriod = useMemo(() => {
    const dayHasSomething = (d: Date) =>
      (byDay.get(d.toDateString())?.length ?? 0) > 0
      || (googleByDay.get(d.toDateString())?.length ?? 0) > 0;

    if (mode === 'day') return dayHasSomething(anchor);
    if (mode === 'week') return weekDays(startOfWeek(anchor)).some(dayHasSomething);
    if (mode === 'year') return visibleTasks.some((tk) => new Date(tk.dueAt).getFullYear() === anchor.getFullYear());
    const inThisMonth = (d: Date) =>
      d.getMonth() === anchor.getMonth() && d.getFullYear() === anchor.getFullYear();
    return visibleTasks.some((tk) => inThisMonth(new Date(tk.dueAt)))
      || dedupedGoogleEvents.some((ev) => inThisMonth(new Date(ev.start)));
  }, [mode, anchor, byDay, googleByDay, visibleTasks, dedupedGoogleEvents]);

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="calendar">
        <div className="calendar-toolbar">
          <div className="calendar-toolbar-left">
            {onAddTask ? (
              <button type="button" className="btn primary sm" onClick={onAddTask}>+ {t.tasks.add}</button>
            ) : null}
            <div className="calendar-nav-group">
              <button type="button" className="btn ghost sm" onClick={() => setAnchor((a) => shiftAnchor(mode, a, -1))} aria-label={t.tasks.prevPeriod}>‹</button>
              <button type="button" className="btn ghost sm" onClick={() => setAnchor(new Date())}>{t.tasks.todayLabel}</button>
              <button type="button" className="btn ghost sm" onClick={() => setAnchor((a) => shiftAnchor(mode, a, 1))} aria-label={t.tasks.nextPeriod}>›</button>
            </div>
            <h3 className="calendar-period-label">{periodLabel(mode, anchor)}</h3>
            <span className="calendar-quarter-badge">Q{Math.ceil((anchor.getMonth() + 1) / 3)}</span>
          </div>
          <div className="calendar-toolbar-left">
            {/* Which period is anchored. Replaces the old <select> — three
                options fit a row of pills; a fourth (Tahun) used to live here
                too but is dropped from this toolbar by design, not by
                oversight (the underlying year view is unused code, kept in
                case it's wanted back rather than deleted outright). */}
            <div className="calendar-pill-group" role="group" aria-label={t.tasks.viewCalendar}>
              {(['day', 'week', 'month'] as const).map((m) => (
                <button type="button" key={m} className={`calendar-pill-btn ${mode === m ? 'active' : ''}`}
                        onClick={() => setMode(m)}>
                  {m === 'day' ? t.tasks.viewDay : m === 'week' ? t.tasks.viewWeek : t.tasks.viewMonth}
                </button>
              ))}
            </div>
            {/* How the anchored period renders — only meaningful for Bulan,
                which is the only mode with more than one way to look at the
                same period. Hari/Minggu already render as an hourly grid,
                which an "agenda" reading of a single day would only repeat. */}
            {mode === 'month' ? (
              <div className="calendar-pill-group" role="group" aria-label={t.tasks.contentViewGrid}>
                <button type="button" className={`calendar-pill-btn ${contentView === 'grid' ? 'active' : ''}`}
                        onClick={() => setContentView('grid')}>
                  {t.tasks.contentViewGrid}
                </button>
                <button type="button" className={`calendar-pill-btn ${contentView === 'agenda' ? 'active' : ''}`}
                        onClick={() => setContentView('agenda')}>
                  {t.tasks.contentViewAgenda}
                </button>
                <button type="button" className="calendar-pill-btn" disabled title={t.tasks.contentViewTimelineSoon}>
                  {t.tasks.contentViewTimeline}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="calendar-body">
          <div className="calendar-main">
            {mode === 'day' ? (
              <DayGrid anchor={anchor} eventsByDayHour={byDayHour}
                       googleByDayHour={googleByDayHour} today={today}
                       googleLinkedTaskIds={googleLinkedTaskIds} />
            ) : null}
            {mode === 'week' ? (
              <WeekGrid anchor={anchor} eventsByDayHour={byDayHour}
                        googleByDayHour={googleByDayHour} today={today}
                        googleLinkedTaskIds={googleLinkedTaskIds} />
            ) : null}
            {mode === 'month' && contentView === 'grid' ? (
              <MonthGrid anchor={anchor} eventsByDay={byDay} googleEventsByDay={googleByDay} today={today}
                         onSelectDay={setDetailDay} onSelectTask={onOpenTaskDetail}
                         googleLinkedTaskIds={googleLinkedTaskIds} />
            ) : null}
            {mode === 'month' && contentView === 'agenda' ? (
              <MonthAgenda anchor={anchor} byDay={byDay} googleByDay={googleByDay}
                           onOpenTaskDetail={onOpenTaskDetail} />
            ) : null}
            {!hasAnyInPeriod ? <p className="empty calendar-empty-msg">{t.tasks.calendarEmpty}</p> : null}
          </div>

          <aside className="calendar-sidebar">
            <MiniMonth month={startOfMonth(anchor)} selected={anchor} today={today} dayStatus={dayStatus}
                        onPick={(d) => setAnchor(d)}
                        onPrev={() => setAnchor((a) => addMonths(a, -1))}
                        onNext={() => setAnchor((a) => addMonths(a, 1))} />
            <div className="agenda-panel">
              <div className="agenda-head">
                {todayTasks.length + todayGoogleEvents.length > 0 ? (
                  <div className="agenda-head-count">
                    <span className="agenda-count-pill">{t.tasks.todayScheduleCount(todayTasks.length + todayGoogleEvents.length)}</span>
                  </div>
                ) : null}
                <div className="agenda-head-title">
                  <span className="calendar-filter-dot" aria-hidden />
                  <h4>{t.tasks.todayScheduleTitle(today.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }))}</h4>
                </div>
              </div>
              {todayTasks.length === 0 && todayGoogleEvents.length === 0 ? (
                <p className="dim" style={{ fontSize: 12, margin: 0 }}>{t.tasks.todayScheduleEmpty}</p>
              ) : (
                <>
                  {todayTasks.map((tk) => {
                    const party = taskPartyName(tk);
                    return (
                      <button type="button" key={tk.id} onClick={() => onOpenTaskDetail(tk)}
                              className={`agenda-item ${pillClass(tk)}`} style={{ width: '100%', textAlign: 'left', background: 'none', cursor: 'pointer' }}>
                        <div className="agenda-item-head">
                          <span className="agenda-item-title">{tk.title}</span>
                          {/* Open (the common case for something due today) gets
                              no badge at all now — title, time, meeting link is
                              the whole card. Done/cancelled still get one: that
                              is real information a strikethrough title alone
                              doesn't fully carry (looks the same for either). */}
                          {tk.status !== 'open' ? (
                            <span className="agenda-badge"
                                  style={tk.status === 'done'
                                    ? { color: 'var(--good)', background: 'var(--good-soft)' }
                                    : { color: 'var(--danger)', background: 'var(--danger-soft)' }}>
                              {t.tasks.statusLabel[tk.status] ?? tk.status}
                            </span>
                          ) : null}
                        </div>
                        <span className="agenda-item-time">
                          <ClockIcon /> {clock(tk.dueAt)} WIB
                        </span>
                        <div className="agenda-item-foot">
                          {/* One or the other, never both: a Meet link is
                              something to join, an avatar is who it's with —
                              this component has no attendee list to draw on
                              (no `members` prop), so it shows the one name
                              already available, the contact/brand the meeting
                              is about. */}
                          {tk.meetingLink ? (
                            <span className="agenda-meet-pill">{t.tasks.googleMeetBadge}</span>
                          ) : party ? (
                            <span className="avatar agenda-item-avatar" title={party}>{initials(party)}</span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                  {/* Same read-only treatment as everywhere else a Google-only
                      event shows up next to a task: a link out, not a button —
                      there is nothing in this database to open a detail on.
                      Styled identically to a task card rather than marked out
                      as a different kind of row — this widget's whole point is
                      "what's on today", and that reads the same whether the
                      row behind it is a task or a bare Calendar event. That
                      distinction still exists everywhere it actually matters
                      (the month pills, the day card, the detail drawer); it
                      just isn't this list's job to repeat it. */}
                  {todayGoogleEvents.map((ev) => (
                    <a key={ev.id} href={ev.htmlLink} target="_blank" rel="noreferrer" className="agenda-item">
                      <div className="agenda-item-head">
                        <span className="agenda-item-title">{ev.title}</span>
                      </div>
                      <span className="agenda-item-time">
                        <ClockIcon /> {ev.allDay ? t.tasks.allDay : `${clock(ev.start)} WIB`}
                      </span>
                      {/* Present on some pulled-in events and not others — a
                          Meet link Google generated when the meeting was
                          booked, not something every Calendar event has. */}
                      {ev.meetingLink ? (
                        <div className="agenda-item-foot">
                          <span className="agenda-meet-pill">{t.tasks.googleMeetBadge}</span>
                        </div>
                      ) : null}
                    </a>
                  ))}
                </>
              )}
            </div>
            <div className="calendar-filters">
              <div className="calendar-filters-head">
                <h4>{t.tasks.filtersLabel}</h4>
                <button type="button" className="calendar-filters-reset"
                        onClick={() => setVisible({ open: true, done: true, cancelled: true })}>
                  {t.tasks.resetFilters}
                </button>
              </div>
              {STATUSES.map((s) => (
                <label key={s} className="calendar-filter-row">
                  <input type="checkbox" checked={visible[s]}
                         onChange={() => setVisible((v) => ({ ...v, [s]: !v[s] }))} />
                  <span className={`calendar-filter-dot ${s}`} />
                  <span style={{ flex: 1 }}>{t.tasks.statusLabel[s]}</span>
                  <span className="calendar-filter-count">{statusCounts[s]}</span>
                </label>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <DayDetailModal date={detailDay} tasks={detailTasks} googleEvents={detailGoogleEvents}
                      onClose={() => setDetailDay(null)}
                      onOpenTaskDetail={onOpenTaskDetail} googleLinkedTaskIds={googleLinkedTaskIds} />
    </div>
  );
}
