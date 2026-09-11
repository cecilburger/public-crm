'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Task, Member, Contact, Deal } from '@/lib/api';
import { initials } from '@/lib/format';
import { t } from '@/lib/copy';
import { formatTaskDue, isTaskOverdue, isTaskDueToday } from '@/lib/taskHelpers';
import { markTaskDone } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { CancelTaskButton } from '@/components/CancelTaskButton';
import { TaskDrawer } from '@/components/TaskDrawer';
import { TaskKanban } from '@/components/TaskKanban';
import { TaskCalendar } from '@/components/TaskCalendar';

const STATUS_CHIP: Record<Task['status'], string> = {
  open: 'chip brand', done: 'chip good', cancelled: 'chip danger',
};

const TABS: { key: 'all' | 'due' | Task['status']; label: string }[] = [
  { key: 'all', label: t.tasks.filterAll },
  { key: 'due', label: t.tasks.filterDue },
  { key: 'done', label: t.tasks.filterDone },
  { key: 'cancelled', label: t.tasks.filterCancelled },
];

type ViewMode = 'table' | 'kanban' | 'calendar';

export function TaskTable({
  tasks, members, contacts, deals,
}: { tasks: Task[]; members: Member[]; contacts: Contact[]; deals: Deal[] }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'due' | Task['status']>('due');
  const [view, setView] = useState<ViewMode>('table');
  const [drawerOpen, setDrawerOpen] = useState(false);

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
      const haystack = [tk.title, tk.contactName, tk.contactPhone, tk.dealTitle].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [tasks, query, tab]);

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.tasks.title}</h1>
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
        {filtered.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>
              {tasks.length === 0 ? t.tasks.empty : t.tasks.noMatches}
            </p>
          </div>
        ) : view === 'calendar' ? (
          <TaskCalendar tasks={filtered} onAddTask={() => setDrawerOpen(true)} />
        ) : view === 'kanban' ? (
          <div style={{ marginTop: 14 }}><TaskKanban tasks={filtered} members={members} /></div>
        ) : (
          <div className="panel" style={{ marginTop: 14, border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.tasks.taskTitle}</th>
                  <th>{t.tasks.contact}</th>
                  <th>{t.tasks.dueAt}</th>
                  <th>{t.tasks.assignee}</th>
                  <th>{t.tasks.status}</th>
                  <th style={{ textAlign: 'center' }}>{t.tasks.actions}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tk) => (
                  <tr key={tk.id}>
                    <td>
                      <b>{tk.title}</b>
                      {tk.dealTitle ? <><br /><span className="mono dim" style={{ fontSize: 11 }}>{tk.dealTitle}</span></> : null}
                    </td>
                    <td>
                      <Link href={`/pelanggan/${tk.contactId}`} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span className="avatar" aria-hidden>{initials(tk.contactName)}</span>
                        <b>{tk.contactName ?? tk.contactPhone ?? '—'}</b>
                      </Link>
                    </td>
                    <td>
                      {formatTaskDue(tk.dueAt)}
                      {isTaskOverdue(tk) ? <><br /><span className="chip danger" style={{ marginTop: 3 }}>{t.tasks.overdue}</span></> : null}
                      {!isTaskOverdue(tk) && isTaskDueToday(tk) ? <><br /><span className="chip warn" style={{ marginTop: 3 }}>{t.tasks.dueToday}</span></> : null}
                    </td>
                    <td>{tk.assigneeId ? names.get(tk.assigneeId) ?? '—' : <span className="dim">{t.tasks.unassigned}</span>}</td>
                    <td><span className={STATUS_CHIP[tk.status]}>{t.tasks.statusLabel[tk.status] ?? tk.status}</span></td>
                    <td style={{ textAlign: 'center' }}>
                      {tk.status === 'open' ? (
                        <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <form action={markTaskDone}>
                            <CsrfField />
                            <input type="hidden" name="taskId" value={tk.id} />
                            <button className="btn ghost sm" type="submit">{t.tasks.markDone}</button>
                          </form>
                          <CancelTaskButton task={tk} />
                        </span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <TaskDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}
                  contacts={contacts} members={members} deals={deals} />
    </>
  );
}
