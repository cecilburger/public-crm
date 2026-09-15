'use client';

import { t } from '@/lib/copy';
import { BrandCard } from '@/components/BrandCard';
import type { Brand, Member } from '@/lib/api';

const COLUMNS: { key: Brand['status']; label: string }[] = [
  { key: 'not_contacted', label: t.brand.filterNotContacted },
  { key: 'contacted', label: t.brand.filterContacted },
  { key: 'replied', label: t.brand.filterReplied },
  { key: 'interested', label: t.brand.filterInterested },
  { key: 'rejected', label: t.brand.filterRejected },
];

/** One column per funnel stage, same shape as the Deal board — a brand
 *  moves by picking a stage on its card, not by dragging it. */
export function BrandKanban({ brands, members }: { brands: Brand[]; members: Member[] }) {
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const cards = brands.filter((b) => b.status === col.key);
        return (
          <section key={col.key} className={`column ${col.key === 'interested' ? 'won' : ''} ${col.key === 'rejected' ? 'lost' : ''}`}>
            <header>
              <h2>{col.label}</h2>
              <span className="n tnum">{cards.length}</span>
            </header>
            <div className="cards">
              {cards.length === 0 ? (
                <p className="dim" style={{ fontSize: 12, padding: '6px 2px' }}>{t.sales.empty}</p>
              ) : cards.map((brand) => <BrandCard key={brand.id} brand={brand} members={members} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
