import { redirect } from 'next/navigation';
import { api, ApiError, type ContactDetail, type ConversationSummary } from '@/lib/api';
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

  // Newest first — if this customer has more than one thread, the Chat field
  // opens the live one.
  const conversations = await api<ConversationSummary[]>('/v1/conversations?limit=200');
  const conversationId = conversations.find((c) => c.contact_id === id)?.id ?? null;

  return (
    <div className="scroll odoo-page stack">
      <CustomerForm contact={contact} conversationId={conversationId} />
    </div>
  );
}
