import {
  api, type Task, type Member, type Contact, type Deal, type TaskKind, type GoogleCalendarStatus,
} from '@/lib/api';
import { TaskTable } from '@/components/TaskTable';
import { GcalNotice } from '@/components/GcalNotice';

export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: { searchParams: Promise<{ gcal?: string; detail?: string }> }) {
  const params = await searchParams;
  const [tasks, members, contacts, deals, taskKinds, googleStatus] = await Promise.all([
    api<Task[]>('/v1/tasks'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Contact[]>('/v1/contacts').catch(() => [] as Contact[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<TaskKind[]>('/v1/task-kinds').catch(() => [] as TaskKind[]),
    api<GoogleCalendarStatus>('/v1/google-calendar/status').catch(() => ({ connected: false, email: null })),
  ]);

  return (
    <div className="scroll pad odoo-page stack">
      {params.gcal === 'connected' ? <GcalNotice variant="connected" /> : null}
      {params.gcal === 'error' ? <GcalNotice variant="error" detail={params.detail} /> : null}
      <TaskTable tasks={tasks} members={members} contacts={contacts} deals={deals} taskKinds={taskKinds}
                 googleStatus={googleStatus} />
    </div>
  );
}
