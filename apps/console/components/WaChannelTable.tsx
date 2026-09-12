'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  disconnectWaBridgeSession, deleteWaBridgeSession, reconnectWaBridgeSession,
  saveWaBridgeMaxPerDay, type ActionResult,
} from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { WaBridgeChannel } from '@/lib/api';

const LIVE = new Set(['ready', 'connected']);

const CHAT_CHIP_CLASS: Record<keyof WaBridgeChannel['chat'], string> = {
  meeting: 'chip good', minat: 'chip warn', balas: 'chip accent', belum: 'chip', tolak: 'chip danger', bot: 'chip',
};

function totalChats(chat: WaBridgeChannel['chat']): number {
  return chat.meeting + chat.minat + chat.balas + chat.belum + chat.tolak + chat.bot;
}

/** One row's own form, same pattern as the message template and sales target
 * editors — an inline number field that saves itself, no modal. */
function MaxPerDayCell({ channel }: { channel: WaBridgeChannel }) {
  const [saved, save, saving] = useActionState<ActionResult | null, FormData>(saveWaBridgeMaxPerDay, null);

  return (
    <form action={save} style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <CsrfField />
      <input type="hidden" name="channelId" value={channel.id} />
      <span style={{ display: 'flex', gap: 6 }}>
        <input className="input" type="number" name="maxPerDay" min={0} defaultValue={channel.maxPerDay}
               style={{ width: 90 }} />
        <button className="btn ghost sm" type="submit" disabled={saving}>{t.waChannel.maxPerDaySave}</button>
      </span>
      {saved?.error ? <span className="dim" style={{ color: 'var(--danger)', fontSize: 11.5 }}>{saved.error}</span> : null}
    </form>
  );
}

function ChatCell({ chat }: { chat: WaBridgeChannel['chat'] }) {
  const order: (keyof WaBridgeChannel['chat'])[] = ['meeting', 'minat', 'balas', 'belum', 'tolak', 'bot'];
  return (
    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {order.map((key) => (
        <span key={key} className={CHAT_CHIP_CLASS[key]}>{t.waChannel.chatLabel[key]} {chat[key]}</span>
      ))}
    </span>
  );
}

/**
 * The same `wa_bridge_channels` the Chat WA rail manages, as a plain table
 * instead of a chat list — connect, disconnect or drop a number here and it
 * is the exact same connection Chat WA sees, not a second one to keep in sync.
 */
export function WaChannelTable({ channels }: { channels: WaBridgeChannel[] }) {
  const [deleteState, deleteAction] = useActionState<ActionResult | null, FormData>(deleteWaBridgeSession, null);
  const [qrChannelId, setQrChannelId] = useState<string | null>(null);
  const [deleteChannelId, setDeleteChannelId] = useState<string | null>(null);
  const qrDialogRef = useRef<HTMLDialogElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  // Looked up fresh every render, not captured at click time — the QR image
  // rotates while the modal is open, same reasoning as the Chat WA rail.
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

  if (channels.length === 0) {
    return (
      <div className="panel">
        <p className="empty" style={{ padding: '24px 0' }}>{t.waChannel.noChannels}</p>
      </div>
    );
  }

  return (
    <>
      <div className="panel" style={{ border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
        <table className="odoo-table">
          <thead>
            <tr>
              <th>{t.waChannel.name}</th>
              <th>{t.waChannel.phone}</th>
              <th>{t.waChannel.status}</th>
              <th>{t.waChannel.maxPerDay}</th>
              <th className="num">{t.waChannel.totalChats}</th>
              <th>{t.waChannel.chat}</th>
              <th style={{ textAlign: 'center' }}>{t.waChannel.actions}</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => {
              const canShowQr = c.sessionStatus === 'qr_pending' && !!c.qrDataUrl;
              const dotClass = LIVE.has(c.sessionStatus) ? 'good' : c.sessionStatus === 'error' ? 'danger' : 'warn';
              return (
                <tr key={c.id}>
                  <td><b>{c.displayName}</b></td>
                  <td className="mono">{c.phoneE164 ?? <span className="dim">{t.waChannel.noPhone}</span>}</td>
                  <td><span className={`chip ${dotClass}`}>{t.waBridge.status[c.sessionStatus] ?? c.sessionStatus}</span></td>
                  <td><MaxPerDayCell channel={c} /></td>
                  <td className="num"><b>{totalChats(c.chat)}</b></td>
                  <td><ChatCell chat={c.chat} /></td>
                  <td style={{ textAlign: 'center' }}>
                    <span style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                      {canShowQr ? (
                        <button type="button" className="btn ghost sm" onClick={() => openQr(c)}>
                          {t.waChannel.viewQr}
                        </button>
                      ) : null}
                      {c.status === 'disabled' ? (
                        <form action={reconnectWaBridgeSession}>
                          <CsrfField />
                          <input type="hidden" name="channelId" value={c.id} />
                          <button className="btn ghost sm" type="submit">{t.waBridge.reconnect}</button>
                        </form>
                      ) : (
                        <form action={disconnectWaBridgeSession}>
                          <CsrfField />
                          <input type="hidden" name="channelId" value={c.id} />
                          <button className="btn ghost sm" type="submit">{t.waBridge.disconnect}</button>
                        </form>
                      )}
                      <button type="button" className="btn ghost sm" style={{ color: 'var(--danger)' }}
                              onClick={() => openDeleteConfirm(c)}>
                        {t.waBridge.delete}
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
    </>
  );
}
