'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  connectInstagramBridge, connectInstagramBridgeWithCookie, submitInstagramChallenge,
  disconnectInstagramBridge, openInstagramLoginWindow,
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
/** How often the page re-reads status while a human is mid-login. Slow on
 * purpose: this only exists so the operator does not have to hit refresh, and
 * each poll reaches through to the bridge and the real browser behind it. */
const AWAITING_POLL_MS = 5_000;

export function InstagramBridgeForm({ connection }: { connection: IgBridgeConnection }) {
  const router = useRouter();
  const [step, setStep] = useState<'disconnected' | 'awaiting_login' | 'challenge_required' | 'ready'>(
    connection.status === 'ready' ? 'ready'
      : connection.status === 'challenge_required' ? 'challenge_required'
        : connection.status === 'awaiting_login' ? 'awaiting_login'
          : 'disconnected',
  );
  const [username, setUsername] = useState(connection.username ?? '');
  const [challengeType, setChallengeType] = useState(connection.challengeType);
  const [errorMsg, setErrorMsg] = useState<string | null>(connection.lastError);
  const [method, setMethod] = useState<'browser' | 'password' | 'cookie'>('browser');

  const [windowState, windowAction, windowPending] =
    useActionState<IgBridgeResult | null, FormData>(openInstagramLoginWindow, null);
  const [loginState, loginAction, loginPending] =
    useActionState<IgBridgeResult | null, FormData>(connectInstagramBridge, null);
  const [cookieState, cookieAction, cookiePending] =
    useActionState<IgBridgeResult | null, FormData>(connectInstagramBridgeWithCookie, null);
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
    if (!cookieState) return;
    if (cookieState.ok) {
      setErrorMsg(null);
      setStep('ready');
    } else {
      setErrorMsg(cookieState.error ?? t.instagramBridge.failed);
    }
  }, [cookieState]);

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
    if (!windowState) return;
    if (windowState.ok) {
      setErrorMsg(null);
      setStep('awaiting_login');
    } else {
      setErrorMsg(windowState.error ?? t.instagramBridge.failed);
    }
  }, [windowState]);

  // The window opens on whichever machine runs the bridge and is finished by a
  // person there, so nothing in this browser can be told when it lands.
  // Re-reading on a timer is what turns "click, then go and refresh" into
  // something an operator can just watch.
  // Also polled while connected-but-unnamed: the bridge recovers the handle on
  // its next status read, and this is what lets that land on screen by itself.
  const needsUsername = step === 'ready' && !username && !connection.username;
  useEffect(() => {
    if (step !== 'awaiting_login' && !needsUsername) return;
    const timer = setInterval(() => router.refresh(), AWAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [step, needsUsername, router]);

  useEffect(() => {
    if (connection.status === 'ready') { setStep('ready'); setErrorMsg(null); }
    else if (connection.status === 'error' && step === 'awaiting_login') {
      setStep('disconnected');
      setErrorMsg(connection.lastError);
    }
  }, [connection.status, connection.lastError, step]);

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
            {/* An empty handle is not something to render as "@" — that reads
                as a working connection to an account with no name. */}
            {(username || connection.username) ? (
              <p style={{ margin: 0, fontWeight: 600, color: 'var(--good)' }}>
                {t.instagramBridge.connectedAs(username || (connection.username ?? ''))}
              </p>
            ) : (
              <p className="error" style={{ margin: 0 }}>{t.instagramBridge.usernameMissing}</p>
            )}
            {/* Proof that the browser login really picked the three values up,
                so the operator does not have to take it on trust. `sessionid`
                stays masked: it is the credential itself, and the full value
                never leaves the bridge. */}
            {connection.captured ? (
              <div className="stack" style={{ gap: 4 }}>
                <p className="record-hint" style={{ margin: 0 }}>{t.instagramBridge.capturedTitle}</p>
                {([
                  ['sessionid', connection.captured.sessionIdMasked],
                  ['csrftoken', connection.captured.csrfToken],
                  ['ds_user_id', connection.captured.dsUserId],
                ] as const).map(([label, value]) => (
                  <p key={label} className="mono dim"
                     style={{ margin: 0, fontSize: 12, wordBreak: 'break-all' }}>
                    {label}: {value ?? '—'}
                  </p>
                ))}
              </div>
            ) : null}
            <form action={disconnectAction}>
              <CsrfField />
              <button type="submit" className="btn ghost" style={{ color: 'var(--danger)' }} disabled={disconnectPending}>
                {disconnectPending ? t.instagramBridge.disconnecting : t.instagramBridge.disconnect}
              </button>
            </form>
          </>
        ) : step === 'awaiting_login' ? (
          <>
            <p style={{ margin: 0, fontWeight: 600 }}>{t.instagramBridge.awaitingTitle}</p>
            <p className="record-hint" style={{ margin: 0 }}>{t.instagramBridge.awaitingBody}</p>
            {connection.bridgeReachable === false ? (
              <p className="error">{t.instagramBridge.bridgeUnreachable}</p>
            ) : null}
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
          <div className="stack" style={{ gap: 14 }}>
            <div className="record-field">
              <label htmlFor="ig-method">{t.instagramBridge.methodLabel}</label>
              <select className="line-input" id="ig-method" value={method}
                      onChange={(e) => { setMethod(e.target.value as 'browser' | 'password' | 'cookie'); setErrorMsg(null); }}>
                <option value="browser">{t.instagramBridge.methodBrowser}</option>
                <option value="password">{t.instagramBridge.methodPassword}</option>
                <option value="cookie">{t.instagramBridge.methodCookie}</option>
              </select>
            </div>

            {method === 'browser' ? (
              <form action={windowAction} className="stack" style={{ gap: 14 }}>
                <CsrfField />
                <p className="record-hint" style={{ margin: 0 }}>{t.instagramBridge.browserHint}</p>
                {errorMsg ? <p className="error">{errorMsg}</p> : null}
                <div>
                  <button type="submit" className="btn primary" disabled={windowPending}>
                    {windowPending ? t.instagramBridge.openingWindow : t.instagramBridge.loginWithBrowser}
                  </button>
                </div>
              </form>
            ) : method === 'password' ? (
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
            ) : (
              <form action={cookieAction} className="stack" style={{ gap: 14 }}>
                <CsrfField />
                <p className="record-hint" style={{ margin: 0 }}>{t.instagramBridge.cookieHint}</p>
                <details>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t.instagramBridge.cookieGuideTitle}</summary>
                  <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                    {t.instagramBridge.cookieGuideSteps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                </details>
                <div className="record-field">
                  <label htmlFor="ig-cookie-username">{t.instagramBridge.username}</label>
                  <input className="line-input" id="ig-cookie-username" name="username" autoComplete="off"
                         onChange={(e) => setUsername(e.target.value)}
                         placeholder={t.instagramBridge.usernamePlaceholder} />
                </div>
                <div className="record-field">
                  <label htmlFor="ig-sessionid">{t.instagramBridge.sessionId}</label>
                  <input className="line-input" id="ig-sessionid" name="sessionId" autoComplete="off"
                         placeholder={t.instagramBridge.sessionIdPlaceholder} />
                </div>
                <div className="record-field">
                  <label htmlFor="ig-csrftoken">{t.instagramBridge.csrfToken}</label>
                  <input className="line-input" id="ig-csrftoken" name="csrfToken" autoComplete="off" />
                </div>
                <div className="record-field">
                  <label htmlFor="ig-dsuserid">{t.instagramBridge.dsUserId}</label>
                  <input className="line-input" id="ig-dsuserid" name="dsUserId" autoComplete="off" />
                </div>
                {errorMsg ? <p className="error">{errorMsg}</p> : null}
                <div>
                  <button type="submit" className="btn primary" disabled={cookiePending}>
                    {cookiePending ? t.instagramBridge.connecting : t.instagramBridge.connect}
                  </button>
                </div>
              </form>
            )}
          </div>
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
