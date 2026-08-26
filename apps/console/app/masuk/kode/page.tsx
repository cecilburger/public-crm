import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { t } from '@/lib/copy';
import { csrfToken } from '@/lib/csrf';
import { MFA } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function MfaCodePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const jar = await cookies();
  // No receipt means no half-finished sign-in to complete.
  if (!jar.get(MFA)) redirect('/masuk');
  const csrf = await csrfToken();

  return (
    <main className="login">
      <div className="card panel" style={{ boxShadow: 'var(--shadow)' }}>
        <div className="body">
          <div className="brand" style={{ padding: 0 }}>
            <span className="mark"><i /></span>{t.app.name}
          </div>
          <div>
            <h1 style={{ fontSize: 19 }}>{t.security.signInTitle}</h1>
            <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>{t.security.signInHelp}</p>
          </div>

          {params.error ? <p className="error" role="alert">{params.error}</p> : null}

          <form action="/api/session/mfa" method="post" className="stack" style={{ gap: 12 }}>
            <input type="hidden" name="csrf" value={csrf} />
            <div className="field">
              <label htmlFor="code">{t.security.codeLabel}</label>
              <input className="input" id="code" name="code" required autoFocus
                     inputMode="numeric" autoComplete="one-time-code"
                     placeholder="123456" style={{ fontSize: 20, letterSpacing: '.25em' }} />
            </div>
            <button className="btn primary" type="submit">{t.security.signInSubmit}</button>
          </form>

          <a href="/masuk" className="mono dim" style={{ textAlign: 'center' }}>{t.security.cancel}</a>
        </div>
      </div>
    </main>
  );
}
