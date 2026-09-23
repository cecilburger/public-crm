'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  connectFacebookBridge, disconnectFacebookBridge, type ActionResult, type FbBridgeResult,
} from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { FbBridgeConnection } from '@/lib/api';

const STATUS_LABEL: Record<FbBridgeConnection['status'], string> = {
  ready: t.facebookBridge.statusReady,
  awaiting_login: t.facebookBridge.statusAwaiting,
  checkpoint_required: t.facebookBridge.statusCheckpoint,
  error: t.facebookBridge.statusError,
  disconnected: t.facebookBridge.statusDisconnected,
};

const STATUS_COLOUR: Record<FbBridgeConnection['status'], string> = {
  ready: 'var(--good)',
  awaiting_login: 'var(--warn)',
  checkpoint_required: 'var(--warn)',
  error: 'var(--danger)',
  disconnected: 'var(--muted)',
};

/** How often the page re-reads status while a human is mid-login. Slow on
 * purpose: this only exists so the operator does not have to hit refresh, and
 * each poll reaches through to the bridge and the real browser behind it. */
const AWAITING_POLL_MS = 5_000;

/**
 * Unofficial by construction (see `apps/fb-bridge`), so the warning lives on
 * the page rather than only in a chat transcript.
 *
 * Two things this deliberately does not have: a password field, and a way to
 * send anything. No Facebook credential ever reaches the CRM — the operator
 * logs in themselves in a window the bridge opens — and the bridge is inbound
 * only, so there is no reply box to offer.
 */
export function FacebookBridgeForm({ connection }: { connection: FbBridgeConnection }) {
  const router = useRouter();
  const [connectState, connectAction, connectPending] =
    useActionState<FbBridgeResult | null, FormData>(connectFacebookBridge, null);
  const [disconnectState, disconnectAction, disconnectPending] =
    useActionState<ActionResult | null, FormData>(disconnectFacebookBridge, null);

  const status = connectState?.ok && connectState.status ? connectState.status : connection.status;
  const errorMsg = connectState?.ok === false
    ? connectState.error
    : disconnectState?.ok === false
      ? disconnectState.error
      : connection.lastError;

  // The login window opens on the bridge's machine and is finished by a person
  // there, so nothing in this browser can be told when it lands. Re-reading on
  // a timer is what turns "click connect, then go and refresh" into something
  // an operator can just watch.
  useEffect(() => {
    if (status !== 'awaiting_login') return;
    const timer = setInterval(() => router.refresh(), AWAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [status, router]);

  useEffect(() => {
    if (disconnectState?.ok || connectState?.ok) router.refresh();
  }, [disconnectState, connectState, router]);

  return (
    <div className="panel">
      <header><h2>{t.facebookBridge.sectionTitle}</h2></header>
      <div className="body stack" style={{ gap: 14 }}>
        <div className="notice" style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
          <span className="notice-icon" style={{ background: 'var(--warn)' }}>!</span>
          <span>{t.facebookBridge.subtitle}</span>
        </div>

        <p style={{ margin: 0 }}>
          <span className="dim">{t.facebookBridge.statusLabel}: </span>
          <strong style={{ color: STATUS_COLOUR[status] }}>{STATUS_LABEL[status]}</strong>
          {connection.pageName ? <span className="dim"> · {connection.pageName}</span> : null}
        </p>

        {connection.bridgeReachable === false ? (
          <p className="error">{t.facebookBridge.bridgeUnreachable}</p>
        ) : null}

        {status === 'ready' ? (
          <>
            <p style={{ margin: 0, fontWeight: 600, color: 'var(--good)' }}>
              {t.facebookBridge.connectedAs(connection.pageName ?? connection.pageId ?? '')}
            </p>
            <p className="record-hint" style={{ margin: 0 }}>{t.facebookBridge.inboundOnly}</p>
            <form action={disconnectAction}>
              <CsrfField />
              <button type="submit" className="btn ghost" style={{ color: 'var(--danger)' }} disabled={disconnectPending}>
                {disconnectPending ? t.facebookBridge.disconnecting : t.facebookBridge.disconnect}
              </button>
            </form>
          </>
        ) : status === 'awaiting_login' ? (
          <>
            <p style={{ margin: 0, fontWeight: 600 }}>{t.facebookBridge.awaitingTitle}</p>
            <p className="record-hint" style={{ margin: 0 }}>{t.facebookBridge.awaitingBody}</p>
          </>
        ) : (
          <form action={connectAction} className="stack" style={{ gap: 14 }}>
            <CsrfField />
            {status === 'checkpoint_required' ? (
              <>
                <p style={{ margin: 0, fontWeight: 600 }}>{t.facebookBridge.checkpointTitle}</p>
                <p className="record-hint" style={{ margin: 0 }}>{t.facebookBridge.checkpointBody}</p>
              </>
            ) : null}
            <div className="record-field">
              <label htmlFor="fb-page-id">{t.facebookBridge.pageId}</label>
              <input className="line-input" id="fb-page-id" name="pageId" autoComplete="off"
                     defaultValue={connection.pageId ?? ''}
                     placeholder={t.facebookBridge.pageIdPlaceholder} />
              <p className="record-hint" style={{ margin: 0 }}>{t.facebookBridge.pageIdHint}</p>
            </div>
            <div className="record-field">
              <label htmlFor="fb-page-name">{t.facebookBridge.pageName}</label>
              <input className="line-input" id="fb-page-name" name="pageName" autoComplete="off"
                     defaultValue={connection.pageName ?? ''}
                     placeholder={t.facebookBridge.pageNamePlaceholder} />
              <p className="record-hint" style={{ margin: 0 }}>{t.facebookBridge.pageNameHint}</p>
            </div>
            <div className="record-field">
              <label htmlFor="fb-asset-id">{t.facebookBridge.assetId}</label>
              <input className="line-input" id="fb-asset-id" name="assetId" autoComplete="off"
                     inputMode="numeric" pattern="[0-9]*"
                     defaultValue={connection.assetId ?? ''}
                     placeholder={t.facebookBridge.assetIdPlaceholder} />
              <p className="record-hint" style={{ margin: 0 }}>{t.facebookBridge.assetIdHint}</p>
            </div>
            {errorMsg ? <p className="error">{errorMsg}</p> : null}
            <div>
              <button type="submit" className="btn primary" disabled={connectPending}>
                {connectPending ? t.facebookBridge.connecting : t.facebookBridge.connect}
              </button>
            </div>
          </form>
        )}

        <p className="record-hint" style={{ margin: 0 }}>{t.facebookBridge.noCredentialNote}</p>

        {connection.updatedAt ? (
          <p className="mono dim" style={{ fontSize: 12 }}>
            {t.facebookBridge.lastUpdated(new Date(connection.updatedAt).toLocaleString('id-ID'))}
          </p>
        ) : null}
      </div>
    </div>
  );
}
