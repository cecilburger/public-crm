import { redirect } from 'next/navigation';
import { api, ApiError, type Brand, type Member } from '@/lib/api';
import { BrandManagementForm } from '@/components/BrandManagementForm';

export const dynamic = 'force-dynamic';

export default async function ManagedBrandDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let brand: Brand;
  try {
    brand = await api<Brand>(`/v1/brands/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) redirect('/brand-management');
    throw err;
  }

  const members = await api<Member[]>('/v1/members');

  return (
    <div className="scroll odoo-page stack">
      <BrandManagementForm brand={brand} members={members} />
    </div>
  );
}
