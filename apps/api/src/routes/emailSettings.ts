import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid } from '@kirana/core';
import { getTenantEmailSettings, setTenantEmailSettings } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * Pengaturan → Email: lets a tenant point outgoing mail (meeting invites
 * today) at its own SMTP mailbox instead of the shared server default.
 * Gated behind `channel:manage`, the same tier that already owns the other
 * integration credentials (WhatsApp Web pairing) — this is one more wire a
 * tenant plugs into the system, not a day-to-day setting.
 */
export function registerEmailSettingsRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/settings/email', async (req) => {
    ctx.guard(req, 'channel:manage');
    return ctx.asTenant(req, (tx, actor) =>
      getTenantEmailSettings({ tx, tenantId: actor.tenantId, kek: ctx.kek }));
  });

  app.patch('/v1/settings/email', async (req) => {
    const actor = ctx.guard(req, 'channel:manage');
    const body = z.object({
      smtpUrl: z.string().max(500).optional(),
      emailFrom: z.string().max(200).optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the email settings');

    await ctx.asTenant(req, (tx) =>
      setTenantEmailSettings({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
        smtpUrl: body.data.smtpUrl, emailFrom: body.data.emailFrom, actorId: actor.userId,
      }));
    return { ok: true };
  });
}
