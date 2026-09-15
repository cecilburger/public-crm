import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import {
  audit, getGoogleCalendarConnection, saveGoogleCalendarConnection,
  updateGoogleCalendarAccessToken, deleteGoogleCalendarConnection,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';
import {
  exchangeCodeForTokens, refreshAccessToken, fetchGoogleEmail, fetchGoogleEvents, revokeGoogleToken,
  GoogleAuthError,
} from '../googleCalendarClient.ts';

/**
 * Read-only: pulls a user's own primary Google Calendar into the Tugas
 * calendar view. One connection per user (not per tenant) — it's whoever's
 * account granted access, so only that person's events show up for them.
 * Reuses `contact:read`/`contact:write` the same way Tugas itself does, since
 * this lives entirely inside that page.
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

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
      scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email',
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

    // A little slack before the real expiry so a request never races a token
    // that is about to die mid-flight.
    let accessToken = connection.accessToken;
    if (connection.expiresAt.getTime() < Date.now() + 60_000) {
      const refreshed = await refreshAccessToken({
        clientId: ctx.env.GOOGLE_CLIENT_ID, clientSecret: ctx.env.GOOGLE_CLIENT_SECRET,
        refreshToken: connection.refreshToken,
      });
      accessToken = refreshed.accessToken;
      await ctx.asTenant(req, (tx) =>
        updateGoogleCalendarAccessToken({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          userId: actor.userId, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt,
        }));
    }

    try {
      const events = await fetchGoogleEvents({ accessToken, timeMin: query.data.from, timeMax: query.data.to });
      return { events };
    } catch (err) {
      if (err instanceof GoogleAuthError) throw invalid('Could not reach Google Calendar — try reconnecting');
      throw err;
    }
  });
}
