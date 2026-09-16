'use client';

import { useActionState } from 'react';
import { saveEmailSettings, type ActionResult } from '@/app/(app)/actions';
import { t } from '@/lib/copy';
import { CsrfField } from '@/components/Csrf';
import type { EmailSettings } from '@/lib/api';

/**
 * The SMTP connection string is a credential — never round-tripped back to
 * the browser once saved. The field always starts blank; leaving it blank on
 * submit keeps whatever is already stored, the same "blank means unchanged"
 * convention as an API key field.
 */
export function EmailSettingsForm({ settings }: { settings: EmailSettings }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(saveEmailSettings, null);

  return (
    <div className="panel">
      <header><h2>{t.emailSettings.title}</h2></header>
      <form action={formAction} className="body stack" style={{ gap: 14 }}>
        <CsrfField />
        <p className="muted" style={{ maxWidth: '62ch', lineHeight: 1.6, margin: 0 }}>{t.emailSettings.subtitle}</p>

        <div className="record-field">
          <label htmlFor="es-smtpUrl">{t.emailSettings.smtpUrl}</label>
          <input className="line-input" id="es-smtpUrl" name="smtpUrl" type="password" autoComplete="off"
                 placeholder={t.emailSettings.smtpUrlPlaceholder} />
          <p className="record-hint">{t.emailSettings.smtpUrlHint}</p>
          <p className="record-hint" style={settings.configured ? { color: 'var(--good)' } : undefined}>
            {settings.configured ? t.emailSettings.smtpUrlConfigured : t.emailSettings.smtpUrlNotConfigured}
          </p>
        </div>

        <div className="record-field">
          <label htmlFor="es-emailFrom">{t.emailSettings.emailFrom}</label>
          <input className="line-input" id="es-emailFrom" name="emailFrom"
                 defaultValue={settings.emailFrom ?? ''} placeholder={t.emailSettings.emailFromPlaceholder} />
        </div>

        {state?.error ? <p className="error">{state.error}</p> : null}
        {state?.ok ? <p style={{ fontSize: 12.5, color: 'var(--good)' }}>{t.emailSettings.saved}</p> : null}

        <div>
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? t.emailSettings.saving : t.emailSettings.save}
          </button>
        </div>

        {settings.updatedAt ? (
          <p className="mono dim" style={{ fontSize: 12 }}>
            {t.emailSettings.lastUpdated(new Date(settings.updatedAt).toLocaleString('id-ID'))}
          </p>
        ) : null}
      </form>
    </div>
  );
}
