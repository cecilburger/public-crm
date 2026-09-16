import { redirect } from 'next/navigation';
import { api, ApiError, type Brand, type Deal, type Member, type TaskKind } from '@/lib/api';
import { BrandForm } from '@/components/BrandForm';

export const dynamic = 'force-dynamic';

export default async function EditBrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let brand: Brand;
  try {
    brand = await api<Brand>(`/v1/brands/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) redirect('/brand');
    throw err;
  }

  const [members, deals, taskKinds] = await Promise.all([
    api<Member[]>('/v1/members'),
    api<Deal[]>('/v1/deals').catch(() => [] as Deal[]),
    api<TaskKind[]>('/v1/task-kinds').catch(() => [] as TaskKind[]),
  ]);

  return (
    <div className="scroll odoo-page stack">
      <BrandForm brand={brand} members={members} deals={deals} taskKinds={taskKinds} />
    </div>
  );
}
