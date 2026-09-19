import { t } from '@/lib/copy';
import { ClientTable } from '@/components/ClientTable';
import { loadClientPageData, dealContacts } from '../loadClientPageData';

export const dynamic = 'force-dynamic';

export default async function ClientDealPage() {
  const { contacts, conversationByContact, meetingByContact } = await loadClientPageData();

  return (
    <div className="scroll pad odoo-page stack">
      <ClientTable contacts={dealContacts(contacts)} conversationByContact={conversationByContact}
                     meetingByContact={meetingByContact}
                     title={t.client.titleDeal} emptyMessage={t.client.noClientsDeal} />
    </div>
  );
}
