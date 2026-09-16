import { api, type Member } from '@/lib/api';
import { BrandManagementForm } from '@/components/BrandManagementForm';

export const dynamic = 'force-dynamic';

export default async function NewManagedBrandPage() {
  const members = await api<Member[]>('/v1/members');

  return (
    <div className="scroll odoo-page stack">
      <BrandManagementForm brand={null} members={members} />
    </div>
  );
}
