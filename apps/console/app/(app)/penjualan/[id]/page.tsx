import { redirect } from 'next/navigation';
import { api, ApiError, type DealDetailResponse, type Member } from '@/lib/api';
import { DealDetailView } from '@/components/DealDetailView';

export const dynamic = 'force-dynamic';

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data: DealDetailResponse;
  try {
    data = await api<DealDetailResponse>(`/v1/deals/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) redirect('/penjualan');
    throw err;
  }

  const members = await api<Member[]>('/v1/members').catch(() => [] as Member[]);

  return (
    <div className="scroll pad odoo-page stack">
      <DealDetailView data={data} members={members} />
    </div>
  );
}
