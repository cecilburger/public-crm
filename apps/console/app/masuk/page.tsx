import { t } from '@/lib/copy';
import { csrfToken } from '@/lib/csrf';
import { withBase } from '@/lib/basePath';
import { fixedWorkspace } from '@/lib/signIn';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; workspace?: string; next?: string; reason?: string }>;
}) {
  const params = await searchParams;
  const csrf = await csrfToken();
  const message = params.error ?? (params.reason === 'expired' ? t.login.expired : null);
  const workspace = fixedWorkspace();

  return (
    <main className="login">
      <div className="card panel" style={{ boxShadow: 'var(--shadow)' }}>
        <div className="body">
          <div className="brand" style={{ padding: 0 }}>
            <img src={withBase('/logo.webp')} alt="" className="mark" />
            <span className="brand-name">{t.app.name}</span>
          </div>
          <div>
            <h1 style={{ fontSize: 19 }}>{t.login.title}</h1>
            <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>{t.login.subtitle}</p>
          </div>

          {message ? <p className="error" role="alert">{message}</p> : null}

          <form action={withBase('/api/session')} method="post" className="stack" style={{ gap: 12 }}>
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="next" value={params.next ?? '/obrolan'} />
            {workspace ? (
              <input type="hidden" name="workspace" value={workspace} />
            ) : (
              <div className="field">
                <label htmlFor="workspace">{t.login.shop}</label>
                <input className="input" id="workspace" name="workspace" required autoCapitalize="none"
                       spellCheck={false} defaultValue={params.workspace ?? ''} placeholder="toko-demo" />
                <span className="mono dim">{t.login.shopHint}</span>
              </div>
            )}
            <div className="field">
              <label htmlFor="email">{workspace ? t.login.username : t.login.email}</label>
              <input className="input" id="email" name="email" type={workspace ? 'text' : 'email'} required
                     autoComplete="username" autoCapitalize="none" spellCheck={false}
                     placeholder={workspace ? 'nama' : 'nama@tokoanda.id'} />
            </div>
            <div className="field">
              <label htmlFor="password">{t.login.password}</label>
              <input className="input" id="password" name="password" type="password" required
                     autoComplete="current-password" />
            </div>
            <button className="btn primary" type="submit" style={{ marginTop: 4 }}>{t.login.submit}</button>
          </form>

          {workspace ? null : (
            <p className="mono dim" style={{ borderTop: '1px solid var(--line)', paddingTop: 12, lineHeight: 1.7 }}>
              {t.login.demo}<br />toko-demo<br />rani@toko-demo.id<br />demo-password-1234
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
