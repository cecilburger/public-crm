import { NextResponse, type NextRequest } from 'next/server';
import { call, ApiError } from '@/lib/api';
import { AT, RT, WS, MFA, cookieOptions } from '@/lib/session';
import { CSRF } from '@/lib/csrf';
import { t } from '@/lib/copy';

interface SessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * The second half of sign-in. The receipt from step one sits in its own
 * short-lived httpOnly cookie, so the page never handles it and it cannot be
 * replayed from a browser history entry.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const code = String(form.get('code') ?? '').trim();
  const workspace = req.cookies.get(WS)?.value ?? String(form.get('workspace') ?? '');
  const mfaToken = req.cookies.get(MFA)?.value;

  const back = (message: string) => {
    const url = new URL('/masuk/kode', req.url);
    url.searchParams.set('error', message);
    return NextResponse.redirect(url, { status: 303 });
  };

  const expected = req.cookies.get(CSRF)?.value;
  if (!expected || String(form.get('csrf') ?? '') !== expected) return back(t.login.stale);
  if (!mfaToken || !workspace) {
    return NextResponse.redirect(new URL('/masuk?reason=expired', req.url), { status: 303 });
  }
  if (!code) return back(t.security.codeWrong);

  try {
    const session = await call<SessionResponse>('/v1/auth/mfa/verify', {
      method: 'POST',
      body: { workspace, mfaToken, code },
    });

    const res = NextResponse.redirect(new URL('/obrolan', req.url), { status: 303 });
    res.cookies.set(AT, session.accessToken, { ...cookieOptions, maxAge: session.expiresIn });
    res.cookies.set(RT, session.refreshToken, { ...cookieOptions, maxAge: 60 * 60 * 24 * 30 });
    res.cookies.delete(MFA);
    return res;
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) return back(t.login.tooMany);
    if (err instanceof ApiError && err.status === 401) return back(t.security.codeWrong);
    return back(t.login.offline);
  }
}
