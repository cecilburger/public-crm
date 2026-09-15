/**
 * Thin wrapper over Google's OAuth token endpoint and Calendar API — plain
 * `fetch`, the same way `waBridgeChannels.ts` talks to the bridge, rather than
 * pulling in the `googleapis` SDK for four endpoints.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

export class GoogleAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'GoogleAuthError'; }
}

/** The one-time trade of an authorization `code` for a token pair, right after the OAuth redirect lands back. */
export async function exchangeCodeForTokens(
  args: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<GoogleTokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: args.code, client_id: args.clientId, client_secret: args.clientSecret,
      redirect_uri: args.redirectUri, grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new GoogleAuthError(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
  if (!body.refresh_token) {
    // Google only issues one the first time an account grants this app
    // access — a re-consent without `prompt=consent` on the authorize step
    // would silently omit it, which is why that param is always sent.
    throw new GoogleAuthError('Google did not return a refresh token — re-authorize with consent prompted');
  }
  return {
    accessToken: body.access_token, refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}

/** A stored refresh token trading for a fresh access token — no new refresh token comes back from this call. */
export async function refreshAccessToken(
  args: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<GoogleTokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: args.refreshToken, client_id: args.clientId, client_secret: args.clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new GoogleAuthError(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { access_token: string; expires_in: number };
  return { accessToken: body.access_token, expiresAt: new Date(Date.now() + body.expires_in * 1000) };
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const body = await res.json() as { email?: string };
  return body.email ?? null;
}

export async function revokeGoogleToken(token: string): Promise<void> {
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
}

export interface GoogleCalendarEvent {
  id: string; title: string; start: string; end: string; allDay: boolean; htmlLink: string; meetingLink: string | null;
}

/** Google puts a Meet link on `hangoutLink` when one's attached; a non-Meet
 *  conferencing tool (Zoom, etc.) only shows up under `conferenceData`. */
function extractMeetingLink(e: {
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}): string | null {
  if (e.hangoutLink) return e.hangoutLink;
  const videoEntry = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video');
  return videoEntry?.uri ?? null;
}

export async function fetchGoogleEvents(
  args: { accessToken: string; timeMin: string; timeMax: string },
): Promise<GoogleCalendarEvent[]> {
  const url = `${EVENTS_URL}?${new URLSearchParams({
    timeMin: args.timeMin, timeMax: args.timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
  })}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${args.accessToken}` } });
  if (!res.ok) throw new GoogleAuthError(`Google Calendar events fetch failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as {
    items?: {
      id: string; summary?: string; htmlLink: string;
      start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string };
      hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
    }[];
  };
  return (body.items ?? []).map((e) => ({
    id: e.id, title: e.summary ?? '(Tanpa judul)', htmlLink: e.htmlLink,
    start: e.start.dateTime ?? e.start.date ?? args.timeMin,
    end: e.end.dateTime ?? e.end.date ?? args.timeMax,
    allDay: !e.start.dateTime,
    meetingLink: extractMeetingLink(e),
  }));
}
