import type { FastifyInstance } from 'fastify';
import { verifyWebhookSignature, ipAllowed, parseAllowList } from '@kirana/core';
import { withoutTenant } from '@kirana/db';
import type { AppCtx } from '../app.ts';
import { webhookEvents } from '../metrics.ts';

/**
 * Provider ingress.
 *
 * Three rules, in order: verify the signature over the raw bytes, spool the
 * payload, acknowledge fast. Business logic runs in the worker — a provider that
 * does not get a 200 inside a few seconds retries, and retries during an outage
 * are how a queue becomes a stampede.
 */
export function registerWebhookRoutes(app: FastifyInstance, ctx: AppCtx): void {
  // Bad signatures happen; a stream of them is someone probing. There is no
  // tenant to attribute this to before the payload is parsed, so it is delivered
  // to the alert sink rather than recorded against a workspace.
  // Parsed once at boot, not per request.
  const allowList = parseAllowList(ctx.env.META_IP_ALLOWLIST);

  let badSignatures = 0;
  let windowStartedAt = Date.now();
  const FLOOD_THRESHOLD = 20;
  const FLOOD_WINDOW_MS = 5 * 60_000;

  const noteBadSignature = (ip: string) => {
    const now = Date.now();
    if (now - windowStartedAt > FLOOD_WINDOW_MS) { badSignatures = 0; windowStartedAt = now; }
    badSignatures += 1;
    if (badSignatures === FLOOD_THRESHOLD) {
      void ctx.alertSink.deliver({
        kind: 'webhook_signature_flood', severity: 'warning', tenantId: 'platform',
        summary: 'Unsigned or wrongly signed webhook payloads arriving at volume',
        detail: { count: badSignatures, windowMinutes: FLOOD_WINDOW_MS / 60_000, lastIp: ip },
        detectedAt: new Date(), notifiable: false,
      });
    }
  };

  app.get('/v1/webhooks/meta', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === ctx.env.META_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.status(403).send();
  });

  app.post('/v1/webhooks/meta', async (req, reply) => {
    // Cheaper than an HMAC and it keeps the spool clean, but it is defence in
    // depth only: the signature is what actually authenticates the payload.
    if (!ipAllowed(req.ip, allowList)) {
      req.log.warn({ ip: req.ip }, 'webhook rejected: source not in allow-list');
      webhookEvents.inc({ provider: 'meta', outcome: 'blocked_ip' });
      return reply.status(403).send();
    }

    const raw = req.rawBody ?? Buffer.alloc(0);
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const ok = verifyWebhookSignature(ctx.env.META_APP_SECRET, raw, signature);

    if (!ok) {
      // Record the attempt, then give the caller nothing to learn from.
      req.log.warn({ ip: req.ip }, 'webhook signature rejected');
      noteBadSignature(req.ip);
      webhookEvents.inc({ provider: 'meta', outcome: 'bad_signature' });
      return reply.status(401).send();
    }

    const body = req.body as {
      entry?: { id: string; changes?: { value?: Record<string, unknown> }[] }[];
    };

    const events: { externalId: string; value: Record<string, unknown> }[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const messages = (value.messages as { id: string }[] | undefined) ?? [];
        const statuses = (value.statuses as { id: string; status: string }[] | undefined) ?? [];
        for (const m of messages) events.push({ externalId: m.id, value });
        for (const s of statuses) events.push({ externalId: `${s.id}:${s.status}`, value });
      }
    }

    let accepted = 0;
    for (const ev of events) {
      // The unique index on (provider, external_id) is the idempotency barrier:
      // a redelivered event is spooled once and dispatched once.
      const inserted = await withoutTenant(ctx.control, 'spooling a verified provider webhook', (tx) =>
        tx.query<{ id: string }>(
          `insert into webhook_events (provider, external_id, signature_ok, payload)
           values ('meta', $1, true, $2)
           on conflict (provider, external_id) do nothing
           returning id`,
          [ev.externalId, JSON.stringify(ev.value)],
        ));

      webhookEvents.inc({ provider: 'meta', outcome: inserted[0] ? 'accepted' : 'duplicate' });
      if (inserted[0]) {
        accepted += 1;
        await ctx.dispatch({ queue: 'inbound.normalise', payload: { webhookEventId: inserted[0].id } });
      }
    }

    return reply.status(200).send({ received: events.length, accepted });
  });
}
