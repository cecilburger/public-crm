import { t } from '@/lib/copy';
import { ClientTable } from '@/components/ClientTable';
import { loadClientPageData, wonDealContactIds } from '../loadClientPageData';

export const dynamic = 'force-dynamic';

export default async function ClientDealPage() {
  const { contacts, conversationByContact, members, deals, taskKinds } = await loadClientPageData();
  const wonIds = wonDealContactIds(deals);
  const dealContacts = contacts.filter((c) => wonIds.has(c.id));

  return (
    <div className="scroll pad odoo-page stack">
      <ClientTable contacts={dealContacts} conversationByContact={conversationByContact}
                     members={members} deals={deals} taskKinds={taskKinds}
                     title={t.client.titleDeal} emptyMessage={t.client.noClientsDeal} />
    </div>
  );
}
