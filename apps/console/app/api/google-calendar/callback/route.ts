import { NextRequest, NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';
import { withBase } from '@/lib/basePath';

// Kept in sync with the same constant in `../connect/route.ts` — set there
// right before handing off to Google, read (and cleared) here once it sends
// the browser back, so this lands on whichever page — Tugas or Kalender —
// the "Connect" button was actually clicked from.
const RETURN_COOKIE = 'kirana_gcal_return';

/** Google lands back here with `?code=...` (or `?error=...` if the user declined). */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const deniedByUser = req.nextUrl.searchParams.get('error');
  const redirectUri = `${req.nextUrl.origin}${withBase('/api/google-calendar/callback')}`;
  const returnTo = req.cookies.get(RETURN_COOKIE)?.value || '/tugas';

  const redirect = (query: string) => {
    const res = NextResponse.redirect(new URL(withBase(`${returnTo}${query}`), req.nextUrl.origin));
    res.cookies.delete(RETURN_COOKIE);
    return res;
  };

  if (!code || deniedByUser) return redirect('?gcal=cancelled');

  try {
    await api('/v1/google-calendar/connect', { method: 'POST', body: { code, redirectUri } });
    return redirect('?gcal=connected');
  } catch (err) {
    const detail = err instanceof ApiError ? err.message : 'unknown';
    return redirect(`?gcal=error&detail=${encodeURIComponent(detail)}`);
  }
}
