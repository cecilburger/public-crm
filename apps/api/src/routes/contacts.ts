import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorCan, maskPhone, invalid, notFound } from '@kirana/core';
import {
  audit, listContacts, createContact, getContact, updateContact, softDeleteContact,
  tenantKeys, openField,
} from '@kirana/db';
import type { AppCtx } from '../app.ts';

const contactBody = z.object({
  displayName: z.string().min(1).max(200).optional(),
  phone: z.string().min(1).max(32).optional(),
  email: z.string().email().max(200).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  address: z.string().min(1).max(500).optional(),
  notes: z.string().min(1).max(2000).optional(),
});

const contactPatchBody = z.object({
  displayName: z.string().min(1).max(200).nullable(),
  phone: z.string().min(1).max(32).nullable(),
  email: z.string().email().max(200).nullable(),
  tags: z.array(z.string().max(40)).max(20),
  address: z.string().min(1).max(500).nullable(),
  notes: z.string().min(1).max(2000).nullable(),
});

/**
 * The Pelanggan page: everyone tagged `customer`, plus the CRUD an owner uses
 * to add one by hand, edit one, or (soft-)delete one. Full phone numbers are a
 * separate entitlement from reading the list, same rule as the conversation
 * detail view.
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

  app.post('/v1/contacts', async (req, reply) => {
    ctx.guard(req, 'contact:write');
    const body = contactBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the customer fields');

    // This route only exists for the Pelanggan page's "Tambah Pelanggan" form —
    // a contact created here is a customer by definition, whether or not
    // anyone remembered to type that into the Label field. Without this, a
    // contact saved with no tags is invisible on the very page that created it,
    // since the list only ever shows contacts tagged `customer`.
    const tags = Array.from(new Set([...(body.data.tags ?? []), 'customer']));

    const created = await ctx.asTenant(req, async (tx, actor) => {
      try {
        const c = await createContact({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          displayName: body.data.displayName ?? null, phone: body.data.phone ?? null,
          email: body.data.email ?? null, tags,
          address: body.data.address ?? null, notes: body.data.notes ?? null,
        });
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'contact.created',
          resourceType: 'contact', resourceId: c.id,
        });
        return c;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw invalid('Nomor ini sudah terdaftar sebagai pelanggan lain');
        }
        throw err;
      }
    });
    return reply.status(201).send(created);
  });

  app.get('/v1/contacts/:id', async (req) => {
    ctx.guard(req, 'contact:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx, actor) => {
      const canReveal = actorCan(actor, 'contact:export');
      const row = await getContact({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { contactId: id });
      if (!row) throw notFound('Contact');

      const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);
      const phone = row.phone_enc ? openField(keys, actor.tenantId, row.phone_enc) : null;
      const email = row.email_enc ? openField(keys, actor.tenantId, row.email_enc) : null;
      return {
        id: row.id,
        displayName: row.display_name,
        phone: phone ? (canReveal ? phone : maskPhone(phone)) : null,
        email,
        tags: row.tags,
        address: row.attributes?.address ?? null,
        notes: row.attributes?.notes ?? null,
      };
    });
  });

  app.patch('/v1/contacts/:id', async (req) => {
    ctx.guard(req, 'contact:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = contactPatchBody.safeParse(req.body);
    if (!body.success) throw invalid('Check the customer fields');

    return ctx.asTenant(req, async (tx, actor) => {
      try {
        // Someone without `contact:export` only ever saw the masked number on
        // this form — whatever they submitted for it is not a real number to
        // save, so the field is dropped rather than trusted.
        const canReveal = actorCan(actor, 'contact:export');
        const ok = await updateContact({ tx, tenantId: actor.tenantId, kek: ctx.kek }, {
          contactId: id, displayName: body.data.displayName,
          phone: canReveal ? body.data.phone : undefined,
          email: body.data.email, tags: body.data.tags,
          address: body.data.address, notes: body.data.notes,
        });
        if (!ok) throw notFound('Contact');
        await audit(tx, actor.tenantId, {
          actorType: 'user', actorId: actor.userId, action: 'contact.updated',
          resourceType: 'contact', resourceId: id,
        });
        return { ok: true };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw invalid('Nomor ini sudah terdaftar sebagai pelanggan lain');
        }
        throw err;
      }
    });
  });

  /** Soft delete — see `softDeleteContact` for why this keeps the data instead of scrubbing it. */
  app.delete('/v1/contacts/:id', async (req) => {
    ctx.guard(req, 'contact:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx, actor) => {
      const ok = await softDeleteContact({ tx, tenantId: actor.tenantId, kek: ctx.kek }, { contactId: id });
      if (!ok) throw notFound('Contact');
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'contact.deleted',
        resourceType: 'contact', resourceId: id,
      });
      return { ok: true };
    });
  });
}
