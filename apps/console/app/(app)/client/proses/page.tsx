import { t } from '@/lib/copy';
import { ClientTable } from '@/components/ClientTable';
import { loadClientPageData, prosesContacts } from '../loadClientPageData';

export const dynamic = 'force-dynamic';

export default async function ClientProsesPage() {
  const { contacts, conversationByContact, meetingByContact } = await loadClientPageData();

  return (
    <div className="scroll pad odoo-page stack">
      <ClientTable contacts={prosesContacts(contacts)} conversationByContact={conversationByContact}
                     meetingByContact={meetingByContact}
                     title={t.client.titleProses} emptyMessage={t.client.noClientsProses} />
    </div>
  );
}
