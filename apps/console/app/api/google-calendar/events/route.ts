import { NextRequest, NextResponse } from 'next/server';
import { api, ApiError, type GoogleCalendarEvent } from '@/lib/api';

/**
 * A thin proxy — the browser can't attach the session's (httpOnly) bearer
 * token itself, so `TaskCalendar`'s own client-side fetch comes through here
 * instead of hitting the API directly, same reasoning as `/api/search`.
 */
export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get('from');
  const to = req.nextUrl.searchParams.get('to');
  if (!from || !to) return NextResponse.json({ events: [] as GoogleCalendarEvent[] });

  try {
    const data = await api<{ events: GoogleCalendarEvent[] }>(
      `/v1/google-calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    return NextResponse.json(data);
  } catch (err) {
    // Not connected yet, or the token died — the calendar just shows nothing
    // Google-side rather than breaking the page.
    if (err instanceof ApiError) return NextResponse.json({ events: [] as GoogleCalendarEvent[] });
    throw err;
  }
}
