'use client';

import { useEffect, useState } from 'react';
import { getBroadcastDetail } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import type { Broadcast, BroadcastDetail } from '@/lib/api';

/** Opens on a broadcast's "Detail" action — fetches the per-recipient
 *  breakdown fresh each time, since it changes as sends land. */
export function BroadcastDetailDrawer({
  broadcast, open, onClose,
}: { broadcast: Broadcast | null; open: boolean; onClose: () => void }) {
  const [detail, setDetail] = useState<BroadcastDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!broadcast) { setDetail(null); return; }
    setLoading(true);
    setDetail(null);
    getBroadcastDetail(broadcast.id).then((d) => { setDetail(d); setLoading(false); });
  }, [broadcast]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!broadcast) return null;

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div className={`drawer-panel ${open ? 'open' : ''}`} role="dialog" aria-modal="true"
           aria-label={t.broadcast.detailTitle} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>{t.broadcast.detailTitle}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label={t.broadcast.close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="drawer-body">
          <div className="stack" style={{ gap: 4, marginBottom: 14 }}>
            <p><b>{broadcast.name}</b></p>
            <p className="dim" style={{ fontSize: 13 }}>{broadcast.templateName} · {broadcast.channelName}</p>
            <p className="dim" style={{ fontSize: 13 }}>{broadcast.sent}/{broadcast.total} · {t.broadcast.recipientStatusLabel.failed}: {broadcast.failed} · {t.broadcast.recipientStatusLabel.queued}: {broadcast.pending}</p>
          </div>

          {loading ? (
            <p className="dim" style={{ fontSize: 13 }}>…</p>
          ) : !detail || detail.recipients.length === 0 ? (
            <p className="empty">{t.broadcast.empty}</p>
          ) : (
            <table className="odoo-table">
              <thead>
                <tr>
                  <th>{t.broadcast.recipient}</th>
                  <th>{t.broadcast.recipientStatus}</th>
                </tr>
              </thead>
              <tbody>
                {detail.recipients.map((r) => (
                  <tr key={r.contactId}>
                    <td>{r.contactName ?? '—'}</td>
                    <td>
                      {t.broadcast.recipientStatusLabel[r.status] ?? r.status}
                      {r.skippedReason ? (
                        <span className="dim" style={{ fontSize: 12, marginLeft: 6 }}>
                          ({t.broadcast.skippedReasonLabel[r.skippedReason]})
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="drawer-foot">
          <button type="button" className="btn ghost" onClick={onClose}>{t.broadcast.close}</button>
        </div>
      </div>
    </>
  );
}
