import { NextRequest, NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

/**
 * Kicks off the OAuth dance — asks the API for the consent URL (it, not this
 * app, holds the Google client id) and sends the browser there directly.
 * Any failure here (not configured, not logged in) lands back on Tugas with
 * an explanation instead of a bare framework error page.
 */
export async function GET(req: NextRequest) {
  const redirectUri = `${req.nextUrl.origin}/api/google-calendar/callback`;
  try {
    const { url } = await api<{ url: string }>(
      `/v1/google-calendar/authorize-url?redirectUri=${encodeURIComponent(redirectUri)}`,
    );
    return NextResponse.redirect(url);
  } catch (err) {
    const detail = err instanceof ApiError ? err.message : 'unknown';
    return NextResponse.redirect(
      new URL(`/tugas?gcal=error&detail=${encodeURIComponent(detail)}`, req.nextUrl.origin),
    );
  }
}
