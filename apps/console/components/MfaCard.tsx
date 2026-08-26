'use client';

import { useActionState } from 'react';
import { startMfa, enableMfa, disableMfa, type ActionResult } from '@/app/(app)/actions';
import { CsrfField } from '@/components/Csrf';
import { t } from '@/lib/copy';

interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  backupCodesLeft: number;
  secret?: string;
  uri?: string;
}

interface MfaResult extends ActionResult {
  backupCodes?: string[];
}

/**
 * Enrolment in three visible steps, because a shop owner has not done this
 * before. The recovery codes are shown once and said so plainly — an MFA rollout
 * with no recovery path becomes a support queue full of locked-out owners.
 */
export function MfaCard({ status }: { status: MfaStatus }) {
  const [started, start, starting] = useActionState<ActionResult | null, FormData>(startMfa, null);
  const [enabled, enable, enabling] = useActionState<MfaResult | null, FormData>(enableMfa, null);
  const [disabled, disable, disabling] = useActionState<ActionResult | null, FormData>(disableMfa, null);

  if (enabled?.ok && enabled.backupCodes) {
    return (
      <div className="panel">
        <header><h2>{t.security.backupTitle}</h2></header>
        <div className="body">
          <p className="notice" style={{ marginBottom: 14 }}>
            <span className="notice-icon" aria-hidden>!</span>
            <span>{t.security.backupNote}</span>
          </p>
          <ul className="codes">
            {enabled.backupCodes.map((code) => <li key={code}>{code}</li>)}
          </ul>
        </div>
      </div>
    );
  }

  if (status.enabled) {
    return (
      <div className="panel">
        <header>
          <h2>{t.security.twoStep}</h2>
          <span className="chip good" style={{ marginLeft: 'auto' }}>{t.security.onNow}</span>
        </header>
        <form className="body" action={disable}>
          <CsrfField />
          <p className="muted" style={{ marginBottom: 12 }}>{t.security.backupLeft(status.backupCodesLeft)}</p>
          <div className="field" style={{ maxWidth: 220 }}>
            <label htmlFor="code">{t.security.turnOffHint}</label>
            <input className="input" id="code" name="code" required inputMode="numeric" placeholder="123456" />
          </div>
          {disabled?.error ? <p className="error" style={{ marginTop: 12 }}>{disabled.error}</p> : null}
          <button className="btn" type="submit" disabled={disabling} style={{ marginTop: 14 }}>
            {disabling ? t.security.working : t.security.turnOff}
          </button>
        </form>
      </div>
    );
  }

  if (status.pending && status.secret) {
    return (
      <div className="panel">
        <header><h2>{t.security.twoStep}</h2></header>
        <form className="body" action={enable}>
          <CsrfField />
          <p className="muted">{t.security.step1}</p>
          <div className="secret">
            <span className="mono dim">{t.security.secretLabel}</span>
            <code>{status.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </div>
          {status.uri ? (
            <p className="mono dim" style={{ marginTop: 8 }}>
              {t.security.orOpen}: <a href={status.uri}>otpauth://…</a>
            </p>
          ) : null}

          <p className="muted" style={{ marginTop: 18 }}>{t.security.step2}</p>
          <div className="field" style={{ maxWidth: 220, marginTop: 6 }}>
            <label htmlFor="code">{t.security.codeLabel}</label>
            <input className="input" id="code" name="code" required autoFocus inputMode="numeric"
                   placeholder="123456" style={{ fontSize: 18, letterSpacing: '.2em' }} />
          </div>
          {enabled?.error ? <p className="error" style={{ marginTop: 12 }}>{enabled.error}</p> : null}
          <button className="btn primary" type="submit" disabled={enabling} style={{ marginTop: 14 }}>
            {enabling ? t.security.working : t.security.confirm}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="panel">
      <header>
        <h2>{t.security.twoStep}</h2>
        <span className="chip warn" style={{ marginLeft: 'auto' }}>{t.security.offNow}</span>
      </header>
      <form className="body" action={start}>
        <CsrfField />
        <p className="muted" style={{ maxWidth: '62ch' }}>{t.security.why}</p>
        {started?.error ? <p className="error" style={{ marginTop: 12 }}>{started.error}</p> : null}
        <button className="btn primary" type="submit" disabled={starting} style={{ marginTop: 14 }}>
          {starting ? t.security.working : t.security.turnOn}
        </button>
      </form>
    </div>
  );
}
