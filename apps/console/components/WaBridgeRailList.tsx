'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  disconnectWaBridgeSession, deleteWaBridgeSession, reconnectWaBridgeSession, type ActionResult,
} from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { WaBridgeChannel } from '@/lib/api';

const LIVE = new Set(['ready', 'connected']);

export function WaBridgeRailList({ channels }: { channels: WaBridgeChannel[] }) {
  const [deleteState, deleteAction] = useActionState<ActionResult | null, FormData>(deleteWaBridgeSession, null);
  const [qrChannelId, setQrChannelId] = useState<string | null>(null);
  const [deleteChannelId, setDeleteChannelId] = useState<string | null>(null);
  const qrDialogRef = useRef<HTMLDialogElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  // Looked up fresh every render, not captured at click time — the QR image
  // rotates roughly every 20-45s while the modal is open, and this keeps it
  // in step with whatever `channels` the rail was last refreshed with.
  const qrChannel = channels.find((c) => c.id === qrChannelId) ?? null;
  const deleteChannel = channels.find((c) => c.id === deleteChannelId) ?? null;

  const openQr = (c: WaBridgeChannel) => {
    setQrChannelId(c.id);
    qrDialogRef.current?.showModal();
  };
  const openDeleteConfirm = (c: WaBridgeChannel) => {
    setDeleteChannelId(c.id);
    deleteDialogRef.current?.showModal();
  };

  useEffect(() => {
    if (deleteState?.ok) {
      deleteDialogRef.current?.close();
      setDeleteChannelId(null);
    }
  }, [deleteState]);

  // Every hook above must run on every render regardless of `channels` —
  // this is the earliest point an early return is safe.
  if (channels.length === 0) return null;

  return (
    <div className="rail-sub">
      {channels.map((c) => {
        const canShowQr = c.sessionStatus === 'qr_pending' && !!c.qrDataUrl;
        const dotClass = LIVE.has(c.sessionStatus) ? '' : c.sessionStatus === 'error' ? 'danger' : 'warn';
        return (
          <div key={c.id} className="rail-sub-item">
            {canShowQr ? (
              <button type="button" className="rail-sub-row" onClick={() => openQr(c)}>
                <span className={`dot ${dotClass}`} />
                <span className="rail-sub-label">{c.displayName}</span>
              </button>
            ) : (
              <span className="rail-sub-row">
                <span className={`dot ${dotClass}`} />
                <span className="rail-sub-label">{c.displayName}</span>
              </span>
            )}
            <details className="dropdown">
              <summary className="rail-sub-more" aria-label={t.waBridge.manage}>⋮</summary>
              <div className="dropdown-body" style={{ flexDirection: 'column', width: 176 }}>
                {c.status === 'disabled' ? (
                  <form action={reconnectWaBridgeSession}>
                    <CsrfField />
                    <input type="hidden" name="channelId" value={c.id} />
                    <button className="btn ghost sm" type="submit" style={{ width: '100%', justifyContent: 'flex-start' }}>
                      {t.waBridge.reconnect}
                    </button>
                  </form>
                ) : (
                  <form action={disconnectWaBridgeSession}>
                    <CsrfField />
                    <input type="hidden" name="channelId" value={c.id} />
                    <button className="btn ghost sm" type="submit" style={{ width: '100%', justifyContent: 'flex-start' }}>
                      {t.waBridge.disconnect}
                    </button>
                  </form>
                )}
                <button type="button" className="btn ghost sm" onClick={() => openDeleteConfirm(c)}
                        style={{ width: '100%', justifyContent: 'flex-start', color: 'var(--danger)' }}>
                  {t.waBridge.delete}
                </button>
              </div>
            </details>
          </div>
        );
      })}

      <dialog ref={qrDialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.waBridge.scanQr}</h2>
          <button type="button" className="btn ghost sm" onClick={() => qrDialogRef.current?.close()}>
            {t.waBridge.cancel}
          </button>
        </header>
        <div className="modal-body" style={{ alignItems: 'center', textAlign: 'center' }}>
          {qrChannel?.qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrChannel.qrDataUrl} alt={t.waBridge.scanQr} width={220} height={220}
                 style={{ borderRadius: 8, border: '1px solid var(--line)' }} />
          ) : null}
          <p className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>{t.waBridge.scanHow}</p>
        </div>
      </dialog>

      <dialog ref={deleteDialogRef} className="modal">
        <header className="modal-head">
          <h2>{t.waBridge.deleteTitle}</h2>
          <button type="button" className="btn ghost sm" onClick={() => deleteDialogRef.current?.close()}>
            {t.waBridge.cancel}
          </button>
        </header>
        <div className="modal-body">
          {deleteChannel ? (
            <div className="notice" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}>
              <span className="notice-icon" style={{ background: 'var(--danger)' }}>!</span>
              <span>{t.waBridge.deleteWarning(deleteChannel.displayName)}</span>
            </div>
          ) : null}
          {deleteState?.error ? <p className="error">{deleteState.error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => deleteDialogRef.current?.close()}>
              {t.waBridge.cancel}
            </button>
            <form action={deleteAction}>
              <CsrfField />
              <input type="hidden" name="channelId" value={deleteChannelId ?? ''} />
              <button className="btn primary" type="submit" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                {t.waBridge.deleteConfirm}
              </button>
            </form>
          </div>
        </div>
      </dialog>
    </div>
  );
}
