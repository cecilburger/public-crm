import { NextRequest, NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

/** Google lands back here with `?code=...` (or `?error=...` if the user declined). */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const deniedByUser = req.nextUrl.searchParams.get('error');
  const redirectUri = `${req.nextUrl.origin}/api/google-calendar/callback`;

  if (!code || deniedByUser) {
    return NextResponse.redirect(new URL('/tugas?gcal=cancelled', req.nextUrl.origin));
  }

  try {
    await api('/v1/google-calendar/connect', { method: 'POST', body: { code, redirectUri } });
    return NextResponse.redirect(new URL('/tugas?gcal=connected', req.nextUrl.origin));
  } catch (err) {
    const detail = err instanceof ApiError ? err.message : 'unknown';
    return NextResponse.redirect(
      new URL(`/tugas?gcal=error&detail=${encodeURIComponent(detail)}`, req.nextUrl.origin),
    );
  }
}
