import { api, type Brand, type Member } from '@/lib/api';
import { BrandTable } from '@/components/BrandTable';

export const dynamic = 'force-dynamic';

export default async function BrandPage() {
  const [brands, members] = await Promise.all([
    api<Brand[]>('/v1/brands'),
    api<Member[]>('/v1/members'),
  ]);

  return (
    <div className="scroll pad odoo-page stack">
      <BrandTable brands={brands} members={members} />
    </div>
  );
}
