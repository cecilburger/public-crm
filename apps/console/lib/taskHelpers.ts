import type { Task } from './api';

/** Shared by the table, kanban, and calendar views of Tugas so the three never drift apart. */
export function formatTaskDue(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
}

export function isTaskOverdue(task: Task): boolean {
  return task.status === 'open' && new Date(task.dueAt).getTime() < Date.now();
}

export function isTaskDueToday(task: Task): boolean {
  return task.status === 'open' && new Date(task.dueAt).toDateString() === new Date().toDateString();
}
