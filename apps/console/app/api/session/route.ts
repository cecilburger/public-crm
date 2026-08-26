import { NextResponse, type NextRequest } from 'next/server';
import { call, ApiError } from '@/lib/api';
import { t } from '@/lib/copy';
import { AT, RT, WS, MFA, cookieOptions } from '@/lib/session';
import { CSRF } from '@/lib/csrf';

interface LoginResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  /** Set when the password was right but a second factor is switched on. */
  mfaRequired?: boolean;
  mfaToken?: string;
  user?: { id: string; name: string; role: string; tenantId: string };
}

/**
 * Sign-in exchange. The browser posts credentials here, the server posts them to
 * the API, and the tokens are written into httpOnly cookies — the page never
 * receives them.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const workspace = String(form.get('workspace') ?? '').trim();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const next = String(form.get('next') ?? '/obrolan');

  const back = (message: string) => {
    const url = new URL('/masuk', req.url);
    url.searchParams.set('error', message);
    url.searchParams.set('workspace', workspace);
    return NextResponse.redirect(url, { status: 303 });
  };

  if (!workspace || !email || !password) return back(t.login.incomplete);

  // Same double-submit check as the server actions: a cross-site form cannot
  // read the cookie, so it cannot produce a matching field.
  const expected = req.cookies.get(CSRF)?.value;
  const submitted = String(form.get('csrf') ?? '');
  if (!expected || submitted !== expected) return back(t.login.stale);

  try {
    const session = await call<LoginResponse>('/v1/auth/login', {
      method: 'POST',
      body: { workspace, email, password },
    });

    // Password accepted, but there is no session yet — hold the receipt in its
    // own short cookie and ask for the code.
    if (session.mfaRequired && session.mfaToken) {
      const res = NextResponse.redirect(new URL('/masuk/kode', req.url), { status: 303 });
      res.cookies.set(MFA, session.mfaToken, { ...cookieOptions, maxAge: 300 });
      res.cookies.set(WS, workspace, { ...cookieOptions, maxAge: 60 * 60 * 24 * 30 });
      return res;
    }
    if (!session.accessToken || !session.refreshToken) return back(t.login.offline);

    // Only same-origin paths, so a crafted ?next= cannot bounce a signed-in user
    // to somebody else's site with a fresh session.
    const target = next.startsWith('/') && !next.startsWith('//') ? next : '/obrolan';
    const res = NextResponse.redirect(new URL(target, req.url), { status: 303 });
    res.cookies.set(AT, session.accessToken, { ...cookieOptions, maxAge: session.expiresIn ?? 900 });
    res.cookies.set(RT, session.refreshToken, { ...cookieOptions, maxAge: 60 * 60 * 24 * 30 });
    res.cookies.set(WS, workspace, { ...cookieOptions, maxAge: 60 * 60 * 24 * 30 });
    return res;
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) return back(t.login.tooMany);
    if (err instanceof ApiError && err.status === 401) return back(t.login.wrong);
    return back(t.login.offline);
  }
}

export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(AT)?.value;
  if (token) {
    await call('/v1/auth/logout', { method: 'POST', token }).catch(() => undefined);
  }
  const res = NextResponse.json({ ok: true });
  for (const c of [AT, RT, WS]) res.cookies.delete(c);
  return res;
}
