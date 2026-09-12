'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Deal, Stage } from '@/lib/api';
import { rp } from '@/lib/format';
import { t } from '@/lib/copy';
import { DealCard } from '@/components/DealCard';

function statusChip(deal: Deal): { cls: string; label: string } {
  if (deal.status === 'won') return { cls: 'chip good', label: t.sales.wonChip };
  if (deal.status === 'lost') return { cls: 'chip danger', label: t.sales.lostChip };
  const quiet = deal.rots_at !== null && new Date(deal.rots_at) < new Date();
  return quiet ? { cls: 'chip warn', label: t.sales.quietChip } : { cls: 'chip brand', label: t.dealDetail.openChip };
}

/** The Trello board and a flat table over the same deals — one toggle, same data. */
export function SalesBoard({ deals, stages }: { deals: Deal[]; stages: Stage[] }) {
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('list');

  if (deals.length === 0) {
    return (
      <div className="empty" style={{ margin: 'auto' }}>
        <h2>{t.sales.noneYet}</h2>
        <p>{t.sales.noneYetHelp}</p>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 18px 0' }}>
        <div className="odoo-view-switchers">
          <button className={`btn icon ${viewMode === 'kanban' ? 'active' : 'ghost'}`}
                  onClick={() => setViewMode('kanban')} aria-label="Kanban">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>
            </svg>
          </button>
          <button className={`btn icon ${viewMode === 'list' ? 'active' : 'ghost'}`}
                  onClick={() => setViewMode('list')} aria-label="List">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      {viewMode === 'kanban' ? (
        <div className="board">
          {stages.map((stage) => {
            const cards = deals.filter((d) => d.stage_id === stage.id);
            const value = cards.reduce((s, d) => s + Number(d.amount_idr), 0);
            return (
              <section key={stage.id} className={`column ${stage.is_won ? 'won' : ''} ${stage.is_lost ? 'lost' : ''}`}>
                <header>
                  <h2>{stage.name}</h2>
                  <span className="n tnum">{cards.length}</span>
                </header>
                <div className="cards">
                  {value > 0 ? <span className="mono dim" style={{ padding: '0 2px 2px' }}>{rp(value)}</span> : null}
                  {cards.length === 0
                    ? <p className="dim" style={{ fontSize: 12, padding: '6px 2px' }}>{t.sales.empty}</p>
                    : cards.map((deal) => <DealCard key={deal.id} deal={deal} stages={stages} />)}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="scroll pad">
          <div className="panel" style={{ border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.sales.table.title}</th>
                  <th>{t.sales.table.contact}</th>
                  <th>{t.sales.table.stage}</th>
                  <th className="num">{t.sales.table.amount}</th>
                  <th>{t.sales.table.status}</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((deal) => {
                  const chip = statusChip(deal);
                  return (
                    <tr key={deal.id}>
                      <td>
                        <Link href={`/penjualan/${deal.id}`}><b>{deal.title}</b></Link>
                      </td>
                      <td className="mono">{deal.contact_name ?? '—'}</td>
                      <td>{deal.stage}</td>
                      <td className="num">{rp(deal.amount_idr)}</td>
                      <td><span className={chip.cls}>{chip.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
