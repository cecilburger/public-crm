import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid } from '@kirana/core';
import { getIgBridgeConnection, setIgBridgeConnection, clearIgBridgeConnection } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * Pengaturan → Instagram: logs a tenant's Instagram account into
 * `apps/ig-bridge`'s Playwright-driven session by proxying the real
 * username/password through, once, over this request — kirana's own
 * database never stores the password, only the username (for display) and
 * whatever status the bridge last reported. Gated behind `channel:manage`,
 * same tier as the WhatsApp Web pairing and SMTP settings.
 *
 * Every call here is synchronous end-to-end (unlike the WhatsApp bridge's
 * webhook-fed QR flow) — Instagram's login either resolves or asks for a
 * challenge code within the one request, so there is no separate event
 * pipeline to keep in sync, just "call the bridge, mirror what it said".
 */
export function registerInstagramBridgeRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const bridgeCall = async <T>(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: T | null }> => {
    try {
      const res = await fetch(`${ctx.env.IG_BRIDGE_URL}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${ctx.env.IG_BRIDGE_SECRET}` },
      });
      const body = res.status === 204 ? null : await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body: body as T | null };
    } catch (err) {
      app.log.warn({ err, path }, 'ig-bridge service unreachable');
      return { ok: false, status: 502, body: null };
    }
  };

  type LoginResult =
    | { status: 'ready'; username: string }
    | { status: 'challenge_required'; challengeType: 'two_factor' | 'checkpoint' | 'unknown' }
    | { status: 'failed'; error: string };

  app.get('/v1/instagram-bridge/status', async (req) => {
    ctx.guard(req, 'channel:manage');
    return ctx.asTenant(req, (tx, actor) => getIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.post('/v1/instagram-bridge/login', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const body = z.object({
      username: z.string().min(1).max(120), password: z.string().min(1).max(200),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Isi username dan password Instagram');

    const call = await bridgeCall<LoginResult>(`/internal/sessions/${actor.tenantId}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: body.data.username, password: body.data.password }),
    });
    if (!call.ok || !call.body) {
      throw invalid('Layanan Instagram Bridge tidak bisa dihubungi — pastikan sudah dijalankan (npm run dev:ig-bridge)');
    }
    const result = call.body;

    await ctx.asTenant(req, (tx) => {
      if (result.status === 'ready') {
        return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'ready', username: result.username, challengeType: null, lastError: null, actorId: actor.userId,
        });
      }
      if (result.status === 'challenge_required') {
        return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'challenge_required', username: body.data.username,
          challengeType: result.challengeType, lastError: null, actorId: actor.userId,
        });
      }
      return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        status: 'error', username: undefined, challengeType: null,
        lastError: result.error, actorId: actor.userId,
      });
    });

    return result;
  });

  app.post('/v1/instagram-bridge/challenge', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const body = z.object({ code: z.string().min(1).max(20) }).safeParse(req.body);
    if (!body.success) throw invalid('Isi kode verifikasi');

    const call = await bridgeCall<LoginResult>(`/internal/sessions/${actor.tenantId}/challenge`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: body.data.code }),
    });
    if (!call.ok || !call.body) throw invalid('Layanan Instagram Bridge tidak bisa dihubungi');
    const result = call.body;

    await ctx.asTenant(req, (tx) => {
      if (result.status === 'ready') {
        return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'ready', challengeType: null, lastError: null, actorId: actor.userId,
        });
      }
      if (result.status === 'challenge_required') {
        return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          status: 'challenge_required', challengeType: result.challengeType,
          lastError: null, actorId: actor.userId,
        });
      }
      return setIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        status: 'error', challengeType: null, lastError: result.error, actorId: actor.userId,
      });
    });

    return result;
  });

  app.post('/v1/instagram-bridge/disconnect', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    await bridgeCall(`/internal/sessions/${actor.tenantId}`, { method: 'DELETE' });
    await ctx.asTenant(req, (tx) => clearIgBridgeConnection({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
      actorId: actor.userId,
    }));
    return { ok: true };
  });
}
