import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound, meetingInviteEmail, resolveTenantSender } from '@kirana/core';
import {
  audit, getGoogleCalendarConnection, saveGoogleCalendarConnection,
  updateGoogleCalendarAccessToken, deleteGoogleCalendarConnection, getDecryptedSmtpUrl,
  type GoogleCalendarConnection, type Sql,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';
import {
  exchangeCodeForTokens, refreshAccessToken, fetchGoogleEmail, fetchGoogleEvents, revokeGoogleToken,
  GoogleAuthError,
} from '../googleCalendarClient.ts';

/**
 * Originally read-only (pulls a user's own primary Google Calendar into the
 * Tugas calendar view); now also used to create/update/cancel a meeting
 * task's own event on that same calendar — see `tasks.ts`. One connection
 * per user (not per tenant) either way — it's whoever's account granted
 * access, so only that person's events show up, and only their calendar
 * gets written to. Reuses `contact:read`/`contact:write` the same way Tugas
 * itself does, since this lives entirely inside that page.
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * A little slack before the real expiry so a request never races a token
 * that is about to die mid-flight. Shared by every caller that needs a
 * live access token for this user — the read-only events fetch here, and
 * the meeting-task Calendar writes in `tasks.ts` — so the refresh-and-
 * persist dance is written once.
 */
export async function getValidAccessToken(
  ctx: AppCtx, tx: Sql, actor: { tenantId: string; userId: string }, connection: GoogleCalendarConnection,
): Promise<string> {
  if (connection.expiresAt.getTime() >= Date.now() + 60_000) return connection.accessToken;
  if (!ctx.env.GOOGLE_CLIENT_ID || !ctx.env.GOOGLE_CLIENT_SECRET) {
    throw new GoogleAuthError('Google Calendar is not configured on this server yet');
  }
  const refreshed = await refreshAccessToken({
    clientId: ctx.env.GOOGLE_CLIENT_ID, clientSecret: ctx.env.GOOGLE_CLIENT_SECRET,
    refreshToken: connection.refreshToken,
  });
  await updateGoogleCalendarAccessToken({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
    userId: actor.userId, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt,
  });
  return refreshed.accessToken;
}

export function registerGoogleCalendarRoutes(app: FastifyInstance, ctx: AppCtx): void {
  // The console never holds the Google client id itself — it just asks for
  // the URL to send the browser to, so GOOGLE_CLIENT_ID/SECRET only need to
  // be configured in one place (this API's own env).
  app.get('/v1/google-calendar/authorize-url', async (req) => {
    ctx.guard(req, 'contact:read');
    const query = z.object({ redirectUri: z.string().url() }).safeParse(req.query);
    if (!query.success) throw invalid('Check the redirectUri');
    if (!ctx.env.GOOGLE_CLIENT_ID) throw invalid('Google Calendar is not configured on this server yet');

    const url = `${AUTH_URL}?${new URLSearchParams({
      client_id: ctx.env.GOOGLE_CLIENT_ID, redirect_uri: query.data.redirectUri, response_type: 'code',
      // `calendar.events` (read+write on events, not the broader `calendar`
      // scope) — needed since a connection here now also creates/updates/
      // cancels a meeting task's own event, not just displays the user's
      // existing ones. A connection made before this scope changed doesn't
      // retroactively gain it; that user has to reconnect once.
      scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email',
      access_type: 'offline', prompt: 'consent',
    })}`;
    return { url };
  });

  app.post('/v1/google-calendar/connect', async (req) => {
    const actor = ctx.guard(req, 'contact:write');
    const body = z.object({ code: z.string().min(1), redirectUri: z.string().url() }).safeParse(req.body);
    if (!body.success) throw invalid('Check the authorization code');
    if (!ctx.env.GOOGLE_CLIENT_ID || !ctx.env.GOOGLE_CLIENT_SECRET) {
      throw invalid('Google Calendar is not configured on this server yet');
    }

    let tokens;
    try {
      tokens = await exchangeCodeForTokens({
        clientId: ctx.env.GOOGLE_CLIENT_ID, clientSecret: ctx.env.GOOGLE_CLIENT_SECRET,
        code: body.data.code, redirectUri: body.data.redirectUri,
      });
    } catch (err) {
      if (err instanceof GoogleAuthError) throw invalid(err.message);
      throw err;
    }
    const email = await fetchGoogleEmail(tokens.accessToken);

    await ctx.asTenant(req, async (tx) => {
      await saveGoogleCalendarConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        userId: actor.userId,
        tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken!, expiresAt: tokens.expiresAt, email },
      });
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'google_calendar.connected',
        resourceType: 'user', resourceId: actor.userId, meta: { email },
      });
    });
    return { ok: true, email };
  });

  app.get('/v1/google-calendar/status', async (req) => {
    const actor = ctx.guard(req, 'contact:read');
    const connection = await ctx.asTenant(req, (tx) =>
      getGoogleCalendarConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { userId: actor.userId }));
    return { connected: connection !== null, email: connection?.googleEmail ?? null };
  });

  app.post('/v1/google-calendar/disconnect', async (req) => {
    const actor = ctx.guard(req, 'contact:write');
    const connection = await ctx.asTenant(req, (tx) =>
      getGoogleCalendarConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { userId: actor.userId }));
    if (connection) await revokeGoogleToken(connection.refreshToken);

    await ctx.asTenant(req, async (tx) => {
      await deleteGoogleCalendarConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { userId: actor.userId });
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'google_calendar.disconnected',
        resourceType: 'user', resourceId: actor.userId,
      });
    });
    return { ok: true };
  });

  app.get('/v1/google-calendar/events', async (req) => {
    const actor = ctx.guard(req, 'contact:read');
    const query = z.object({ from: z.string().datetime(), to: z.string().datetime() }).safeParse(req.query);
    if (!query.success) throw invalid('Check the from/to range');

    const connection = await ctx.asTenant(req, (tx) =>
      getGoogleCalendarConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { userId: actor.userId }));
    if (!connection) throw notFound('Google Calendar connection');
    if (!ctx.env.GOOGLE_CLIENT_ID || !ctx.env.GOOGLE_CLIENT_SECRET) {
      throw invalid('Google Calendar is not configured on this server yet');
    }

    const accessToken = await ctx.asTenant(req, (tx) => getValidAccessToken(ctx, tx, actor, connection));

    try {
      const events = await fetchGoogleEvents({ accessToken, timeMin: query.data.from, timeMax: query.data.to });
      return { events };
    } catch (err) {
      if (err instanceof GoogleAuthError) throw invalid('Could not reach Google Calendar — try reconnecting');
      throw err;
    }
  });

  /**
   * The "Kirim Email" action on a pulled-in Google Calendar event — these
   * aren't rows in this database (the integration is read-only), so the
   * console sends the event's own fields straight through rather than this
   * route looking one up by id the way the Task version does.
   */
  app.post('/v1/google-calendar/send-email', async (req) => {
    const actor = ctx.guard(req, 'contact:write');
    const body = z.object({
      to: z.string().email(),
      eventId: z.string().min(1),
      title: z.string().min(1).max(300),
      // An all-day event has no time component at all — Google hands back a
      // plain "2026-09-16" for those, not a full ISO datetime, so this takes
      // anything `Date` can parse rather than requiring `dateTime`'s strict
      // format and rejecting exactly the events that most need this button.
      start: z.string().refine((s) => !isNaN(new Date(s).getTime()), 'Invalid date'),
      meetingLink: z.string().url().nullable(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the meeting fields');

    const message = meetingInviteEmail({
      partyName: 'Anda', title: body.data.title, dueAt: new Date(body.data.start),
      meetingLink: body.data.meetingLink, notes: null, to: body.data.to,
    });

    const tenantEmail = await ctx.asTenant(req, (tx, a) => getDecryptedSmtpUrl({ tx, tenantId: a.tenantId, kek: ctx.kek }));
    const sender = resolveTenantSender(ctx.env, tenantEmail);

    let status: 'sent' | 'failed' = 'sent';
    let messageId: string | null = null;
    let sendError: string | null = null;
    try {
      messageId = (await sender.send(message)).messageId;
    } catch (err) {
      status = 'failed';
      sendError = err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
    }

    await ctx.asTenant(req, async (tx) => {
      await tx.query(
        `insert into emails (tenant_id, template, recipient, subject, reference, status, message_id, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [actor.tenantId, message.template, message.to, message.subject, `gcal:${body.data.eventId}`,
         status, messageId, sendError],
      );
      if (status === 'sent') {
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'google_calendar_event.email_sent',
          resourceType: 'google_calendar_event', resourceId: body.data.eventId, meta: { to: body.data.to },
        });
      }
    });

    if (status === 'failed') throw invalid(`Gagal mengirim email: ${sendError}`);
    return { ok: true };
  });
}
