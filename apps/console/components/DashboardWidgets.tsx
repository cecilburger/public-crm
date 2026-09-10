import { num } from '@/lib/format';

const ARROW_UP = <path d="M12 19V5M5 12l7-7 7 7" />;
const ARROW_DOWN = <path d="M12 5v14M19 12l-7 7-7-7" />;

export function StatTile({
  label, value, delta, direction, tone,
}: {
  label: string;
  value: string;
  delta?: string;
  direction?: 'up' | 'down';
  tone?: 'good' | 'warn';
}) {
  return (
    <div className="panel stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value tnum">{value}</span>
      {delta ? (
        <span className={`stat-delta ${tone ?? 'good'}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            {direction === 'down' ? ARROW_DOWN : ARROW_UP}
          </svg>
          {delta}
        </span>
      ) : null}
    </div>
  );
}

export type BarItem = { label: string; value: number; display?: string; tone?: 'good' };

/** A ranked list of magnitudes — every value sits beside its bar as plain
 *  text, so nothing here depends on hover to be readable. */
export function BarList({ items }: { items: BarItem[] }) {
  const top = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="barlist">
      {items.map((item) => (
        <div className="bar-row" key={item.label}>
          <span className="bar-row-label">{item.label}</span>
          <span className={`bar-row-track ${item.tone === 'good' ? 'good' : ''}`}>
            <span className="bar-row-fill" style={{ width: `${Math.max((item.value / top) * 100, 4)}%` }} />
          </span>
          <span className="bar-row-value tnum">{item.display ?? num(item.value)}</span>
        </div>
      ))}
    </div>
  );
}
