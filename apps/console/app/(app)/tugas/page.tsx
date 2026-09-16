import {
  api, type Task, type Member, type Deal, type TaskKind, type Brand, type GoogleCalendarStatus,
} from '@/lib/api';
import { TaskTable } from '@/components/TaskTable';
import { GcalNotice } from '@/components/GcalNotice';

export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: { searchParams: Promise<{ gcal?: string; detail?: string }> }) {
  const params = await searchParams;
  const [tasks, members, deals, taskKinds, brands, googleStatus] = await Promise.all([
    api<Task[]>('/v1/tasks'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<TaskKind[]>('/v1/task-kinds').catch(() => [] as TaskKind[]),
    api<Brand[]>('/v1/brands').catch(() => [] as Brand[]),
    api<GoogleCalendarStatus>('/v1/google-calendar/status').catch(() => ({ connected: false, email: null })),
  ]);

  return (
    <div className="scroll pad odoo-page stack">
      {params.gcal === 'connected' ? <GcalNotice variant="connected" /> : null}
      {params.gcal === 'error' ? <GcalNotice variant="error" detail={params.detail} /> : null}
      <TaskTable tasks={tasks} members={members} deals={deals} taskKinds={taskKinds}
                 brands={brands} googleStatus={googleStatus} />
    </div>
  );
}
