'use client';

import { useState } from 'react';
import type { Broadcast, BroadcastChannel, MessageTemplate } from '@/lib/api';
import { t } from '@/lib/copy';
import { BroadcastDrawer } from '@/components/BroadcastDrawer';
import { BroadcastDetailDrawer } from '@/components/BroadcastDetailDrawer';

export function BroadcastTable({
  broadcasts, channels, templates,
}: { broadcasts: Broadcast[]; channels: BroadcastChannel[]; templates: MessageTemplate[] }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detail, setDetail] = useState<Broadcast | null>(null);

  return (
    <>
      <div className="odoo-control-panel">
        <div className="odoo-cp-top">
          <div className="odoo-cp-breadcrumb">
            <h1>{t.broadcast.title}</h1>
            <p className="subtitle">{t.broadcast.subtitle}</p>
          </div>
        </div>
        <div className="odoo-cp-bottom">
          <div className="odoo-cp-actions">
            <button type="button" className="btn primary" onClick={() => setDrawerOpen(true)}>{t.broadcast.add}</button>
          </div>
        </div>
      </div>

      <div className="main-content-area">
        {broadcasts.length === 0 ? (
          <div className="panel" style={{ marginTop: 14 }}>
            <p className="empty" style={{ padding: '24px 0' }}>{t.broadcast.empty}</p>
          </div>
        ) : (
          <div className="panel" style={{ marginTop: 14, border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.broadcast.name}</th>
                  <th>{t.broadcast.columnTemplate}</th>
                  <th>{t.broadcast.columnChannel}</th>
                  <th>{t.broadcast.columnProgress}</th>
                  <th>{t.broadcast.columnDate}</th>
                  <th style={{ textAlign: 'center' }}>{t.broadcast.detail}</th>
                </tr>
              </thead>
              <tbody>
                {broadcasts.map((b) => (
                  <tr key={b.id}>
                    <td><b>{b.name}</b></td>
                    <td>{b.templateName}</td>
                    <td>{b.channelName}</td>
                    <td className="tnum">{b.sent}/{b.total}</td>
                    <td>{new Date(b.createdAt).toLocaleDateString('id-ID')}</td>
                    <td style={{ textAlign: 'center' }}>
                      <button type="button" className="btn ghost sm" onClick={() => setDetail(b)}>
                        {t.broadcast.detail}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <BroadcastDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}
                       channels={channels} templates={templates} />
      <BroadcastDetailDrawer broadcast={detail} open={detail !== null} onClose={() => setDetail(null)} />
    </>
  );
}
