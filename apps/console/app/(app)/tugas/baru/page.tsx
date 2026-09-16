import { api, type Brand, type Member, type Deal, type TaskKind } from '@/lib/api';
import { TaskForm } from '@/components/TaskForm';

export const dynamic = 'force-dynamic';

export default async function NewTaskPage() {
  const [members, deals, taskKinds, brands] = await Promise.all([
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<TaskKind[]>('/v1/task-kinds').catch(() => [] as TaskKind[]),
    api<Brand[]>('/v1/brands').catch(() => [] as Brand[]),
  ]);

  return (
    <div className="scroll odoo-page stack">
      <TaskForm members={members} deals={deals} taskKinds={taskKinds} brands={brands} />
    </div>
  );
}
