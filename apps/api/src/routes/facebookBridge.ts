import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid } from '@kirana/core';
import {
  getFbBridgeConnection, setFbBridgeConnection, clearFbBridgeConnection,
  ensureMessengerBridgeChannel, listFacebookComments, type FbBridgeConnection,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * Pengaturan → Facebook: connects a tenant's Page to `apps/fb-bridge`.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT TAKE: a username, a password, a
 * session cookie, or any other credential. Unlike the Instagram bridge — which
 * proxies a real password through on its way to a login form — connecting
 * Facebook here only tells the bridge *which Page* to watch. The bridge then
 * opens a real browser window on the operator's machine and they log in by
 * hand, including any checkpoint or two-factor prompt. Nothing that could
 * authenticate as the account ever crosses this boundary or reaches this
 * database.
 *
 * That also makes the flow asynchronous, where Instagram's is synchronous: a
 * human login takes minutes, so `/connect` returns `awaiting_login` at once and
 * the console polls `/status`. Gated behind `channel:manage`, the same tier as
 * WhatsApp Web pairing and SMTP settings.
 *
 * Inbound only. There is no send route here and no `messenger_bridge` branch in
 * the outbound worker — a reply queued against this channel would fall through
 * to the Meta Graph path this whole feature exists to avoid.
 */
export function registerFacebookBridgeRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const bridgeCall = async <T>(path: string, init: RequestInit): Promise<{ ok: boolean; body: T | null }> => {
    try {
      const res = await fetch(`${ctx.env.FB_BRIDGE_URL}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${ctx.env.FB_BRIDGE_SECRET}` },
      });
      const body = res.status === 204 ? null : await res.json().catch(() => null);
      return { ok: res.ok, body: body as T | null };
    } catch (err) {
      app.log.warn({ err, path }, 'fb-bridge service unreachable');
      return { ok: false, body: null };
    }
  };

  interface BridgeState {
    status: FbBridgeConnection['status'];
    pageId: string | null;
    pageName: string | null;
    lastError: string | null;
  }

  /**
   * The bridge is the source of truth for session state — it is the only thing
   * that can see whether the Chromium profile still holds a live login. This
   * database row is a cache of what it last said, refreshed on every read so
   * the console shows the real state rather than the state at connect time.
   *
   * When the bridge cannot be reached, the cached row is returned as-is with
   * the failure attached rather than overwritten: "the bridge is down" and "the
   * session expired" are different problems with different fixes, and flatting
   * one into the other would send the operator to re-login for an outage.
   */
  app.get('/v1/facebook-bridge/status', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const stored = await ctx.asTenant(req, (tx) =>
      getFbBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }));

    const live = await bridgeCall<BridgeState>(`/internal/sessions/${actor.tenantId}/status`, { method: 'GET' });
    if (!live.ok || !live.body) {
      return {
        ...stored,
        bridgeReachable: false,
        lastError: stored.lastError
          ?? 'Layanan Facebook Bridge tidak bisa dihubungi — pastikan sudah dijalankan (npm run dev:fb-bridge)',
      };
    }

    if (live.body.status !== stored.status || live.body.lastError !== stored.lastError) {
      await ctx.asTenant(req, (tx) =>
        setFbBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: live.body!.status,
          lastError: live.body!.lastError,
          lastSeenAt: live.body!.status === 'ready' ? new Date() : null,
          actorId: actor.userId,
        }));
    }

    return { ...stored, ...live.body, bridgeReachable: true };
  });

  /**
   * Asks the bridge to open a login window for this tenant's Page.
   *
   * The channel row is created here, before the login has succeeded, on
   * purpose: the first message can arrive seconds after the operator finishes,
   * and the worker refuses to invent a channel for an event whose Page nobody
   * configured. Creating it up front with status 'connecting' means the very
   * first message lands correctly instead of failing once and needing a replay.
   */
  app.post('/v1/facebook-bridge/connect', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const body = z.object({
      pageId: z.string().min(1).max(120),
      pageName: z.string().min(1).max(200),
      /**
       * The Business Suite asset id, for a Page whose inbox lives there rather
       * than on messenger.com. Optional, and its absence is meaningful: a
       * connection without one is read as a personal account. Constrained to
       * digits because every Business Suite URL interpolates it, and a
       * malformed value produces a page that loads and holds nobody's
       * conversations.
       */
      assetId: z.string().regex(/^\d{6,}$/).max(40).optional(),
    }).safeParse(req.body);
    if (!body.success) {
      throw invalid('Isi ID dan nama Halaman Facebook yang mau dihubungkan');
    }

    const call = await bridgeCall<BridgeState>(`/internal/sessions/${actor.tenantId}/login-window`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body.data),
    });
    if (!call.ok || !call.body) {
      throw invalid('Layanan Facebook Bridge tidak bisa dihubungi — pastikan sudah dijalankan (npm run dev:fb-bridge)');
    }

    await ctx.asTenant(req, async (tx) => {
      await ensureMessengerBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        pageId: body.data.pageId, pageName: body.data.pageName,
        status: call.body!.status === 'ready' ? 'connected' : 'connecting',
      });
      await setFbBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        status: call.body!.status, pageId: body.data.pageId, pageName: body.data.pageName,
        // Written as null rather than left undefined when absent, so
        // reconnecting a Page as a personal account really does clear it. Left
        // undefined it would keep an asset id the operator just removed, and
        // the bridge would go on reading a Business Suite inbox.
        assetId: body.data.assetId ?? null,
        lastError: call.body!.lastError, actorId: actor.userId,
      });
    });

    return {
      ...call.body,
      // Said plainly because the window opens on whichever machine runs the
      // bridge, which is not necessarily the machine the operator is reading
      // this on — a detail that is otherwise confusing at exactly the wrong moment.
      instruction: 'Jendela browser sudah dibuka di mesin yang menjalankan fb-bridge. '
        + 'Selesaikan login Facebook di sana secara manual, termasuk 2FA atau checkpoint kalau diminta.',
    };
  });

  /** Deletes the stored browser profile on the bridge as well as clearing the
   * row here — a disconnect that left a live logged-in profile on disk would be
   * a lie about what was revoked. */
  app.post('/v1/facebook-bridge/disconnect', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    await bridgeCall(`/internal/sessions/${actor.tenantId}`, { method: 'DELETE' });
    await ctx.asTenant(req, (tx) =>
      clearFbBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { actorId: actor.userId }));
    return { ok: true };
  });

  /**
   * Inbound Page comments.
   *
   * Read-only, and there is deliberately no counterpart that replies, messages
   * the author, or moves them to another channel. Comments are not conversations
   * and this endpoint does not pretend otherwise.
   */
  app.get('/v1/facebook-bridge/comments', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      postId: z.string().max(120).optional(),
    }).safeParse(req.query);
    if (!query.success) throw invalid('Parameter tidak valid');

    const comments = await ctx.asTenant(req, (tx) =>
      listFacebookComments({ tx, tenantId: actor.tenantId, kek: ctx.kek }, query.data));
    return { comments };
  });
}
