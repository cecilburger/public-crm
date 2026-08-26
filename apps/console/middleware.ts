import { NextResponse, type NextRequest } from 'next/server';

const AT = 'kirana_at';
const RT = 'kirana_rt';
const WS = 'kirana_ws';
const CSRF = 'kirana_csrf';
const API_URL = process.env.KIRANA_API_URL ?? 'http://127.0.0.1:8080';

/** exp only, unverified — the API is the thing that trusts the token. */
function expiry(jwt: string | undefined): number {
  if (!jwt) return 0;
  const part = jwt.split('.')[1];
  if (!part) return 0;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return ((JSON.parse(json) as { exp?: number }).exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

/**
 * One place where sessions are kept alive.
 *
 * Server components cannot set cookies during render, so token refresh has to
 * happen before the render starts. Middleware is that point: if the access token
 * is within a minute of expiring, it is rotated here and the new pair is written
 * onto the response the page is about to use.
 */
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const access = req.cookies.get(AT)?.value;
  const refresh = req.cookies.get(RT)?.value;
  const workspace = req.cookies.get(WS)?.value;

  // Every response carries a CSRF token, including the sign-in page — the form
  // that creates a session needs one too.
  const ensureCsrf = (res: NextResponse) => {
    if (!req.cookies.get(CSRF)) {
      const token = crypto.randomUUID().replace(/-/g, '');
      req.cookies.set(CSRF, token);
      res.cookies.set(CSRF, token, {
        httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/',
      });
    }
    return res;
  };

  // The second sign-in step has no session yet by definition — it is the step
  // that creates one.
  if (pathname === '/masuk/kode') return ensureCsrf(NextResponse.next());

  if (pathname === '/masuk') {
    if (access && expiry(access) > Date.now()) return NextResponse.redirect(new URL('/obrolan', req.url));
    return ensureCsrf(NextResponse.next());
  }

  const signIn = () => {
    const url = new URL('/masuk', req.url);
    if (pathname !== '/') url.searchParams.set('next', pathname + search);
    const res = NextResponse.redirect(url);
    for (const c of [AT, RT, WS]) res.cookies.delete(c);
    return res;
  };

  if (!refresh || !workspace) return signIn();
  if (access && expiry(access) - Date.now() > 60_000) return ensureCsrf(NextResponse.next());

  const res = await fetch(`${API_URL}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, refreshToken: refresh }),
    cache: 'no-store',
  }).catch(() => null);

  if (!res?.ok) return signIn();

  const tokens = await res.json() as { accessToken: string; refreshToken: string; expiresIn: number };
  const next = NextResponse.next();
  const options = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' };
  next.cookies.set(AT, tokens.accessToken, { ...options, maxAge: tokens.expiresIn });
  next.cookies.set(RT, tokens.refreshToken, { ...options, maxAge: 60 * 60 * 24 * 30 });
  return ensureCsrf(next);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/session).*)'],
};
