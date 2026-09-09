import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import {
  audit, createWaBridgeChannel, listWaBridgeChannels, disableWaBridgeChannel,
  deleteWaBridgeChannel, reconnectWaBridgeChannel,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * Pairing WhatsApp Web numbers is channel administration, not chat handling —
 * gated behind `channel:manage` like every other channel setting, separately
 * from `conversation:read`/`write` which the chat itself uses.
 *
 * The bridge call here is best-effort: if `apps/wa-bridge` happens to be down
 * when an agent asks to pair a number, the channel row is still created —
 * there is something to show and retry against — but the response says so
 * rather than pretending the QR is on its way.
 */
export function registerWaBridgeChannelRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const bridgeCall = async (path: string, method: 'POST' | 'DELETE'): Promise<boolean> => {
    try {
      const res = await fetch(`${ctx.env.WA_BRIDGE_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${ctx.env.WA_BRIDGE_SECRET}` },
      });
      return res.ok;
    } catch (err) {
      app.log.warn({ err, path }, 'wa-bridge service unreachable');
      return false;
    }
  };

  app.post('/v1/wa-bridge/channels', async (req, reply) => {
    ctx.guard(req, 'channel:manage');
    const body = z.object({ displayName: z.string().min(1).max(120) }).safeParse(req.body);
    if (!body.success) throw invalid('A display name is required');

    const { channelId } = await ctx.asTenant(req, async (tx, actor) => {
      const created = await createWaBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek },
        { displayName: body.data.displayName });
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'channel.connected',
        resourceType: 'channel', resourceId: created.channelId,
        meta: { kind: 'whatsapp_web' },
      });
      return created;
    });

    const bridgeStarted = await bridgeCall(`/internal/sessions/${channelId}/start`, 'POST');
    return reply.status(201).send({ channelId, bridgeStarted });
  });

  app.get('/v1/wa-bridge/channels', async (req) => {
    ctx.guard(req, 'channel:manage');
    const rows = await ctx.asTenant(req, (tx, actor) =>
      listWaBridgeChannels({ tx, tenantId: actor.tenantId, kek: ctx.kek }));

    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      status: r.status,
      phoneE164: r.phone_e164,
      sessionStatus: r.session_status,
      qrDataUrl: r.qr_data,
      qrExpiresAt: r.qr_expires_at,
      lastSeenAt: r.last_seen_at,
      lastError: r.last_error,
    }));
  });

  app.post('/v1/wa-bridge/channels/:id/disconnect', async (req) => {
    ctx.guard(req, 'channel:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const disabled = await ctx.asTenant(req, async (tx, actor) => {
      const ok = await disableWaBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { channelId: id });
      if (ok) {
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'channel.disconnected',
          resourceType: 'channel', resourceId: id,
        });
      }
      return ok;
    });
    if (!disabled) throw notFound('Channel');

    await bridgeCall(`/internal/sessions/${id}`, 'DELETE');
    return { ok: true };
  });

  /**
   * A hard delete, not a disconnect: the row itself is gone, and so is every
   * conversation and message on it. The console gates this behind its own
   * warning-and-confirm step before ever sending the request — there is no
   * further undo on this end.
   */
  app.delete('/v1/wa-bridge/channels/:id', async (req) => {
    ctx.guard(req, 'channel:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    await bridgeCall(`/internal/sessions/${id}`, 'DELETE');

    const deleted = await ctx.asTenant(req, async (tx, actor) => {
      const ok = await deleteWaBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { channelId: id });
      if (ok) {
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'channel.deleted',
          resourceType: 'channel', resourceId: id,
        });
      }
      return ok;
    });
    if (!deleted) throw notFound('Channel');

    return { ok: true };
  });

  /**
   * Puts a disconnected number back through the same pairing flow as a brand
   * new one, but on its existing row — `apps/wa-bridge` still has that
   * channel's session folder on disk, so this may resume silently or may ask
   * for a fresh QR, depending on whether WhatsApp still recognises it.
   */
  app.post('/v1/wa-bridge/channels/:id/reconnect', async (req) => {
    ctx.guard(req, 'channel:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const reconnected = await ctx.asTenant(req, async (tx, actor) => {
      const ok = await reconnectWaBridgeChannel({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { channelId: id });
      if (ok) {
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'channel.reconnecting',
          resourceType: 'channel', resourceId: id,
        });
      }
      return ok;
    });
    if (!reconnected) throw notFound('Channel');

    const bridgeStarted = await bridgeCall(`/internal/sessions/${id}/start`, 'POST');
    return { ok: true, bridgeStarted };
  });
}
