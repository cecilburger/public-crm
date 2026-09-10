import type { FastifyInstance } from 'fastify';
import { actorCan, maskPhone } from '@kirana/core';
import { listContacts, tenantKeys, openField } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * The Pelanggan page: everyone tagged `customer` from a conversation, not
 * every stranger who ever wrote in. Full phone numbers are a separate
 * entitlement from reading the list, same rule as the conversation detail view.
 */
export function registerContactRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/v1/contacts', async (req) => {
    ctx.guard(req, 'contact:read');

    return ctx.asTenant(req, async (tx, actor) => {
      const canReveal = actorCan(actor, 'contact:export');
      const rows = await listContacts({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { tag: 'customer' });
      const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);

      return rows.map((r) => {
        const phone = r.phone_enc ? openField(keys, actor.tenantId, r.phone_enc) : null;
        return {
          id: r.id,
          displayName: r.display_name,
          phone: phone ? (canReveal ? phone : maskPhone(phone)) : null,
          tags: r.tags,
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
        };
      });
    });
  });
}
