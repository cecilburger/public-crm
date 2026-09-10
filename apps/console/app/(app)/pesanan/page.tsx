import { api, type Order } from '@/lib/api';
import { OrderTable } from '@/components/OrderTable';

export const dynamic = 'force-dynamic';

export default async function OrdersPage() {
  const orders = await api<Order[]>('/v1/orders');

  return (
    <div className="scroll pad odoo-page stack">
      <OrderTable orders={orders} />
    </div>
  );
}
