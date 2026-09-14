import { redirect } from 'next/navigation';
import {
  api, ApiError, type ContactDetail, type ContactOrder, type ContactTimelineEvent, type ConversationSummary,
  type Member, type Task,
} from '@/lib/api';
import { CustomerForm } from '@/components/CustomerForm';

export const dynamic = 'force-dynamic';

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let contact: ContactDetail;
  try {
    contact = await api<ContactDetail>(`/v1/contacts/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) redirect('/pelanggan');
    throw err;
  }

  const [conversations, timeline, members, orders, tasks] = await Promise.all([
    // Newest first — if this customer has more than one thread, the Chat field
    // opens the live one.
    api<ConversationSummary[]>('/v1/conversations?limit=200'),
    api<ContactTimelineEvent[]>(`/v1/contacts/${id}/timeline`).catch(() => [] as ContactTimelineEvent[]),
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<ContactOrder[]>(`/v1/contacts/${id}/orders`).catch(() => [] as ContactOrder[]),
    // No `contactId` filter on the list endpoint — this page is the only
    // caller that needs one customer's tasks, so filtering here beats adding
    // a query param nothing else would use.
    api<Task[]>('/v1/tasks').catch(() => [] as Task[]),
  ]);
  const conversationId = conversations.find((c) => c.contact_id === id)?.id ?? null;
  const contactTasks = tasks.filter((tsk) => tsk.contactId === id);

  return (
    <div className="scroll odoo-page stack">
      <CustomerForm contact={contact} conversationId={conversationId} timeline={timeline} members={members}
                    orders={orders} tasks={contactTasks} />
    </div>
  );
}
