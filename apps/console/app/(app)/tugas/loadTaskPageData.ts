import {
  api, type Task, type Member, type Deal, type TaskKind, type Brand, type GoogleCalendarStatus,
} from '@/lib/api';

/**
 * The fetch bundle both Tugas and Calendar need — Calendar is the same
 * `TaskTable` (tasks + Google Calendar events merged in), just opened
 * straight to its Kalender view instead of the table, so it shares this
 * load rather than repeating it.
 */
export async function loadTaskPageData() {
  const [tasks, members, deals, taskKinds, brands, googleStatus] = await Promise.all([
    api<Task[]>('/v1/tasks'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<TaskKind[]>('/v1/task-kinds').catch(() => [] as TaskKind[]),
    api<Brand[]>('/v1/brands').catch(() => [] as Brand[]),
    api<GoogleCalendarStatus>('/v1/google-calendar/status').catch(() => ({ connected: false, email: null })),
  ]);
  return { tasks, members, deals, taskKinds, brands, googleStatus };
}
