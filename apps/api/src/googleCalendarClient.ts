/**
 * Thin wrapper over Google's OAuth token endpoint and Calendar API — plain
 * `fetch`, the same way `waBridgeChannels.ts` talks to the bridge, rather than
 * pulling in the `googleapis` SDK for four endpoints.
 */
import { randomUUID } from 'node:crypto';

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

/** Thrown specifically for a 403 whose reason is an OAuth scope problem —
 * distinguished from any other Google API failure so a caller can tell
 * "this token genuinely can't do this" (surfaced as "reconnect Google
 * Calendar") apart from a transient/unexpected error. */
export class GoogleInsufficientScopeError extends GoogleAuthError {}

async function throwForFailedResponse(res: Response, action: string): Promise<never> {
  const text = await res.text();
  if (res.status === 403 && /insufficient|forbidden/i.test(text)) {
    throw new GoogleInsufficientScopeError(`Google Calendar ${action} failed: insufficient scope`);
  }
  throw new GoogleAuthError(`Google Calendar ${action} failed: ${res.status} ${text}`);
}

export interface InsertedGoogleEvent { id: string; htmlLink: string; meetingLink: string | null }

/** A Meet link only gets requested when nobody already gave the event one —
 * a contact who pasted their own Zoom/Meet URL keeps it; a blank field is
 * where Calendar's own "Add Google Meet video conferencing" default kicks
 * in. `conferenceDataVersion=1` is what tells the API to honor the request
 * at all — silently ignored without it. */
function conferenceRequestParams(hasOwnMeetingLink: boolean): { query: string; conferenceData?: unknown } {
  if (hasOwnMeetingLink) return { query: '' };
  return {
    query: '&conferenceDataVersion=1',
    conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
  };
}

/** One meeting task → one Google Calendar event, on the assignee's own
 * connected calendar. `attendeeEmail` is optional — a contact/brand with no
 * email on file still gets a real event, just nobody invited to it. */
export async function insertGoogleEvent(args: {
  accessToken: string; title: string; description: string | null;
  startsAt: Date; endsAt: Date; attendeeEmail: string | null; meetingLink: string | null;
}): Promise<InsertedGoogleEvent> {
  const conference = conferenceRequestParams(!!args.meetingLink);
  const res = await fetch(`${EVENTS_URL}?sendUpdates=all${conference.query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${args.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: args.title,
      description: args.description ?? undefined,
      start: { dateTime: args.startsAt.toISOString() },
      end: { dateTime: args.endsAt.toISOString() },
      attendees: args.attendeeEmail ? [{ email: args.attendeeEmail }] : undefined,
      conferenceData: conference.conferenceData,
    }),
  });
  if (!res.ok) await throwForFailedResponse(res, 'create');
  const body = await res.json() as {
    id: string; htmlLink: string; hangoutLink?: string;
    conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  };
  return { id: body.id, htmlLink: body.htmlLink, meetingLink: extractMeetingLink(body) };
}

/** Re-saving a meeting task's title/time onto its already-linked event —
 * called after `updateTask`, not before, so a failed Calendar write never
 * leaves the CRM's own copy stale. Also backfills a Meet link onto an event
 * that never got one (created before this existed, or while a link was
 * still blank) the same way a fresh insert would. */
export async function updateGoogleEvent(args: {
  accessToken: string; eventId: string; title: string; startsAt: Date; endsAt: Date; meetingLink: string | null;
}): Promise<{ meetingLink: string | null }> {
  const conference = conferenceRequestParams(!!args.meetingLink);
  const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(args.eventId)}?${conference.query.replace(/^&/, '')}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${args.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: args.title,
      start: { dateTime: args.startsAt.toISOString() },
      end: { dateTime: args.endsAt.toISOString() },
      conferenceData: conference.conferenceData,
    }),
  });
  // A 404 here means the event is already gone on Google's side (deleted by
  // hand, say) — nothing left to update, and not a reason to fail the task
  // edit that triggered this.
  if (!res.ok && res.status !== 404) await throwForFailedResponse(res, 'update');
  if (!res.ok) return { meetingLink: null };
  const body = await res.json() as {
    hangoutLink?: string;
    conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  };
  return { meetingLink: extractMeetingLink(body) };
}

/** Cancelling a meeting task removes its Calendar event too. A 404/410
 * (already gone) counts as success — the end state either way is "no event
 * left", which is what a delete is for. */
export async function deleteGoogleEvent(args: { accessToken: string; eventId: string }): Promise<void> {
  const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(args.eventId)}?sendUpdates=all`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${args.accessToken}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) await throwForFailedResponse(res, 'delete');
}
