import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, conflict } from '@kirana/core';
import {
  getIgMetaConnection, setIgMetaConnection, setIgMetaError, clearIgMetaConnection, ensureInstagramChannel, audit,
  channelHome,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

const IG_GRAPH_URL = 'https://graph.instagram.com';

type GraphError = { error_message?: string; error?: { message?: string } };

/**
 * Instagram via Meta's official Graph API — no OAuth dance here. A tenant
 * generates a long-lived (~60 day) access token by hand from their Meta App
 * dashboard ("API setup with Instagram Login" > "Generate access tokens")
 * and pastes it in; this route's only job is to verify that token actually
 * works and find out which account it belongs to before storing it. Simpler
 * and more reliable than a full OAuth/Business Login setup for the common
 * case this app is built for — one tenant, one Instagram account they
 * already control — at the cost of the tenant re-pasting a fresh token
 * roughly every two months. The unofficial alternative is `apps/ig-bridge`
 * (Playwright); this is the sanctioned path.
 */
export function registerInstagramMetaRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const parseGraphResponse = async <T>(res: Response): Promise<T> => {
    const raw = await res.text();
    let body: (T & GraphError) | null;
    try {
      body = JSON.parse(raw) as T & GraphError;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const fallback = raw.trim() ? raw.slice(0, 200) : `Instagram API error (${res.status})`;
      throw new Error(body?.error_message ?? body?.error?.message ?? fallback);
    }
    if (!body) throw new Error(`Instagram API returned an unexpected response (${res.status})`);
    return body;
  };

  app.get('/v1/instagram-meta/status', async (req) => {
    ctx.guard(req, 'channel:manage');
    return ctx.asTenant(req, (tx, actor) => getIgMetaConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.post('/v1/instagram-meta/connect', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const body = z.object({ accessToken: z.string().min(1).max(500) }).safeParse(req.body);
    if (!body.success) throw invalid('Tempel token yang valid');

    let me: { user_id: string; username: string };
    try {
      me = await parseGraphResponse<{ user_id: string; username: string }>(
        await fetch(`${IG_GRAPH_URL}/me?${new URLSearchParams({
          fields: 'user_id,username', access_token: body.data.accessToken,
        })}`),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal memverifikasi token Instagram';
      await ctx.asTenant(req, (tx) => setIgMetaError({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        error: message.slice(0, 500), actorId: actor.userId,
      }));
      throw invalid(message);
    }

    // An account is unique across the whole system (`channels_provider_key`):
    // one that another division — or tenant — already holds is refused here,
    // before the channel upsert could move it or trip over a row that
    // row-level security hides from this division.
    const home = await channelHome(ctx.control, 'instagram', me.user_id);
    if (home && (home.tenantId !== actor.tenantId || home.divisionId !== actor.divisionId)) {
      throw conflict('Akun Instagram ini sudah terhubung di divisi lain — putuskan di sana dulu');
    }

    try {
      await ctx.asTenant(req, async (tx) => {
        await setIgMetaConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          accessToken: body.data.accessToken, igUserId: me.user_id, igUsername: me.username, actorId: actor.userId,
        });
        const channel = await ensureInstagramChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          igUserId: me.user_id, igUsername: me.username,
        });
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'channel.connected',
          resourceType: 'channel', resourceId: channel.channelId, meta: { kind: 'instagram' },
        });
      });
      return { ok: true, igUsername: me.username };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal memverifikasi token Instagram';
      await ctx.asTenant(req, (tx) => setIgMetaError({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        error: message.slice(0, 500), actorId: actor.userId,
      }));
      throw invalid(message);
    }
  });

  app.post('/v1/instagram-meta/disconnect', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    await ctx.asTenant(req, (tx) => clearIgMetaConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
      actorId: actor.userId,
    }));
    return { ok: true };
  });
}
