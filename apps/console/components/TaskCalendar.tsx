'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/lib/copy';
import { formatTaskDue, isTaskOverdue } from '@/lib/taskHelpers';
import {
  addDays, addMonths, monthGrid, sameDay, shiftAnchor, startOfMonth, startOfWeek, weekDays,
} from '@/lib/calendarHelpers';
import type { CalendarMode } from '@/lib/calendarHelpers';
import type { Task, GoogleCalendarEvent, GoogleCalendarStatus } from '@/lib/api';
import { markTaskDone, disconnectGoogleCalendar } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { CancelTaskButton } from '@/components/CancelTaskButton';

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

function EventPill({ task, compact }: { task: Task; compact?: boolean }) {
  const label = compact ? task.title : `${task.title}${task.contactName ? ` · ${task.contactName}` : ''}`;
  return (
    <span className={`time-event ${pillClass(task)}`} title={`${task.title}${task.contactName ? ` — ${task.contactName}` : ''}`}>
      {label}
    </span>
  );
}

function MiniMonth({
  month, selected, today, eventsByDay, onPick, onPrev, onNext, onHeaderClick, compact,
}: {
  month: Date; selected: Date | null; today: Date; eventsByDay: Map<string, Task[]>;
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
          const hasEvents = (eventsByDay.get(d.toDateString())?.length ?? 0) > 0;
          const isToday = sameDay(d, today);
          const isSelected = selected ? sameDay(d, selected) : false;
          return (
            <button type="button" key={d.toISOString()}
                    className={`mini-cal-day ${inMonth ? '' : 'outside'} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${hasEvents ? 'has-events' : ''}`}
                    onClick={() => onPick(d)}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DayGrid({ anchor, eventsByDayHour, today }: { anchor: Date; eventsByDayHour: Map<string, Task[]>; today: Date }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: ROW_H * 6 }); }, [anchor]);
  const isToday = sameDay(anchor, today);
  const nowHour = today.getHours();
  return (
    <div className="time-grid">
      <div className="time-scroll" ref={scrollRef}>
        {HOURS.map((h) => {
          const items = eventsByDayHour.get(`${anchor.toDateString()}#${h}`) ?? [];
          return (
            <div key={h} className={`time-row ${isToday && h === nowHour ? 'current-hour' : ''}`}>
              <div className="time-row-label">{String(h).padStart(2, '0')}:00</div>
              <div className="time-row-slot">
                {items.map((tk) => <EventPill key={tk.id} task={tk} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekGrid({ anchor, eventsByDayHour, today }: { anchor: Date; eventsByDayHour: Map<string, Task[]>; today: Date }) {
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
              return (
                <div key={d.toISOString()} className={`time-row-slot ${sameDay(d, today) ? 'today' : ''}`}>
                  {items.map((tk) => <EventPill key={tk.id} task={tk} compact />)}
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
  anchor, eventsByDay, googleEventsByDay, today, onSelectDay, onSelectTask,
}: {
  anchor: Date; eventsByDay: Map<string, Task[]>; googleEventsByDay: Map<string, GoogleCalendarEvent[]>; today: Date;
  onSelectDay: (d: Date) => void; onSelectTask: (task: Task) => void;
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
            {visible.map((tk) => (
              <button type="button" key={tk.id} className={`calendar-pill ${pillClass(tk)}`}
                      title={`${tk.title}${tk.contactName ? ` — ${tk.contactName}` : ''}`}
                      onClick={(e) => { e.stopPropagation(); onSelectTask(tk); }}>
                {tk.title}
              </button>
            ))}
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
  date, tasks, onClose, onOpenTaskDetail,
}: { date: Date | null; tasks: Task[]; onClose: () => void; onOpenTaskDetail: (task: Task) => void }) {
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
        {tasks.length === 0 ? (
          <p className="empty" style={{ padding: '12px 0' }}>{t.tasks.calendarEmpty}</p>
        ) : (
          <div className="day-detail-list">
            {tasks.map((tk) => (
              <div key={tk.id} className="day-detail-row">
                <div style={{ minWidth: 0 }}>
                  <b>{tk.title}</b>
                  {tk.dealTitle ? <div className="mono dim" style={{ fontSize: 11 }}>{tk.dealTitle}</div> : null}
                  <div style={{ fontSize: 12, marginTop: 3 }}>{formatTaskDue(tk.dueAt)}</div>
                  <Link href={`/pelanggan/${tk.contactId}`} className="mono dim" style={{ fontSize: 11.5 }}>
                    {tk.contactName ?? tk.contactPhone ?? '—'}
                  </Link>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    <span className={STATUS_CHIP[tk.status]}>{t.tasks.statusLabel[tk.status] ?? tk.status}</span>
                    {isTaskOverdue(tk) ? <span className="chip danger">{t.tasks.overdue}</span> : null}
                    <span className={PRIORITY_CHIP[tk.priority]}>{t.tasks.priorityLabel[tk.priority] ?? tk.priority}</span>
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
          </div>
        )}
      </div>
    </dialog>
  );
}

function YearGrid({
  anchor, eventsByDay, today, onPickDay, onPickMonth,
}: {
  anchor: Date; eventsByDay: Map<string, Task[]>; today: Date;
  onPickDay: (d: Date) => void; onPickMonth: (d: Date) => void;
}) {
  const year = anchor.getFullYear();
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => new Date(year, i, 1)), [year]);
  return (
    <div className="year-grid">
      {months.map((m) => (
        <MiniMonth key={m.getMonth()} month={m} selected={null} today={today} eventsByDay={eventsByDay}
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
  const [anchor, setAnchor] = useState(() => new Date());
  const [visible, setVisible] = useState<Record<Task['status'], boolean>>({ open: true, done: true, cancelled: true });
  const [detailDay, setDetailDay] = useState<Date | null>(null);
  const [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([]);
  const today = useMemo(() => new Date(), []);

  const visibleTasks = useMemo(() => tasks.filter((tk) => visible[tk.status]), [tasks, visible]);
  const byDay = useMemo(() => groupByDay(visibleTasks), [visibleTasks]);
  const byDayHour = useMemo(() => groupByDayHour(visibleTasks), [visibleTasks]);
  const detailTasks = detailDay ? byDay.get(detailDay.toDateString()) ?? [] : [];

  // Refetched from Google on every navigation rather than once — the range
  // that matters follows whatever the agent is currently looking at.
  useEffect(() => {
    if (!googleStatus.connected) { setGoogleEvents([]); return; }
    const { from, to } = periodRange(mode, anchor);
    const controller = new AbortController();
    fetch(`/api/google-calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { events?: GoogleCalendarEvent[] }) => setGoogleEvents(data.events ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [mode, anchor, googleStatus.connected]);

  const googleByDay = useMemo(() => groupGoogleByDay(googleEvents), [googleEvents]);

  const hasAnyInPeriod = useMemo(() => {
    if (mode === 'day') return (byDay.get(anchor.toDateString())?.length ?? 0) > 0;
    if (mode === 'week') {
      const days = weekDays(startOfWeek(anchor));
      return days.some((d) => (byDay.get(d.toDateString())?.length ?? 0) > 0);
    }
    if (mode === 'year') return visibleTasks.some((tk) => new Date(tk.dueAt).getFullYear() === anchor.getFullYear());
    return visibleTasks.some((tk) => {
      const d = new Date(tk.dueAt);
      return d.getMonth() === anchor.getMonth() && d.getFullYear() === anchor.getFullYear();
    });
  }, [mode, anchor, byDay, visibleTasks]);

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
          </div>
          <div className="calendar-toolbar-left">
            {googleStatus.connected ? (
              <form action={disconnectGoogleCalendar}>
                <CsrfField />
                <button type="submit" className="btn ghost sm" title={t.tasks.disconnectHint}>
                  <span className="google-dot" aria-hidden /> {t.tasks.googleConnected}
                  {googleStatus.email ? <span className="dim" style={{ marginLeft: 5 }}>({googleStatus.email})</span> : null}
                </button>
              </form>
            ) : (
              <a href="/api/google-calendar/connect" className="btn ghost sm">{t.tasks.googleConnect}</a>
            )}
            <select className="calendar-mode-select" value={mode}
                    onChange={(e) => setMode(e.target.value as CalendarMode)} aria-label={t.tasks.viewCalendar}>
              <option value="day">{t.tasks.viewDay}</option>
              <option value="week">{t.tasks.viewWeek}</option>
              <option value="month">{t.tasks.viewMonth}</option>
              <option value="year">{t.tasks.viewYear}</option>
            </select>
          </div>
        </div>

        <div className="calendar-body">
          <div className="calendar-main">
            {mode === 'day' ? <DayGrid anchor={anchor} eventsByDayHour={byDayHour} today={today} /> : null}
            {mode === 'week' ? <WeekGrid anchor={anchor} eventsByDayHour={byDayHour} today={today} /> : null}
            {mode === 'month' ? (
              <MonthGrid anchor={anchor} eventsByDay={byDay} googleEventsByDay={googleByDay} today={today}
                         onSelectDay={setDetailDay} onSelectTask={onOpenTaskDetail} />
            ) : null}
            {mode === 'year' ? (
              <YearGrid anchor={anchor} eventsByDay={byDay} today={today}
                        onPickDay={(d) => { setAnchor(d); setMode('day'); }}
                        onPickMonth={(d) => { setAnchor(d); setMode('month'); }} />
            ) : null}
            {!hasAnyInPeriod ? <p className="empty calendar-empty-msg">{t.tasks.calendarEmpty}</p> : null}
          </div>

          <aside className="calendar-sidebar">
            <MiniMonth month={startOfMonth(anchor)} selected={anchor} today={today} eventsByDay={byDay}
                        onPick={(d) => setAnchor(d)}
                        onPrev={() => setAnchor((a) => addMonths(a, -1))}
                        onNext={() => setAnchor((a) => addMonths(a, 1))} />
            <div className="calendar-filters">
              <h4>{t.tasks.filtersLabel}</h4>
              {STATUSES.map((s) => (
                <label key={s} className="calendar-filter-row">
                  <input type="checkbox" checked={visible[s]}
                         onChange={() => setVisible((v) => ({ ...v, [s]: !v[s] }))} />
                  <span className={`calendar-filter-dot ${s}`} />
                  {t.tasks.statusLabel[s]}
                </label>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <DayDetailModal date={detailDay} tasks={detailTasks} onClose={() => setDetailDay(null)}
                      onOpenTaskDetail={onOpenTaskDetail} />
    </div>
  );
}
