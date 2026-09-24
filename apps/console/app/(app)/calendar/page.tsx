import { t } from '@/lib/copy';
import { TaskTable } from '@/components/TaskTable';
import { GcalNotice } from '@/components/GcalNotice';
import { DivisionBadge } from '@/components/DivisionBadge';
import { loadTaskPageData } from '../tugas/loadTaskPageData';

export const dynamic = 'force-dynamic';

/**
 * Same page as Tugas — same `TaskTable` (search, tabs, table/kanban/kalender
 * toggle, the Google Calendar connect button) — just opened straight to the
 * Kalender view instead of the table, for a menu whose whole point is the
 * calendar. The Google connection itself is shared with Tugas, not a
 * separate one: connecting from either page connects both.
 */
export default async function CalendarPage({
  searchParams,
}: { searchParams: Promise<{ gcal?: string; detail?: string }> }) {
  const params = await searchParams;
  const { tasks, members, deals, taskKinds, brands, googleStatus } = await loadTaskPageData();

  return (
    <div className="scroll pad odoo-page stack">
      {/* Which division's Google Calendar this is — each division connects its own. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><DivisionBadge /></div>
      {params.gcal === 'connected' ? <GcalNotice variant="connected" /> : null}
      {params.gcal === 'error' ? <GcalNotice variant="error" detail={params.detail} /> : null}
      <TaskTable tasks={tasks} members={members} deals={deals} taskKinds={taskKinds}
                 brands={brands} googleStatus={googleStatus}
                 title={t.nav.calendar} defaultView="calendar" variant="calendar" />
    </div>
  );
}
