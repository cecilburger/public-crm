import { redirect } from 'next/navigation';
import { api, ApiError, type Brand, type DealDetailResponse, type Member } from '@/lib/api';
import { DealDetailView } from '@/components/DealDetailView';

export const dynamic = 'force-dynamic';

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data: DealDetailResponse;
  try {
    data = await api<DealDetailResponse>(`/v1/deals/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) redirect('/deal');
    throw err;
  }

  const [members, brands] = await Promise.all([
    api<Member[]>('/v1/members').catch(() => [] as Member[]),
    api<Brand[]>('/v1/brands').catch(() => [] as Brand[]),
  ]);

  return (
    <div className="scroll pad odoo-page stack">
      <DealDetailView data={data} members={members} brands={brands} />
    </div>
  );
}
