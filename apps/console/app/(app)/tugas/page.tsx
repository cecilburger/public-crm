import { TaskTable } from '@/components/TaskTable';
import { GcalNotice } from '@/components/GcalNotice';
import { loadTaskPageData } from './loadTaskPageData';

export const dynamic = 'force-dynamic';

export default async function TasksPage({
  searchParams,
}: { searchParams: Promise<{ gcal?: string; detail?: string }> }) {
  const params = await searchParams;
  const { tasks, members, deals, taskKinds, brands, googleStatus } = await loadTaskPageData();

  return (
    <div className="scroll pad odoo-page stack">
      {params.gcal === 'connected' ? <GcalNotice variant="connected" /> : null}
      {params.gcal === 'error' ? <GcalNotice variant="error" detail={params.detail} /> : null}
      <TaskTable tasks={tasks} members={members} deals={deals} taskKinds={taskKinds}
                 brands={brands} googleStatus={googleStatus}
                 defaultView={params.gcal === 'connected' ? 'calendar' : 'table'} />
    </div>
  );
}
