'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Brand, Member } from '@/lib/api';
import { ago, initials, num } from '@/lib/format';
import { t } from '@/lib/copy';
import { BrandRowActions } from '@/components/BrandRowActions';

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

export function BrandTable({ brands, members }: { brands: Brand[]; members: Member[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | Brand['status']>('all');
  const names = new Map(members.map((m) => [m.id, m.name]));

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const b of brands) c[b.status] = (c[b.status] ?? 0) + 1;
    return c;
  }, [brands]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return brands.filter((b) => {
      if (status !== 'all' && b.status !== status) return false;
      if (!q) return true;
      const haystack = [b.name, b.picName, b.phone, b.city, b.category].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [brands, query, status]);

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
          </div>
          <div className="odoo-cp-right">
            {TABS.map((tab) => (
              <button key={tab.key} type="button" className={`btn sm ${status === tab.key ? 'primary' : 'ghost'}`}
                      onClick={() => setStatus(tab.key)} aria-current={status === tab.key ? 'page' : undefined}>
                {tab.label}{tab.key !== 'all' && counts[tab.key] ? ` (${counts[tab.key]})` : ''}
              </button>
            ))}
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

        {filtered.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>
              {brands.length === 0 ? t.brand.noBrands : t.brand.noMatches}
            </p>
          </div>
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
