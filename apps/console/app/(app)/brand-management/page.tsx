import { api, type Brand, type Member } from '@/lib/api';
import { BrandManagementTable } from '@/components/BrandManagementTable';

export const dynamic = 'force-dynamic';

export default async function BrandManagementPage() {
  const [brands, members] = await Promise.all([
    api<Brand[]>('/v1/brands'),
    api<Member[]>('/v1/members'),
  ]);

  return (
    <div className="scroll pad odoo-page stack">
      <BrandManagementTable brands={brands} members={members} />
    </div>
  );
}
