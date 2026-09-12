import type { ContactOrder } from '@/lib/api';
import { rp, dateOnly } from '@/lib/format';
import { t } from '@/lib/copy';

const STATUS_CHIP: Record<ContactOrder['status'], string> = {
  draft: 'chip', awaiting_payment: 'chip warn', paid: 'chip brand',
  fulfilled: 'chip good', cancelled: 'chip danger',
};

/** How many times a customer has bought, and how much — the products themselves are in the list below. */
export function CustomerPurchases({ orders }: { orders: ContactOrder[] }) {
  const counted = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'draft');
  const totalIdr = counted.reduce((sum, o) => sum + o.totalIdr, 0);

  return (
    <div className="record-timeline">
      <h3>{t.customers.purchases.title}</h3>

      <div style={{ display: 'flex', gap: 24, margin: '4px 0 14px' }}>
        <div>
          <div className="dim" style={{ fontSize: 12 }}>{t.customers.purchases.count}</div>
          <div className="bignum" style={{ fontSize: 20 }}>{counted.length}</div>
        </div>
        <div>
          <div className="dim" style={{ fontSize: 12 }}>{t.customers.purchases.column}</div>
          <div className="bignum" style={{ fontSize: 20 }}>{rp(totalIdr)}</div>
        </div>
      </div>

      {orders.length === 0 ? (
        <p className="record-hint">{t.customers.purchases.empty}</p>
      ) : (
        <div className="timeline-list">
          {orders.map((o) => (
            <div key={o.id} className="timeline-row">
              <span className="timeline-dot" aria-hidden />
              <div className="timeline-body">
                <div className="timeline-head">
                  <b className="mono">{o.code}</b>
                  <span className={STATUS_CHIP[o.status]}>{t.orders.statusLabel[o.status] ?? o.status}</span>
                  <span className="mono dim" style={{ marginLeft: 'auto' }}>{dateOnly(o.createdAt)}</span>
                </div>
                <span className="dim" style={{ fontSize: 12.5 }}>
                  {o.lines.length > 0
                    ? o.lines.map((l) => `${l.title} ×${l.qty}`).join(', ')
                    : t.customers.purchases.itemsFallback}
                  {' · '}{rp(o.totalIdr)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
