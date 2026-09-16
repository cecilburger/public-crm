import { t } from '@/lib/copy';
import { ClientForm } from '@/components/ClientForm';

export default function NewClientPage() {
  return (
    <div className="scroll odoo-page stack">
      <ClientForm contact={null} />
    </div>
  );
}
