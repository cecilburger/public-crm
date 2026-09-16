import { t } from '@/lib/copy';
import { formatTaskDue, isTaskOverdue } from '@/lib/taskHelpers';
import type { Task, Member } from '@/lib/api';

const MONTH_YEAR = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' });

function groupTitle(iso: string): string {
  const d = new Date(iso);
  return MONTH_YEAR.format(d).replace(/^\w/, (c) => c.toUpperCase());
}

function ActivityRow({ task, assigneeName }: { task: Task; assigneeName: string }) {
  const overdue = isTaskOverdue(task);
  const statusClass = task.status === 'done' ? 'done' : task.status === 'cancelled' ? 'cancelled' : overdue ? 'overdue' : '';
  const dateLabel = task.status === 'done'
    ? formatTaskDue(task.completedAt ?? task.dueAt)
    : task.status === 'cancelled'
      ? t.activities.cancelled(formatTaskDue(task.dueAt))
      : overdue
        ? t.activities.overdue(formatTaskDue(task.dueAt))
        : t.activities.due(formatTaskDue(task.dueAt));

  return (
    <div className="activity-row">
      <span className={`activity-status ${statusClass}`} aria-hidden>
        {task.status === 'done' ? '✓' : task.status === 'cancelled' ? '×' : null}
      </span>
      <div className="timeline-body">
        <div className="timeline-head">
          <b>{t.activities.assignedTo(assigneeName)}</b>
          <span className="mono dim" style={overdue ? { color: 'var(--danger)' } : undefined}>{dateLabel}</span>
        </div>
        <span style={{ fontSize: 12.5, color: 'var(--ink-2)', textDecoration: task.status === 'done' ? 'line-through' : undefined }}>
          {task.title}
        </span>
      </div>
    </div>
  );
}

/**
 * A HubSpot-style side panel: this client's tasks, open ones first
 * regardless of date, everything else grouped by the month it closed in —
 * same grouping whether it was finished or cancelled, so "what happened in
 * March" reads as one list instead of two.
 */
export function ClientActivities({ tasks, members }: { tasks: Task[]; members: Member[] }) {
  const names = new Map(members.map((m) => [m.id, m.name]));
  const assigneeName = (task: Task) => (task.assigneeId ? names.get(task.assigneeId) ?? t.tasks.unassigned : t.tasks.unassigned);

  if (tasks.length === 0) {
    return (
      <div className="activity-panel">
        <h3>{t.activities.title}</h3>
        <p className="record-hint">{t.activities.empty}</p>
      </div>
    );
  }

  const upcoming = tasks
    .filter((tsk) => tsk.status === 'open')
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

  const closed = tasks
    .filter((tsk) => tsk.status !== 'open')
    .sort((a, b) => new Date(b.completedAt ?? b.dueAt).getTime() - new Date(a.completedAt ?? a.dueAt).getTime());

  const closedGroups: { title: string; rows: Task[] }[] = [];
  for (const task of closed) {
    const label = groupTitle(task.completedAt ?? task.dueAt);
    const group = closedGroups.at(-1);
    if (group?.title === label) group.rows.push(task);
    else closedGroups.push({ title: label, rows: [task] });
  }

  return (
    <div className="activity-panel">
      <h3>{t.activities.title}</h3>

      {upcoming.length > 0 ? (
        <div className="activity-group">
          <div className="activity-group-title">{t.activities.upcoming}</div>
          {upcoming.map((tsk) => <ActivityRow key={tsk.id} task={tsk} assigneeName={assigneeName(tsk)} />)}
        </div>
      ) : null}

      {closedGroups.map((group) => (
        <div className="activity-group" key={group.title}>
          <div className="activity-group-title">{group.title}</div>
          {group.rows.map((tsk) => <ActivityRow key={tsk.id} task={tsk} assigneeName={assigneeName(tsk)} />)}
        </div>
      ))}
    </div>
  );
}
