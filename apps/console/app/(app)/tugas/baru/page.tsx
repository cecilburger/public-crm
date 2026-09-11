import { api, type Contact, type Member, type Deal } from '@/lib/api';
import { TaskForm } from '@/components/TaskForm';

export const dynamic = 'force-dynamic';

export default async function NewTaskPage() {
  const [contacts, members, deals] = await Promise.all([
    api<Contact[]>('/v1/contacts'),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
  ]);

  return (
    <div className="scroll odoo-page stack">
      <TaskForm contacts={contacts} members={members} deals={deals} />
    </div>
  );
}
