import { api, type Contact, type ContactPurchaseSummary, type ConversationSummary } from '@/lib/api';
import { CustomerTable } from '@/components/CustomerTable';

export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  const [contacts, conversations, purchases] = await Promise.all([
    api<Contact[]>('/v1/contacts'),
    api<ConversationSummary[]>('/v1/conversations?limit=200'),
    api<ContactPurchaseSummary[]>('/v1/orders/purchases-by-contact').catch(() => [] as ContactPurchaseSummary[]),
  ]);

  // Conversations come back newest-first, so the first one seen per contact
  // is the one worth linking to — a customer with two threads still gets a
  // single "Chat" link, and it goes to the live one.
  const conversationByContact: Record<string, string> = {};
  for (const c of conversations) {
    if (!(c.contact_id in conversationByContact)) conversationByContact[c.contact_id] = c.id;
  }

  const purchasesByContact: Record<string, ContactPurchaseSummary> = {};
  for (const p of purchases) purchasesByContact[p.contactId] = p;

  return (
    <div className="scroll pad odoo-page stack">
      <CustomerTable contacts={contacts} conversationByContact={conversationByContact}
                     purchasesByContact={purchasesByContact} />
    </div>
  );
}
