'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Brand, Member } from '@/lib/api';
import { ago, initials, num } from '@/lib/format';
import { t } from '@/lib/copy';
import { BrandRowActions } from '@/components/BrandRowActions';
import { BrandKanban } from '@/components/BrandKanban';
import { BrandChatLinks } from '@/components/BrandChatLinks';
import { exportBrandsToExcel } from '@/lib/brandExport';

const STATUS_CHIP: Record<Brand['status'], string> = {
  not_contacted: 'chip', contacted: 'chip warn', replied: 'chip brand',
  interested: 'chip good', rejected: 'chip danger',
};
const SOURCE_CHIP: Record<Brand['source'], string> = {
  scrape: 'chip brand', manual: 'chip', referral: 'chip good', other: 'chip',
};
const STATUSES: Brand['status'][] = ['not_contacted', 'contacted', 'replied', 'interested', 'rejected'];
const STATUS_DOT: Record<Brand['status'], string> = {
  not_contacted: 'var(--ink-3)', contacted: 'var(--warn)', replied: 'var(--brand)',
  interested: 'var(--good)', rejected: 'var(--danger)',
};

const TABS: { key: 'all' | Brand['status']; label: string }[] = [
  { key: 'all', label: t.brand.filterAll },
  { key: 'not_contacted', label: t.brand.filterNotContacted },
  { key: 'contacted', label: t.brand.filterContacted },
  { key: 'replied', label: t.brand.filterReplied },
  { key: 'interested', label: t.brand.filterInterested },
  { key: 'rejected', label: t.brand.filterRejected },
];

type ViewMode = 'table' | 'kanban';
type DateFilter = 'all' | 'today' | '7d' | '30d' | 'custom' | 'month' | 'year' | 'yearRange';

const DATE_TABS: { key: DateFilter; label: string }[] = [
  { key: 'all', label: t.brand.dateAll },
  { key: 'today', label: t.brand.dateToday },
  { key: '7d', label: t.brand.date7d },
  { key: '30d', label: t.brand.date30d },
  { key: 'custom', label: t.brand.dateCustom },
  { key: 'month', label: t.brand.dateMonth },
  { key: 'year', label: t.brand.dateYear },
  { key: 'yearRange', label: t.brand.dateYearRange },
];

interface DateFilterState {
  filter: DateFilter;
  customFrom: string; customTo: string;
  /** "YYYY-MM", straight out of an `<input type="month">`. */
  month: string;
  year: string;
  yearFrom: string; yearTo: string;
}

/** [start, end) — brand created at `t` matches when `start <= t < end`, either
 *  side left open (null) to mean unbounded. Presets always run through today. */
function dateFilterBounds(s: DateFilterState): { start: Date | null; end: Date | null } {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const startOfYear = (y: number) => new Date(y, 0, 1);

  switch (s.filter) {
    case 'today': return { start: startOfToday, end: startOfTomorrow };
    case '7d': return { start: new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000), end: startOfTomorrow };
    case '30d': return { start: new Date(startOfToday.getTime() - 29 * 24 * 60 * 60 * 1000), end: startOfTomorrow };
    case 'custom': return {
      start: s.customFrom ? new Date(s.customFrom) : null,
      // Inclusive of the whole "to" day, not just midnight at its start.
      end: s.customTo ? new Date(new Date(s.customTo).getTime() + 24 * 60 * 60 * 1000) : null,
    };
    case 'month': {
      if (!s.month) return { start: null, end: null };
      const [y, m] = s.month.split('-').map(Number);
      return { start: new Date(y!, m! - 1, 1), end: new Date(y!, m!, 1) };
    }
    case 'year': {
      if (!s.year) return { start: null, end: null };
      const y = Number(s.year);
      return { start: startOfYear(y), end: startOfYear(y + 1) };
    }
    case 'yearRange': return {
      start: s.yearFrom ? startOfYear(Number(s.yearFrom)) : null,
      end: s.yearTo ? startOfYear(Number(s.yearTo) + 1) : null,
    };
    case 'all': default: return { start: null, end: null };
  }
}

