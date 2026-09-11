import { api, type Member } from '@/lib/api';
import { BrandForm } from '@/components/BrandForm';

export const dynamic = 'force-dynamic';

export default async function NewBrandPage() {
  const members = await api<Member[]>('/v1/members');

  return (
    <div className="scroll odoo-page stack">
      <BrandForm brand={null} members={members} />
    </div>
  );
}
