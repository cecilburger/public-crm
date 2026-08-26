import type { FastifyInstance } from 'fastify';
import {
  estimate, overage, cheaperPlanAt, planOf, PLANS, invalid, notFound,
  type PlanCode,
} from '@kirana/core';
import { currentUsage, listInvoices, getInvoice, markInvoicePaid, audit } from '@kirana/db';
import { z } from 'zod';
import type { AppCtx } from '../app.ts';

export function registerBillingRoutes(app: FastifyInstance, ctx: AppCtx): void {

  /** What the workspace has consumed this period, and what it will cost. */
  app.get('/v1/usage', async (req) => {
    ctx.guard(req, 'conversation:read');

    return ctx.asTenant(req, async (tx, actor) => {
      const sub = await tx.query<{ plan_code: PlanCode; interval: 'monthly' | 'annual';
        extra_numbers: number; extra_seats: number; ai_packs: number; addons: string[] }>(
        `select plan_code, interval, extra_numbers, extra_seats, ai_packs, addons
           from subscriptions where tenant_id = $1 and status <> 'cancelled' limit 1`,
        [actor.tenantId],
      );
      if (!sub[0]) throw invalid('This workspace has no active subscription');

      const { billingPeriodId, usage } = await currentUsage(tx, actor.tenantId);
      const plan = sub[0].plan_code;

      if (plan === 'custom') {
        return { plan, billingPeriodId, usage, note: 'Custom contracts are invoiced from the agreement' };
      }

      const p = planOf(plan);
      const over = overage(plan, usage.conversations);
      const recurring = estimate({
        plan, interval: sub[0].interval,
        extraNumbers: sub[0].extra_numbers, extraSeats: sub[0].extra_seats, aiPacks: sub[0].ai_packs,
        addons: { csm: sub[0].addons.includes('csm'), voice: sub[0].addons.includes('voice') },
      });

      return {
        plan,
        billingPeriodId,
        usage,
        included: { conversations: p.chats, aiReplies: p.includedAiReplies,
                    numbers: p.includedNumbers, seats: p.includedSeats },
        percentUsed: Math.round((usage.conversations / p.chats) * 100),
        overage: over,
        metaPassThroughIdr: Math.round(usage.meta_cost_micros / 1_000_000),
        projectedTotalIdr: recurring.totalMonthlyIdr + over.amountIdr,
        // The promise on the pricing page, enforced: never let a customer pay
        // more in overage than the next plan up would have cost.
        recommendedPlan: cheaperPlanAt(usage.conversations, sub[0].interval),
      };
    });
  });

  /** Public price calculator — the same numbers the website's configurator shows. */
  app.get('/v1/billing/estimate', async (req) => {
    const q = z.object({
      plan: z.enum(['starter', 'growth', 'scale']),
      interval: z.enum(['monthly', 'annual']).default('monthly'),
      extraNumbers: z.coerce.number().int().min(0).max(200).default(0),
      extraSeats: z.coerce.number().int().min(0).max(1000).default(0),
      aiPacks: z.coerce.number().int().min(0).max(200).default(0),
      csm: z.coerce.boolean().default(false),
      voice: z.coerce.boolean().default(false),
      greenTick: z.coerce.boolean().default(false),
      migration: z.coerce.boolean().default(false),
    }).safeParse(req.query);
    if (!q.success) throw invalid('Check the estimate parameters');

    const { plan, interval, extraNumbers, extraSeats, aiPacks, ...addons } = q.data;
    return estimate({ plan, interval, extraNumbers, extraSeats, aiPacks, addons });
  });

  /* --------------------------------------------------------------- invoices */

  app.get('/v1/invoices', async (req) => {
    ctx.guard(req, 'billing:manage');
    return ctx.asTenant(req, async (tx, actor) => {
      const invoices = await listInvoices(tx, actor.tenantId);
      return {
        invoices,
        outstandingIdr: invoices
          .filter((i) => i.status === 'issued' || i.status === 'overdue')
          .reduce((sum, i) => sum + i.totalIdr, 0),
      };
    });
  });

  app.get('/v1/invoices/:id', async (req) => {
    ctx.guard(req, 'billing:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return ctx.asTenant(req, async (tx, actor) => {
      const invoice = await getInvoice(tx, actor.tenantId, id);
      if (!invoice) throw notFound('Invoice');
      return invoice;
    });
  });

  /**
   * Confirming a bank transfer by hand — what the first customers will actually
   * use. The reference is whatever was read off the statement, and it is kept so
   * the payment can be traced back later.
   */
  app.post('/v1/invoices/:id/paid', async (req) => {
    const actor = ctx.guard(req, 'billing:manage');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ reference: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) throw invalid('Record the bank reference for this payment');

    const paid = await ctx.asTenant(req, async (tx) => {
      const ok = await markInvoicePaid(tx, actor.tenantId, id, {
        userId: actor.userId, reference: body.data.reference,
      });
      if (!ok) throw invalid('That invoice is not awaiting payment');
      return true;
    });

    // Sending happens in the worker: the API has no business holding an SMTP
    // connection open while somebody waits for a button to respond.
    if (paid) {
      await ctx.dispatch({
        queue: 'email.send',
        payload: {
          tenantId: actor.tenantId, invoiceId: id,
          kind: { kind: 'payment_received', reference: body.data.reference },
        },
      });
    }
    return { ok: true };
  });

  app.get('/v1/billing/profile', async (req) => {
    ctx.guard(req, 'billing:manage');
    return ctx.asTenant(req, async (tx, actor) => {
      const rows = await tx.query(
        `select legal_name, npwp, address, billing_email, bank_details
           from billing_profiles where tenant_id = $1`,
        [actor.tenantId],
      );
      return rows[0] ?? null;
    });
  });

  app.put('/v1/billing/profile', async (req) => {
    const actor = ctx.guard(req, 'billing:manage');
    const body = z.object({
      legalName: z.string().min(1).max(200),
      npwp: z.string().max(40).optional(),
      address: z.string().max(500).optional(),
      billingEmail: z.string().email().optional(),
      bankDetails: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('A legal name is required for the invoice');

    return ctx.asTenant(req, async (tx) => {
      const d = body.data;
      await tx.query(
        `insert into billing_profiles (tenant_id, legal_name, npwp, address, billing_email, bank_details)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id) do update set
           legal_name = excluded.legal_name, npwp = excluded.npwp, address = excluded.address,
           billing_email = excluded.billing_email, bank_details = excluded.bank_details,
           updated_at = now()`,
        [actor.tenantId, d.legalName, d.npwp ?? null, d.address ?? null,
         d.billingEmail ?? null, d.bankDetails ?? null],
      );
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'billing.profile_updated',
        resourceType: 'billing_profile', resourceId: actor.tenantId,
      });
      return { ok: true };
    });
  });

  app.get('/v1/billing/plans', async () => ({
    plans: Object.values(PLANS).map((p) => ({
      code: p.code, label: p.label, chats: p.chats, priceIdr: p.priceIdr,
      perChatIdr: p.priceIdr / p.chats,
      included: { numbers: p.includedNumbers, seats: p.includedSeats, aiReplies: p.includedAiReplies },
      extras: { numberIdr: p.extraNumberIdr, seatIdr: p.extraSeatIdr, aiPackIdr: p.aiPackIdr },
      overagePerChatIdr: p.overagePerChatIdr,
    })),
  }));
}
