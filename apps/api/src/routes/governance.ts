import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalid, notFound } from '@kirana/core';
import { audit, verifyAuditChain } from '@kirana/db';
import type { AppCtx } from '../app.ts';

/**
 * The endpoints an auditor or a regulator actually asks for: who did what, and
 * what happens when a customer exercises their rights under UU PDP.
 */
export function registerGovernanceRoutes(app: FastifyInstance, ctx: AppCtx): void {

  app.get('/v1/audit', async (req) => {
    ctx.guard(req, 'audit:read');
    const q = z.object({
      resourceType: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query);
    if (!q.success) throw invalid('Check the audit query');

    return ctx.asTenant(req, (tx, actor) =>
      tx.query(
        `select id, actor_type, actor_id, action, resource_type, resource_id, meta, created_at
           from audit_events
          where tenant_id = $1 and ($2::text is null or resource_type = $2)
          order by id desc limit $3`,
        [actor.tenantId, q.data.resourceType ?? null, q.data.limit],
      ));
  });

  /** Proves the log has not been rewritten. Run by the nightly job too. */
  app.get('/v1/audit/verify', async (req) => {
    ctx.guard(req, 'audit:read');
    return ctx.asTenant(req, (tx, actor) => verifyAuditChain(tx, actor.tenantId));
  });

  app.post('/v1/dsr', async (req, reply) => {
    const actor = ctx.guard(req, 'dsr:manage');
    const body = z.object({
      kind: z.enum(['access', 'export', 'erasure', 'rectification', 'objection']),
      contactId: z.string().uuid().optional(),
      subjectRef: z.string().max(200).optional(),
      reason: z.string().max(1000).optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Check the request details');

    const created = await ctx.asTenant(req, async (tx) => {
      const rows = await tx.query<{ id: string; due_at: Date }>(
        `insert into dsr_requests (tenant_id, contact_id, subject_ref, kind, requested_by, reason)
         values ($1,$2,$3,$4,$5,$6) returning id, due_at`,
        [actor.tenantId, body.data.contactId ?? null, body.data.subjectRef ?? null,
         body.data.kind, actor.userId, body.data.reason ?? null],
      );
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: `dsr.${body.data.kind}.received`,
        resourceType: 'dsr_request', resourceId: rows[0]!.id,
      });
      return rows[0]!;
    });
    return reply.status(201).send(created);
  });

  app.get('/v1/dsr', async (req) => {
    ctx.guard(req, 'dsr:manage');
    return ctx.asTenant(req, (tx, actor) =>
      tx.query(
        `select id, kind, status, subject_ref, contact_id, requested_at, due_at, completed_at
           from dsr_requests where tenant_id = $1 order by due_at asc limit 200`,
        [actor.tenantId]));
  });

  /**
   * Erasure. The contact's identifiers are crypto-shredded and the blind index
   * is cleared, which both removes the ability to find them again and lets the
   * partial unique index treat a future message as a genuinely new customer.
   * Aggregate counters stay: they hold no personal data and the invoice needs them.
   */
  app.post('/v1/dsr/:id/execute', async (req) => {
    const actor = ctx.guard(req, 'dsr:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return ctx.asTenant(req, async (tx) => {
      const rows = await tx.query<{ id: string; kind: string; contact_id: string | null; status: string }>(
        'select id, kind, contact_id, status from dsr_requests where tenant_id = $1 and id = $2',
        [actor.tenantId, id],
      );
      const dsr = rows[0];
      if (!dsr) throw notFound('Request');
      if (dsr.status === 'completed') throw invalid('This request is already completed');
      if (dsr.kind !== 'erasure') throw invalid('Only erasure requests can be executed automatically');
      if (!dsr.contact_id) throw invalid('This request is not linked to a contact');

      const messages = await tx.query<{ n: number }>(
        `update messages set body_enc = null, media = '[]'
           where tenant_id = $1 and conversation_id in (
             select id from conversations where tenant_id = $1 and contact_id = $2)
         returning 1 as n`,
        [actor.tenantId, dsr.contact_id],
      );

      await tx.query(
        `update contacts
            set display_name = null, phone_enc = null, phone_bidx = null,
                email_enc = null, email_bidx = null, attributes = '{}', tags = '{}',
                deleted_at = now()
          where tenant_id = $1 and id = $2`,
        [actor.tenantId, dsr.contact_id],
      );

      await tx.query(
        `update dsr_requests set status = 'completed', completed_at = now() where tenant_id = $1 and id = $2`,
        [actor.tenantId, id],
      );

      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'dsr.erasure.completed',
        resourceType: 'contact', resourceId: dsr.contact_id,
        meta: { messagesRedacted: messages.length },
      });

      return { ok: true, messagesRedacted: messages.length };
    });
  });
}
