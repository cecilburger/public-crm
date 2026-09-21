'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { Task, Member, Deal, TaskKind, Brand, GoogleCalendarStatus, GoogleCalendarEvent } from '@/lib/api';
import { initials } from '@/lib/format';
import { t } from '@/lib/copy';
import { formatTaskDue, isTaskOverdue, isTaskDueToday, taskPartyName, taskPartyHref } from '@/lib/taskHelpers';
import { markTaskDone, disconnectGoogleCalendar } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { CancelTaskButton } from '@/components/CancelTaskButton';
import { TaskDrawer } from '@/components/TaskDrawer';
import { TaskDetailDrawer } from '@/components/TaskDetailDrawer';
import { TaskKanban } from '@/components/TaskKanban';
import { TaskCalendar } from '@/components/TaskCalendar';
import { KindIcon } from '@/components/KindIcon';
import { SendCalendarEventEmailButton } from '@/components/SendCalendarEventEmailButton';
import { GoogleCalendarEventDetailDrawer } from '@/components/GoogleCalendarEventDetailDrawer';

const GOOGLE_WINDOW_DAYS = 30;

type Row = { kind: 'task'; task: Task } | { kind: 'google'; event: GoogleCalendarEvent };

const STATUS_CHIP: Record<Task['status'], string> = {
  open: 'chip brand', done: 'chip good', cancelled: 'chip danger',
};

const PRIORITY_CHIP: Record<Task['priority'], string> = {
  low: 'chip', medium: 'chip brand', high: 'chip warn', urgent: 'chip danger',
};

const TABS: { key: 'all' | 'due' | Task['status']; label: string }[] = [
  { key: 'all', label: t.tasks.filterAll },
  { key: 'due', label: t.tasks.filterDue },
  { key: 'done', label: t.tasks.filterDone },
  { key: 'cancelled', label: t.tasks.filterCancelled },
];

type ViewMode = 'table' | 'kanban' | 'calendar';

