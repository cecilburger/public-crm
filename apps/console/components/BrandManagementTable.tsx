'use client';

import Link from '@/components/FastLink';
import { useMemo, useState } from 'react';
import type { Brand, Member } from '@/lib/api';
import { initials } from '@/lib/format';
import { t } from '@/lib/copy';
import { BrandManagementRowActions } from '@/components/BrandManagementRowActions';
import { BrandImportDrawer } from '@/components/BrandImportDrawer';
import { exportBrandsToExcel } from '@/lib/brandExport';

/**
 * The Client-style table view of brand master data — plain search and a
 * flat table, no funnel kanban or status filters (that's what Tracker Brand
 * is for). Editing here goes through `BrandManagementForm`, which redirects
 * back to `/brand-management` rather than Tracker's `/brand`. Import opens
 * its own drawer from the navbar; export reuses Tracker's own helper
 * directly, no separate panel for either.
 */
export function BrandManagementTable({ brands, members }: { brands: Brand[]; members: Member[] }) {
  const [query, setQuery] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return brands;
    return brands.filter((b) =>
      [b.name, b.picName, b.phone, b.category, b.city].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [brands, query]);

  const handleExport = async () => {
    setExporting(true);
    try { await exportBrandsToExcel(brands, members); } finally { setExporting(false); }
  };

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.brandManagement.tableTitle}</h1>
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
            <Link href="/brand-management/baru" className="btn primary">{t.brand.add}</Link>
            <button type="button" className="btn ghost" onClick={() => setImportOpen(true)}>
              {t.brandManagement.importTitle}
            </button>
            <button type="button" className="btn ghost" onClick={() => void handleExport()}
                    disabled={exporting || brands.length === 0}>
              {exporting ? t.brand.exporting : t.brand.exportExcel}
            </button>
          </div>
          <div className="odoo-cp-right">
            <span className="dim tnum" style={{ fontSize: 12.5 }}>
              {filtered.length} {t.brandManagement.tableTitle.toLowerCase()}
            </span>
          </div>
        </div>
      </div>

      <div className="main-content-area">
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
                  <th>{t.brand.phone}</th>
                  <th>{t.brand.category}</th>
                  <th>{t.brand.city}</th>
                  <th>{t.brand.status}</th>
                  <th style={{ textAlign: 'center' }}>{t.brand.actions}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/brand-management/${b.id}`} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span className="avatar" aria-hidden>{initials(b.name)}</span>
                        <b>{b.name}</b>
                      </Link>
                    </td>
                    <td className="dim">{b.picName ?? '—'}</td>
                    <td className="mono">{b.phone ?? '—'}</td>
                    <td className="dim">{b.category ?? '—'}</td>
                    <td className="dim">{b.city ?? '—'}</td>
                    <td><span className="chip">{t.brand.statusLabel[b.status]}</span></td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                        <Link href={`/brand-management/${b.id}`} className="btn ghost sm">{t.brand.edit}</Link>
                        <BrandManagementRowActions brand={b} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <BrandImportDrawer open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
