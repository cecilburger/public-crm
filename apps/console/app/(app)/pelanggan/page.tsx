import { api, type Contact, type ConversationSummary } from '@/lib/api';
import { CustomerTable } from '@/components/CustomerTable';

export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  const [contacts, conversations] = await Promise.all([
    api<Contact[]>('/v1/contacts'),
    api<ConversationSummary[]>('/v1/conversations?limit=200'),
  ]);

  // Conversations come back newest-first, so the first one seen per contact
  // is the one worth linking to — a customer with two threads still gets a
  // single "Chat" link, and it goes to the live one.
  const conversationByContact: Record<string, string> = {};
  for (const c of conversations) {
    if (!(c.contact_id in conversationByContact)) conversationByContact[c.contact_id] = c.id;
  }

  return (
    <div className="scroll pad odoo-page stack">
      <CustomerTable contacts={contacts} conversationByContact={conversationByContact} />
    </div>
  );
}