export function TaskTable({
  tasks, members, deals, taskKinds, brands, googleStatus, title = t.tasks.title, defaultView = 'table',
}: {
  tasks: Task[]; members: Member[]; deals: Deal[]; taskKinds: TaskKind[]; brands: Brand[];
  googleStatus: GoogleCalendarStatus; title?: string; defaultView?: ViewMode;
}) {
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'due' | Task['status']>('due');
  const [view, setView] = useState<ViewMode>(defaultView);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [detailGoogleEvent, setDetailGoogleEvent] = useState<GoogleCalendarEvent | null>(null);

  const names = new Map(members.map((m) => [m.id, m.name]));

  const counts = useMemo(() => ({
    due: tasks.filter((tk) => tk.status === 'open').length,
    done: tasks.filter((tk) => tk.status === 'done').length,
    cancelled: tasks.filter((tk) => tk.status === 'cancelled').length,
  }), [tasks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((tk) => {
      if (tab === 'due' && tk.status !== 'open') return false;
      if ((tab === 'done' || tab === 'cancelled') && tk.status !== tab) return false;
      if (!q) return true;
      const haystack = [tk.title, tk.contactName, tk.contactPhone, tk.brandName, tk.brandPhone, tk.dealTitle]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [tasks, query, tab]);

  // Table and Kanban have no date range of their own the way Kalender does —
  // this asks Google for a fixed "next 30 days" window instead, once, up
  // here, so both views merge in the exact same events.
  const [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([]);
  useEffect(() => {
    if (!googleStatus.connected) { setGoogleEvents([]); return; }
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + GOOGLE_WINDOW_DAYS);
    const controller = new AbortController();
    fetch(`/api/google-calendar/events?from=${from.toISOString()}&to=${to.toISOString()}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { events?: GoogleCalendarEvent[] }) => setGoogleEvents(data.events ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [googleStatus.connected]);

  // "Done"/"Batal" are task-only states an event has no equivalent for, so
  // Google only folds into the "Semua"/"Perlu ditindak" tabs — the two that
  // already read as "what's coming up".
  const showGoogle = googleStatus.connected && (tab === 'all' || tab === 'due');
  const filteredGoogleEvents = useMemo(() => {
    if (!showGoogle) return [];
    const q = query.trim().toLowerCase();
    return q ? googleEvents.filter((ev) => ev.title.toLowerCase().includes(q)) : googleEvents;
  }, [googleEvents, query, showGoogle]);

  const rows: Row[] = useMemo(() => {
    const taskRows: Row[] = filtered.map((task) => ({ kind: 'task', task }));
    const googleRows: Row[] = filteredGoogleEvents.map((event) => ({ kind: 'google', event }));
    return [...taskRows, ...googleRows].sort((a, b) => {
      const da = new Date(a.kind === 'task' ? a.task.dueAt : a.event.start).getTime();
      const db = new Date(b.kind === 'task' ? b.task.dueAt : b.event.start).getTime();
      return da - db;
    });
  }, [filtered, filteredGoogleEvents]);

  // Calendar view never falls back to the plain "empty" placeholder — a
  // grid with nothing on it (today's date, month navigation, a Google
  // Calendar toggle if connected) is still worth seeing, unlike an empty
  // table or board.
  const showEmptyState = view === 'table'
    ? rows.length === 0
    : view === 'kanban'
      ? filtered.length === 0 && !(showGoogle && filteredGoogleEvents.length > 0)
      : false;

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{title}</h1>
          </div>
          <div className="odoo-cp-search">
            <div className="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input className="line-search-input" value={query} onChange={(e) => setQuery(e.target.value)}
                     placeholder={t.tasks.searchPlaceholder} aria-label={t.tasks.searchPlaceholder} />
            </div>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <button type="button" className="btn primary" onClick={() => setDrawerOpen(true)}>{t.tasks.add}</button>
            {googleStatus.connected ? (
              <form action={disconnectGoogleCalendar}>
                <CsrfField />
                <button type="submit" className="btn ghost sm" title={t.tasks.disconnectHint}>
                  <span className="google-dot" aria-hidden /> {t.tasks.googleConnected}
                  {googleStatus.email ? <span className="dim" style={{ marginLeft: 5 }}>({googleStatus.email})</span> : null}
                </button>
              </form>
            ) : (
              <a href={`/api/google-calendar/connect?from=${encodeURIComponent(pathname)}`} className="btn ghost sm">
                {t.tasks.googleConnect}
              </a>
            )}
          </div>
          <div className="odoo-cp-right">
            {TABS.map((tab_) => (
              <button key={tab_.key} type="button" className={`btn sm ${tab === tab_.key ? 'primary' : 'ghost'}`}
                      onClick={() => setTab(tab_.key)} aria-current={tab === tab_.key ? 'page' : undefined}>
                {tab_.label}{tab_.key !== 'all' && counts[tab_.key as keyof typeof counts] !== undefined
                  ? ` (${counts[tab_.key as keyof typeof counts]})` : ''}
              </button>
            ))}
            <div className="odoo-view-switchers">
              <button className={`btn icon ${view === 'table' ? 'active' : 'ghost'}`}
                      onClick={() => setView('table')} aria-label={t.tasks.viewTable}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              </button>
              <button className={`btn icon ${view === 'kanban' ? 'active' : 'ghost'}`}
                      onClick={() => setView('kanban')} aria-label={t.tasks.viewKanban}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                </svg>
              </button>
              <button className={`btn icon ${view === 'calendar' ? 'active' : 'ghost'}`}
                      onClick={() => setView('calendar')} aria-label={t.tasks.viewCalendar}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="main-content-area">
        {showEmptyState ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>
              {tasks.length === 0 ? t.tasks.empty : t.tasks.noMatches}
            </p>
          </div>
        ) : view === 'calendar' ? (
          <TaskCalendar tasks={filtered} onAddTask={() => setDrawerOpen(true)} onOpenTaskDetail={setDetailTask}
                        googleStatus={googleStatus} />
        ) : view === 'kanban' ? (
          <div style={{ marginTop: 14 }}>
            <TaskKanban tasks={filtered} members={members} googleEvents={googleEvents} showGoogleColumn={showGoogle} />
          </div>
        ) : (
          <div className="panel" style={{ marginTop: 14, border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.tasks.taskTitle}</th>
                  <th>{t.tasks.kind}</th>
                  <th>{t.tasks.priority}</th>
                  <th>{t.tasks.contact}</th>
                  <th>{t.tasks.dueAt}</th>
                  <th>{t.tasks.assignee}</th>
                  <th>{t.tasks.status}</th>
                  <th style={{ textAlign: 'center' }}>{t.tasks.actions}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => row.kind === 'google' ? (
                  <tr key={`g-${row.event.id}`}>
                    <td>
                      <b>{row.event.title}</b>
                      <br /><span className="mono dim" style={{ fontSize: 11 }}>{t.tasks.googleSource}</span>
                    </td>
                    <td>
                      {row.event.meetingLink ? (
                        <>
                          <span className="chip"><KindIcon kind="meeting" /> {t.tasks.kindLabel.meeting}</span>
                          <br />
                          <a href={row.event.meetingLink} target="_blank" rel="noreferrer"
                             style={{ fontSize: 11.5, marginTop: 3, display: 'inline-block' }}>
                            {t.tasks.joinMeeting}
                          </a>
                        </>
                      ) : (
                        <span className="chip"><span className="google-dot" aria-hidden /> {t.tasks.googleSource}</span>
                      )}
                    </td>
                    <td className="dim">—</td>
                    <td className="dim">—</td>
                    <td>
                      {new Date(row.event.start).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {row.event.allDay ? '' : ` · ${new Date(row.event.start).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`}
                    </td>
                    <td className="dim">—</td>
                    <td className="dim">—</td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button type="button" className="btn ghost sm" onClick={() => setDetailGoogleEvent(row.event)}>
                          {t.tasks.detail}
                        </button>
                        <a href={row.event.htmlLink} target="_blank" rel="noreferrer" className="btn ghost sm">
                          {t.tasks.openInGoogle}
                        </a>
                        {row.event.meetingLink ? <SendCalendarEventEmailButton event={row.event} /> : null}
                      </span>
                    </td>
                  </tr>
                ) : (
                  <tr key={row.task.id}>
                    <td>
                      <b>{row.task.title}</b>
                      {row.task.dealTitle ? <><br /><span className="mono dim" style={{ fontSize: 11 }}>{row.task.dealTitle}</span></> : null}
                    </td>
                    <td>
                      <span className="chip">{t.tasks.kindLabel[row.task.kind] ?? row.task.kind}</span>
                      {row.task.kind === 'meeting' && row.task.meetingLink ? (
                        <>
                          <br />
                          <a href={row.task.meetingLink} target="_blank" rel="noreferrer"
                             style={{ fontSize: 11.5, marginTop: 3, display: 'inline-block' }}>
                            {t.tasks.joinMeeting}
                          </a>
                        </>
                      ) : null}
                      {row.task.kind === 'meeting' && row.task.calendarEventLink ? (
                        <>
                          <br />
                          <a href={row.task.calendarEventLink} target="_blank" rel="noreferrer"
                             className="dim" style={{ fontSize: 11.5, marginTop: 3, display: 'inline-block' }}>
                            {t.tasks.viewInGoogleCalendar}
                          </a>
                        </>
                      ) : null}
                    </td>
                    <td><span className={PRIORITY_CHIP[row.task.priority]}>{t.tasks.priorityLabel[row.task.priority] ?? row.task.priority}</span></td>
                    <td>
                      {taskPartyHref(row.task) ? (
                        <Link href={taskPartyHref(row.task)!} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <span className="avatar" aria-hidden>{initials(taskPartyName(row.task))}</span>
                          <b>{taskPartyName(row.task) ?? '—'}</b>
                        </Link>
                      ) : (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <span className="avatar" aria-hidden>{initials(taskPartyName(row.task))}</span>
                          <b>{taskPartyName(row.task) ?? '—'}</b>
                        </span>
                      )}
                    </td>
                    <td>
                      {formatTaskDue(row.task.dueAt)}
                      {isTaskOverdue(row.task) ? <><br /><span className="chip danger" style={{ marginTop: 3 }}>{t.tasks.overdue}</span></> : null}
                      {!isTaskOverdue(row.task) && isTaskDueToday(row.task) ? <><br /><span className="chip warn" style={{ marginTop: 3 }}>{t.tasks.dueToday}</span></> : null}
                      {row.task.repeatUnit ? (
                        <><br /><span className="chip" style={{ marginTop: 3 }}>{t.tasks.repeatBadge(row.task.repeatUnit, row.task.repeatInterval)}</span></>
                      ) : null}
                    </td>
                    <td>{row.task.assigneeId ? names.get(row.task.assigneeId) ?? '—' : <span className="dim">{t.tasks.unassigned}</span>}</td>
                    <td><span className={STATUS_CHIP[row.task.status]}>{t.tasks.statusLabel[row.task.status] ?? row.task.status}</span></td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button type="button" className="btn ghost sm" onClick={() => setDetailTask(row.task)}>
                          {t.tasks.detail}
                        </button>
                        {row.task.status === 'open' ? (
                          <>
                            <form action={markTaskDone}>
                              <CsrfField />
                              <input type="hidden" name="taskId" value={row.task.id} />
                              <button className="btn ghost sm" type="submit">{t.tasks.markDone}</button>
                            </form>
                            <CancelTaskButton task={row.task} />
                          </>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <TaskDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}
                  members={members} deals={deals} taskKinds={taskKinds} brands={brands} />
      <TaskDetailDrawer task={detailTask} open={detailTask !== null} onClose={() => setDetailTask(null)}
                        members={members} deals={deals} taskKinds={taskKinds} />
      <GoogleCalendarEventDetailDrawer event={detailGoogleEvent} onClose={() => setDetailGoogleEvent(null)} />
    </>
  );
}
