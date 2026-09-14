'use client';

import { createPortal } from 'react-dom';
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

  // The manage ("⋮") menu is portalled to `document.body` and positioned from
  // the button's own on-screen rect, same reasoning as `NotificationBell`:
  // this list lives in the rail, a narrow scrolling column, and an
  // absolutely-positioned menu anchored `right: 0` inside it either gets
  // clipped by the rail's `overflow-y: auto` (one axis can't scroll-clip
  // while the other stays visible) or, worse, lands over the wrong content
  // entirely since its "container" is the ⋮ button itself, not the rail.
  const [manageId, setManageId] = useState<string | null>(null);
  const [manageCoords, setManageCoords] = useState<{ top: number; left: number } | null>(null);
  const manageButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const manageMenuRef = useRef<HTMLDivElement>(null);

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
    setManageId(null);
    setDeleteChannelId(c.id);
    deleteDialogRef.current?.showModal();
  };

  const toggleManage = (channelId: string) => {
    if (manageId === channelId) {
      setManageId(null);
      return;
    }
    const btn = manageButtonRefs.current[channelId];
    if (btn) {
      const r = btn.getBoundingClientRect();
      setManageCoords({ top: r.bottom + 6, left: r.left });
    }
    setManageId(channelId);
  };

  useEffect(() => {
    if (!manageId) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (manageButtonRefs.current[manageId]?.contains(target)) return;
      if (manageMenuRef.current?.contains(target)) return;
      setManageId(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [manageId]);

  useEffect(() => {
    if (deleteState?.ok) {
      deleteDialogRef.current?.close();
      setDeleteChannelId(null);
    }
  }, [deleteState]);

  const manageChannel = channels.find((c) => c.id === manageId) ?? null;

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
            <button type="button" className="rail-sub-more" aria-label={t.waBridge.manage}
                    aria-expanded={manageId === c.id}
                    ref={(el) => { manageButtonRefs.current[c.id] = el; }}
                    onClick={() => toggleManage(c.id)}>
              ⋮
            </button>
          </div>
        );
      })}

      {manageId && manageChannel && manageCoords ? createPortal(
        <div className="dropdown-body vertical" ref={manageMenuRef}
             style={{ position: 'fixed', top: manageCoords.top, left: manageCoords.left, width: 176 }}>
          {manageChannel.status === 'disabled' ? (
            <form action={reconnectWaBridgeSession} onSubmit={() => setManageId(null)}>
              <CsrfField />
              <input type="hidden" name="channelId" value={manageChannel.id} />
              <button className="btn ghost sm" type="submit" style={{ width: '100%', justifyContent: 'flex-start' }}>
                {t.waBridge.reconnect}
              </button>
            </form>
          ) : (
            <form action={disconnectWaBridgeSession} onSubmit={() => setManageId(null)}>
              <CsrfField />
              <input type="hidden" name="channelId" value={manageChannel.id} />
              <button className="btn ghost sm" type="submit" style={{ width: '100%', justifyContent: 'flex-start' }}>
                {t.waBridge.disconnect}
              </button>
            </form>
          )}
          <button type="button" className="btn ghost sm" onClick={() => openDeleteConfirm(manageChannel)}
                  style={{ width: '100%', justifyContent: 'flex-start', color: 'var(--danger)' }}>
            {t.waBridge.delete}
          </button>
        </div>,
        document.body,
      ) : null}

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
