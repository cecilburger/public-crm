'use client';

import { useMemo, useState } from 'react';
import type { MessageTemplate } from '@/lib/api';
import { t } from '@/lib/copy';
import { MessageTemplateDrawer } from '@/components/MessageTemplateDrawer';
import { MessageTemplateRowActions } from '@/components/MessageTemplateRowActions';

const CHANNEL_CHIP: Record<MessageTemplate['channel'], string> = {
  whatsapp: 'chip good', email: 'chip brand', other: 'chip',
};
const STATUS_CHIP: Record<MessageTemplate['status'], string> = {
  draft: 'chip', pending: 'chip warn', approved: 'chip good', rejected: 'chip danger',
};

/**
 * The Tugas-style table for Template Pesan — search + a "Tambah Template"
 * button that opens a slide-in drawer, same as the table replaced the old
 * per-row inline-editable-form layout.
 */
export function MessageTemplateTable({ templates }: { templates: MessageTemplate[] }) {
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<MessageTemplate | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((tpl) => [tpl.name, tpl.body].join(' ').toLowerCase().includes(q));
  }, [templates, query]);

  const openNew = () => { setEditing(null); setDrawerOpen(true); };
  const openEdit = (tpl: MessageTemplate) => { setEditing(tpl); setDrawerOpen(true); };

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.messageTemplate.title}</h1>
          </div>
          <div className="odoo-cp-search">
            <div className="search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input className="line-search-input" value={query} onChange={(e) => setQuery(e.target.value)}
                     placeholder={t.messageTemplate.searchPlaceholder} aria-label={t.messageTemplate.searchPlaceholder} />
            </div>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <button type="button" className="btn primary" onClick={openNew}>{t.messageTemplate.add}</button>
          </div>
          <div className="odoo-cp-right">
            <span className="dim tnum" style={{ fontSize: 12.5 }}>
              {filtered.length} {t.messageTemplate.title.toLowerCase()}
            </span>
          </div>
        </div>
      </div>

      <div className="main-content-area">
        {filtered.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>
              {templates.length === 0 ? t.messageTemplate.empty : t.messageTemplate.noMatches}
            </p>
          </div>
        ) : (
          <div className="panel" style={{ marginTop: 14, border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.messageTemplate.name}</th>
                  <th>{t.messageTemplate.channel}</th>
                  <th>{t.messageTemplate.category}</th>
                  <th>{t.messageTemplate.status}</th>
                  <th>{t.messageTemplate.language}</th>
                  <th style={{ textAlign: 'center' }}>{t.messageTemplate.actions}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tpl) => (
                  <tr key={tpl.id}>
                    <td>
                      <button type="button" onClick={() => openEdit(tpl)}
                              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer', fontWeight: 600 }}>
                        {tpl.name}
                      </button>
                    </td>
                    <td><span className={CHANNEL_CHIP[tpl.channel]}>{t.messageTemplate.channelLabel[tpl.channel]}</span></td>
                    <td className="dim">{tpl.channel === 'whatsapp' ? t.messageTemplate.categoryLabel[tpl.category] : '—'}</td>
                    <td>
                      {tpl.channel === 'whatsapp'
                        ? <span className={STATUS_CHIP[tpl.status]}>{t.messageTemplate.statusLabel[tpl.status]}</span>
                        : <span className="dim">—</span>}
                    </td>
                    <td className="mono dim">{tpl.language}</td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                        <button type="button" className="btn ghost sm" onClick={() => openEdit(tpl)}>
                          {t.messageTemplate.detail}
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => openEdit(tpl)}>
                          {t.messageTemplate.edit}
                        </button>
                        <MessageTemplateRowActions template={tpl} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <MessageTemplateDrawer open={drawerOpen} template={editing} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
