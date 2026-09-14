import { api, type Task, type Member, type Contact, type Deal, type TaskKind } from '@/lib/api';
import { TaskTable } from '@/components/TaskTable';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const [tasks, members, contacts, deals, taskKinds] = await Promise.all([
    api<Task[]>('/v1/tasks'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Contact[]>('/v1/contacts').catch(() => [] as Contact[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<TaskKind[]>('/v1/task-kinds').catch(() => [] as TaskKind[]),
  ]);

  return (
    <div className="scroll pad odoo-page stack">
      <TaskTable tasks={tasks} members={members} contacts={contacts} deals={deals} taskKinds={taskKinds} />
    </div>
  );
}