export function BrandTable({ brands, members }: { brands: Brand[]; members: Member[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | Brand['status']>('all');
  const [view, setView] = useState<ViewMode>('table');
  const [dateState, setDateState] = useState<DateFilterState>({
    filter: 'all', customFrom: '', customTo: '', month: '', year: '', yearFrom: '', yearTo: '',
  });
  const setDateFilter = (filter: DateFilter) => setDateState((s) => ({ ...s, filter }));
  const [exporting, setExporting] = useState(false);
  const names = new Map(members.map((m) => [m.id, m.name]));

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const b of brands) c[b.status] = (c[b.status] ?? 0) + 1;
    return c;
  }, [brands]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const { start, end } = dateFilterBounds(dateState);
    return brands.filter((b) => {
      if (status !== 'all' && b.status !== status) return false;
      if (start && new Date(b.createdAt) < start) return false;
      if (end && new Date(b.createdAt) >= end) return false;
      if (!q) return true;
      const haystack = [b.name, b.picName, b.phone, b.city, b.category].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [brands, query, status, dateState]);

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportBrandsToExcel(filtered, members);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.brand.title}</h1>
          </div>
          <div className="odoo-cp-search">
            <div className="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input className="line-search-input" value={query} onChange={(e) => setQuery(e.target.value)}
                     placeholder={t.brand.searchPlaceholder} aria-label={t.brand.searchPlaceholder} />
            </div>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <Link href="/brand/baru" className="btn primary">{t.brand.add}</Link>
            <button type="button" className="btn ghost" onClick={handleExport} disabled={exporting || filtered.length === 0}>
              {exporting ? t.brand.exporting : t.brand.exportExcel}
            </button>
          </div>
          <div className="odoo-cp-right">
            {TABS.map((tab) => (
              <button key={tab.key} type="button" className={`btn sm ${status === tab.key ? 'primary' : 'ghost'}`}
                      onClick={() => setStatus(tab.key)} aria-current={status === tab.key ? 'page' : undefined}>
                {tab.label}{tab.key !== 'all' && counts[tab.key] ? ` (${counts[tab.key]})` : ''}
              </button>
            ))}
            <div className="odoo-view-switchers">
              <button className={`btn icon ${view === 'table' ? 'active' : 'ghost'}`}
                      onClick={() => setView('table')} aria-label={t.tasks.viewTable}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              </button>
              <button className={`btn icon ${view === 'kanban' ? 'active' : 'ghost'}`}
                      onClick={() => setView('kanban')} aria-label={t.tasks.viewKanban}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="main-content-area">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginTop: 14 }}>
          {STATUSES.map((s) => (
            <button type="button" key={s} onClick={() => setStatus(status === s ? 'all' : s)}
                    className={`panel stat-tile stat-tile-btn ${status === s ? 'active' : ''}`}>
              <span className="stat-label">
                <span className="stat-dot" style={{ background: STATUS_DOT[s] }} aria-hidden />
                {t.brand.statusLabel[s]}
              </span>
              <span className="stat-value tnum">{num(counts[s] ?? 0)}</span>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          {DATE_TABS.map((d) => (
            <button key={d.key} type="button" className={`btn sm ${dateState.filter === d.key ? 'primary' : 'ghost'}`}
                    onClick={() => setDateFilter(d.key)} aria-current={dateState.filter === d.key ? 'page' : undefined}>
              {d.label}
            </button>
          ))}

          {dateState.filter === 'custom' ? (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <label className="mono dim" style={{ fontSize: 11 }} htmlFor="brand-date-from">{t.brand.dateFrom}</label>
              <input className="input" id="brand-date-from" type="date" value={dateState.customFrom}
                     onChange={(e) => setDateState((s) => ({ ...s, customFrom: e.target.value }))}
                     style={{ padding: '5px 7px', fontSize: 12.5 }} />
              <label className="mono dim" style={{ fontSize: 11 }} htmlFor="brand-date-to">{t.brand.dateTo}</label>
              <input className="input" id="brand-date-to" type="date" value={dateState.customTo}
                     onChange={(e) => setDateState((s) => ({ ...s, customTo: e.target.value }))}
                     style={{ padding: '5px 7px', fontSize: 12.5 }} />
            </span>
          ) : null}

          {dateState.filter === 'month' ? (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <label className="mono dim" style={{ fontSize: 11 }} htmlFor="brand-date-month">{t.brand.dateMonth}</label>
              <input className="input" id="brand-date-month" type="month" value={dateState.month}
                     onChange={(e) => setDateState((s) => ({ ...s, month: e.target.value }))}
                     style={{ padding: '5px 7px', fontSize: 12.5 }} />
            </span>
          ) : null}

          {dateState.filter === 'year' ? (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <label className="mono dim" style={{ fontSize: 11 }} htmlFor="brand-date-year">{t.brand.dateYear}</label>
              <input className="input" id="brand-date-year" type="number" placeholder="2026" value={dateState.year}
                     min={2000} max={2100}
                     onChange={(e) => setDateState((s) => ({ ...s, year: e.target.value }))}
                     style={{ padding: '5px 7px', fontSize: 12.5, width: 90 }} />
            </span>
          ) : null}

          {dateState.filter === 'yearRange' ? (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <label className="mono dim" style={{ fontSize: 11 }} htmlFor="brand-date-year-from">{t.brand.dateFrom}</label>
              <input className="input" id="brand-date-year-from" type="number" placeholder="2024" value={dateState.yearFrom}
                     min={2000} max={2100}
                     onChange={(e) => setDateState((s) => ({ ...s, yearFrom: e.target.value }))}
                     style={{ padding: '5px 7px', fontSize: 12.5, width: 90 }} />
              <label className="mono dim" style={{ fontSize: 11 }} htmlFor="brand-date-year-to">{t.brand.dateTo}</label>
              <input className="input" id="brand-date-year-to" type="number" placeholder="2026" value={dateState.yearTo}
                     min={2000} max={2100}
                     onChange={(e) => setDateState((s) => ({ ...s, yearTo: e.target.value }))}
                     style={{ padding: '5px 7px', fontSize: 12.5, width: 90 }} />
            </span>
          ) : null}
        </div>

        {filtered.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>
              {brands.length === 0 ? t.brand.noBrands : t.brand.noMatches}
            </p>
          </div>
        ) : view === 'kanban' ? (
          <div style={{ marginTop: 14 }}><BrandKanban brands={filtered} members={members} /></div>
        ) : (
          <div className="panel" style={{ marginTop: 14, border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.brand.name}</th>
                  <th>{t.brand.picName}</th>
                  <th>{t.brand.category}</th>
                  <th>{t.brand.source}</th>
                  <th>{t.brand.status}</th>
                  <th>{t.brand.assignee}</th>
                  <th className="num">{t.brand.lastContacted}</th>
                  <th style={{ textAlign: 'center' }}>{t.brand.chat}</th>
                  <th style={{ textAlign: 'center' }}>{t.brand.actions}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/brand/${b.id}`} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span className="avatar" aria-hidden>{initials(b.name)}</span>
                        <span>
                          <b>{b.name}</b>
                          {b.instagram ? <span className="mono dim" style={{ display: 'block', fontSize: 11 }}>{b.instagram}</span> : null}
                        </span>
                      </Link>
                    </td>
                    <td>
                      {b.picName ?? <span className="dim">—</span>}
                      {b.phone ? <span className="mono dim" style={{ display: 'block', fontSize: 11 }}>{b.phone}</span> : null}
                    </td>
                    <td>
                      {b.category ?? <span className="dim">—</span>}
                      {b.city ? <span className="dim" style={{ display: 'block', fontSize: 11 }}>{b.city}</span> : null}
                    </td>
                    <td><span className={SOURCE_CHIP[b.source]}>{t.brand.sourceLabel[b.source]}</span></td>
                    <td><span className={STATUS_CHIP[b.status]}>{t.brand.statusLabel[b.status]}</span></td>
                    <td>{b.assigneeId ? names.get(b.assigneeId) ?? '—' : <span className="dim">{t.brand.unassigned}</span>}</td>
                    <td className="num">{b.lastContactedAt ? ago(b.lastContactedAt) : <span className="dim">{t.brand.neverContacted}</span>}</td>
                    <td style={{ textAlign: 'center' }}><BrandChatLinks brand={b} /></td>
                    <td style={{ textAlign: 'center' }}><BrandRowActions brand={b} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
