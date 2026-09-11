'use client';

import Link from 'next/link';
import { t } from '@/lib/copy';
import { formatTaskDue, isTaskOverdue, isTaskDueToday } from '@/lib/taskHelpers';
import { markTaskDone } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { CancelTaskButton } from '@/components/CancelTaskButton';
import type { Task, Member } from '@/lib/api';

const COLUMNS: { key: Task['status']; label: string }[] = [
  { key: 'open', label: t.tasks.filterDue },
  { key: 'done', label: t.tasks.filterDone },
  { key: 'cancelled', label: t.tasks.filterCancelled },
];

/** One column per status — the same shape as the Penjualan board, so a
 *  follow-up reads the same way a deal does: cards you move by finishing
 *  or dropping them, not by dragging. */
export function TaskKanban({ tasks, members }: { tasks: Task[]; members: Member[] }) {
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
                  <div className="title">{tk.title}</div>
                  <Link href={`/pelanggan/${tk.contactId}`} className="mono dim" style={{ fontSize: 11 }}>
                    {tk.contactName ?? tk.contactPhone ?? '—'}
                  </Link>
                  <div style={{ fontSize: 11.5, marginTop: 6 }}>{formatTaskDue(tk.dueAt)}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    {isTaskOverdue(tk) ? <span className="chip danger">{t.tasks.overdue}</span> : null}
                    {!isTaskOverdue(tk) && isTaskDueToday(tk) ? <span className="chip warn">{t.tasks.dueToday}</span> : null}
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
    </div>
  );
}
