import { t } from '@/lib/copy';
import { ClientTable } from '@/components/ClientTable';
import { loadClientPageData, withScheduledMeeting } from '../loadClientPageData';

export const dynamic = 'force-dynamic';

export default async function ClientProsesPage() {
  const { contacts, conversationByContact, members, deals, taskKinds } = await loadClientPageData();
  const prosesContacts = withScheduledMeeting(contacts);

  return (
    <div className="scroll pad odoo-page stack">
      <ClientTable contacts={prosesContacts} conversationByContact={conversationByContact}
                     members={members} deals={deals} taskKinds={taskKinds}
                     title={t.client.titleProses} emptyMessage={t.client.noClientsProses} />
    </div>
  );
}
