import { NextRequest, NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

/** Where `/api/google-calendar/callback` sends the browser back to once the
 * OAuth round-trip is done — Tugas and Kalender both link here (see
 * `TaskTable`'s own "Connect" button), and whichever one the person actually
 * clicked from is where they expect to land again, not always Tugas. Google
 * itself only ever redirects back to the fixed `redirectUri` registered for
 * this app, so this is carried across the trip in a cookie rather than as a
 * URL param Google would need to echo back unchanged. */
const RETURN_COOKIE = 'kirana_gcal_return';

/**
 * Kicks off the OAuth dance — asks the API for the consent URL (it, not this
 * app, holds the Google client id) and sends the browser there directly.
 * Any failure here (not configured, not logged in) lands back on Tugas with
 * an explanation instead of a bare framework error page.
 */
export async function GET(req: NextRequest) {
  const redirectUri = `${req.nextUrl.origin}/api/google-calendar/callback`;
  // Only a same-app relative path is trusted here — `from` is a plain query
  // param, so anyone could craft a link with something else in it, and this
  // value gets redirected to unchecked once the OAuth trip completes.
  const fromParam = req.nextUrl.searchParams.get('from');
  const from = fromParam && fromParam.startsWith('/') && !fromParam.startsWith('//') ? fromParam : '/tugas';

  try {
    const { url } = await api<{ url: string }>(
      `/v1/google-calendar/authorize-url?redirectUri=${encodeURIComponent(redirectUri)}`,
    );
    const res = NextResponse.redirect(url);
    res.cookies.set(RETURN_COOKIE, from, { httpOnly: true, sameSite: 'lax', maxAge: 600, path: '/' });
    return res;
  } catch (err) {
    const detail = err instanceof ApiError ? err.message : 'unknown';
    return NextResponse.redirect(
      new URL(`${from}?gcal=error&detail=${encodeURIComponent(detail)}`, req.nextUrl.origin),
    );
  }
}
