import { api, type Contact, type Member, type Deal, type TaskKind } from '@/lib/api';
import { TaskForm } from '@/components/TaskForm';

export const dynamic = 'force-dynamic';

export default async function NewTaskPage() {
  const [contacts, members, deals, taskKinds] = await Promise.all([
    api<Contact[]>('/v1/contacts'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<TaskKind[]>('/v1/task-kinds').catch(() => [] as TaskKind[]),
  ]);

  return (
    <div className="scroll odoo-page stack">
      <TaskForm contacts={contacts} members={members} deals={deals} taskKinds={taskKinds} />
    </div>
  );
}
