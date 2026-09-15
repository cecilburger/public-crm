'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Brand, Contact, Deal, Member, Stage } from '@/lib/api';
import { rp } from '@/lib/format';
import { t } from '@/lib/copy';
import { DealCard } from '@/components/DealCard';
import { QuickAddDealDrawer } from '@/components/QuickAddDealDrawer';

function statusChip(deal: Deal): { cls: string; label: string } {
  if (deal.status === 'won') return { cls: 'chip good', label: t.sales.wonChip };
  if (deal.status === 'lost') return { cls: 'chip danger', label: t.sales.lostChip };
  const quiet = deal.rots_at !== null && new Date(deal.rots_at) < new Date();
  return quiet ? { cls: 'chip warn', label: t.sales.quietChip } : { cls: 'chip brand', label: t.dealDetail.openChip };
}

/**
 * How healthy a column looks at a glance, same idea as Odoo's kanban health
 * bar: green for the open deals still on track, amber for the ones that have
 * gone quiet, solid green for a Won stage and grey for Lost — a stage with
 * nothing in it yet reads as green (nothing wrong) rather than empty-grey.
 */
function columnProgress(stage: Stage, cards: Deal[]): { good: number; warn: number; muted: number } {
  if (stage.is_lost) return { good: 0, warn: 0, muted: 100 };
  if (stage.is_won || cards.length === 0) return { good: 100, warn: 0, muted: 0 };
  const quiet = cards.filter((d) => d.rots_at !== null && new Date(d.rots_at) < new Date()).length;
  const warn = Math.round((quiet / cards.length) * 100);
  return { good: 100 - warn, warn, muted: 0 };
}

/** The Trello board and a flat table over the same deals — one toggle, same data. */
export function DealBoard({
  deals, stages, members, contacts, brands, conversationByContact,
}: {
  deals: Deal[]; stages: Stage[]; members: Member[]; contacts: Contact[]; brands: Brand[];
  conversationByContact: Record<string, string>;
}) {
  const [viewMode, setViewMode] = useState<'kanban' | 'list'>('list');
  const [addStageId, setAddStageId] = useState<string | null>(null);

  const addStageName = stages.find((s) => s.id === addStageId)?.name ?? '';

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
            const progress = columnProgress(stage, cards);
            return (
              <section key={stage.id} className={`column ${stage.is_won ? 'won' : ''} ${stage.is_lost ? 'lost' : ''}`}>
                <header>
                  <h2>{stage.name}</h2>
                  <span className="n tnum">{cards.length}</span>
                  <button type="button" className="column-add" onClick={() => setAddStageId(stage.id)}
                          aria-label={t.sales.add} title={t.sales.add}>+</button>
                </header>
                <div className="column-progress">
                  <span className="seg-good" style={{ width: `${progress.good}%` }} />
                  <span className="seg-warn" style={{ width: `${progress.warn}%` }} />
                  <span className="seg-muted" style={{ width: `${progress.muted}%` }} />
                </div>
                <div className="cards">
                  {value > 0 ? <span className="mono dim" style={{ padding: '0 2px 2px' }}>{rp(value)}</span> : null}
                  {cards.length === 0
                    ? <p className="dim" style={{ fontSize: 12, padding: '6px 2px' }}>{t.sales.empty}</p>
                    : cards.map((deal) => (
                        <DealCard key={deal.id} deal={deal} stages={stages} members={members}
                                  conversationId={conversationByContact[deal.contact_id]} />
                      ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : deals.length === 0 ? (
        <div className="empty" style={{ margin: 'auto' }}>
          <h2>{t.sales.noneYet}</h2>
          <p>{t.sales.noneYetHelp}</p>
        </div>
      ) : (
        <div className="scroll pad">
          <div className="panel" style={{ border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.sales.table.brand}</th>
                  <th>{t.sales.table.category}</th>
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
                        <Link href={`/deal/${deal.id}`}><b>{deal.brand_name ?? deal.title}</b></Link>
                      </td>
                      <td className="mono dim">{deal.brand_category ?? '—'}</td>
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

      <QuickAddDealDrawer stageId={addStageId} stageName={addStageName} contacts={contacts} brands={brands}
                          onClose={() => setAddStageId(null)} />
    </>
  );
}
