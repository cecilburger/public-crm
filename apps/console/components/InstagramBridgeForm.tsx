'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  connectInstagramBridge, submitInstagramChallenge, disconnectInstagramBridge,
  type ActionResult, type IgBridgeResult,
} from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { IgBridgeConnection } from '@/lib/api';

const CHALLENGE_HINT: Record<NonNullable<IgBridgeConnection['challengeType']>, string> = {
  two_factor: t.instagramBridge.challengeHintTwoFactor,
  checkpoint: t.instagramBridge.challengeHintCheckpoint,
  unknown: t.instagramBridge.challengeHintUnknown,
};

/**
 * Unofficial by construction (see `apps/ig-bridge`) — the subtitle here
 * carries the risk warning directly on the page itself, not just in a chat
 * transcript, so whoever on the team opens this later sees it too.
 */
export function InstagramBridgeForm({ connection }: { connection: IgBridgeConnection }) {
  const [step, setStep] = useState<'disconnected' | 'challenge_required' | 'ready'>(
    connection.status === 'ready' ? 'ready' : connection.status === 'challenge_required' ? 'challenge_required' : 'disconnected',
  );
  const [username, setUsername] = useState(connection.username ?? '');
  const [challengeType, setChallengeType] = useState(connection.challengeType);
  const [errorMsg, setErrorMsg] = useState<string | null>(connection.lastError);

  const [loginState, loginAction, loginPending] =
    useActionState<IgBridgeResult | null, FormData>(connectInstagramBridge, null);
  const [challengeState, challengeAction, challengePending] =
    useActionState<IgBridgeResult | null, FormData>(submitInstagramChallenge, null);
  const [disconnectState, disconnectAction, disconnectPending] =
    useActionState<ActionResult | null, FormData>(disconnectInstagramBridge, null);

  useEffect(() => {
    if (!loginState) return;
    if (loginState.ok) {
      setErrorMsg(null);
      setStep(loginState.status === 'ready' ? 'ready' : 'challenge_required');
      if (loginState.challengeType) setChallengeType(loginState.challengeType);
    } else {
      setErrorMsg(loginState.error ?? t.instagramBridge.failed);
    }
  }, [loginState]);

  useEffect(() => {
    if (!challengeState) return;
    if (challengeState.ok) {
      setErrorMsg(null);
      setStep(challengeState.status === 'ready' ? 'ready' : 'challenge_required');
      if (challengeState.challengeType) setChallengeType(challengeState.challengeType);
    } else {
      setErrorMsg(challengeState.error ?? t.instagramBridge.failed);
    }
  }, [challengeState]);

  useEffect(() => {
    if (disconnectState?.ok) {
      setStep('disconnected');
      setUsername('');
      setChallengeType(null);
      setErrorMsg(null);
    }
  }, [disconnectState]);

  return (
    <div className="panel">
      <header><h2>{t.instagramBridge.sectionTitle}</h2></header>
      <div className="body stack" style={{ gap: 14 }}>
        <div className="notice" style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn)' }}>
          <span className="notice-icon" style={{ background: 'var(--warn)' }}>!</span>
          <span>{t.instagramBridge.subtitle}</span>
        </div>

        {step === 'ready' ? (
          <>
            <p style={{ margin: 0, fontWeight: 600, color: 'var(--good)' }}>
              {t.instagramBridge.connectedAs(username || (connection.username ?? ''))}
            </p>
            <form action={disconnectAction}>
              <CsrfField />
              <button type="submit" className="btn ghost" style={{ color: 'var(--danger)' }} disabled={disconnectPending}>
                {disconnectPending ? t.instagramBridge.disconnecting : t.instagramBridge.disconnect}
              </button>
            </form>
          </>
        ) : step === 'challenge_required' ? (
          <form action={challengeAction} className="stack" style={{ gap: 14 }}>
            <CsrfField />
            <p style={{ margin: 0, fontWeight: 600 }}>{t.instagramBridge.challengeTitle}</p>
            <p className="record-hint" style={{ margin: 0 }}>
              {challengeType ? CHALLENGE_HINT[challengeType] : t.instagramBridge.challengeHintUnknown}
            </p>
            <div className="record-field">
              <label htmlFor="ig-code">{t.instagramBridge.code}</label>
              <input className="line-input" id="ig-code" name="code" inputMode="numeric" autoComplete="one-time-code"
                     placeholder={t.instagramBridge.codePlaceholder} />
            </div>
            {errorMsg ? <p className="error">{errorMsg}</p> : null}
            <div>
              <button type="submit" className="btn primary" disabled={challengePending}>
                {challengePending ? t.instagramBridge.submittingCode : t.instagramBridge.submitCode}
              </button>
            </div>
          </form>
        ) : (
          <form action={loginAction} className="stack" style={{ gap: 14 }}>
            <CsrfField />
            <div className="record-field">
              <label htmlFor="ig-username">{t.instagramBridge.username}</label>
              <input className="line-input" id="ig-username" name="username" autoComplete="off"
                     onChange={(e) => setUsername(e.target.value)}
                     placeholder={t.instagramBridge.usernamePlaceholder} />
            </div>
            <div className="record-field">
              <label htmlFor="ig-password">{t.instagramBridge.password}</label>
              <input className="line-input" id="ig-password" name="password" type="password" autoComplete="off" />
            </div>
            {errorMsg ? <p className="error">{errorMsg}</p> : null}
            <div>
              <button type="submit" className="btn primary" disabled={loginPending}>
                {loginPending ? t.instagramBridge.connecting : t.instagramBridge.connect}
              </button>
            </div>
          </form>
        )}

        {connection.updatedAt ? (
          <p className="mono dim" style={{ fontSize: 12 }}>
            {t.instagramBridge.lastUpdated(new Date(connection.updatedAt).toLocaleString('id-ID'))}
          </p>
        ) : null}
      </div>
    </div>
  );
}
