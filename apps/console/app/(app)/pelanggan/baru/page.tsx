import { t } from '@/lib/copy';
import { CustomerForm } from '@/components/CustomerForm';

export default function NewCustomerPage() {
  return (
    <div className="scroll odoo-page stack">
      <CustomerForm contact={null} />
    </div>
  );
}
