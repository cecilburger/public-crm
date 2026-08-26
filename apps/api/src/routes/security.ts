import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import { listSecurityEvents, acknowledgeSecurityEvent, markNotified, audit } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * What a workspace can see about its own security, and the two things a person
 * can do about it: say "seen", and say "we have notified".
 *
 * The second one stops a statutory clock, so it is audited and it records who.
 */
export function registerSecurityRoutes(app: FastifyInstance, ctx: AppCtx): void {

  app.get('/v1/security/events', async (req) => {
    ctx.guard(req, 'audit:read');
    const q = z.object({
      open: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query);
    if (!q.success) throw invalid('Check the query parameters');

    return ctx.asTenant(req, async (tx, actor) => {
      const events = await listSecurityEvents(tx, actor.tenantId, {
        openOnly: q.data.open, limit: q.data.limit,
      });
      return {
        events,
        // The number a person actually needs: how many clocks are running.
        clocksRunning: events.filter((e) => e.clock === 'running' || e.clock === 'due_soon').length,
        overdue: events.filter((e) => e.clock === 'overdue').length,
      };
    });
  });

  app.post('/v1/security/events/:id/acknowledge', async (req) => {
    const actor = ctx.guard(req, 'audit:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ notes: z.string().max(2000).optional() }).safeParse(req.body ?? {});

    return ctx.asTenant(req, async (tx) => {
      const ok = await acknowledgeSecurityEvent(tx, actor.tenantId, id, actor.userId,
        body.success ? body.data.notes : undefined);
      if (!ok) throw notFound('Event');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'security.event_acknowledged',
        resourceType: 'security_event', resourceId: id,
      });
      return { ok: true };
    });
  });

  /** Stops the UU PDP clock. Deliberately a separate, deliberate action. */
  app.post('/v1/security/events/:id/notified', async (req) => {
    const actor = ctx.guard(req, 'dsr:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ notes: z.string().max(2000) }).safeParse(req.body);
    if (!body.success) throw invalid('Record who was notified and when, in the notes');

    return ctx.asTenant(req, async (tx) => {
      const ok = await markNotified(tx, actor.tenantId, id, actor.userId, body.data.notes);
      if (!ok) throw notFound('Event');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'security.breach_notified',
        resourceType: 'security_event', resourceId: id, meta: { notes: body.data.notes },
      });
      return { ok: true };
    });
  });
}
