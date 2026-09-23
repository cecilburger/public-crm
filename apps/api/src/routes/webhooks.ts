import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { verifyWebhookSignature, ipAllowed, parseAllowList } from '@kirana/core';
import { withoutTenant, withTenant, findMessengerBridgeChannel, knownMessengerMessageIds } from '@kirana/db';
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
      object?: string;
      entry?: {
        id: string;
        changes?: { value?: Record<string, unknown> }[];
        // Instagram's own shape — Messenger-Platform style, not the
        // `changes[].value` shape WhatsApp Business Account webhooks use.
        messaging?: { message?: { mid?: string } }[];
      }[];
    };

    const events: { externalId: string; value: Record<string, unknown> }[] = [];
    for (const entry of body.entry ?? []) {
      if (body.object === 'instagram') {
        for (const messagingEvent of entry.messaging ?? []) {
          const mid = messagingEvent.message?.mid;
          if (!mid) continue;
          events.push({ externalId: mid, value: { platform: 'instagram', igAccountId: entry.id, messagingEvent } });
        }
        continue;
      }
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

  /**
   * The WhatsApp Web bridge (`apps/wa-bridge`) reports everything through this
   * one endpoint — QR codes, pairing state, and inbound messages alike — spooled
   * into the same `webhook_events` idempotency barrier as the Meta channel and
   * turned into rows by the same `inbound.normalise` worker. It is an internal
   * service, not a public provider, so it authenticates with a shared secret
   * rather than a per-payload signature.
   */
  app.post('/v1/webhooks/wa-bridge', async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${ctx.env.WA_BRIDGE_SECRET}`) {
      req.log.warn({ ip: req.ip }, 'wa-bridge webhook rejected: bad secret');
      webhookEvents.inc({ provider: 'wa_bridge', outcome: 'bad_signature' });
      return reply.status(401).send();
    }

    const body = req.body as {
      channelId?: string; event?: string; at?: string;
      message?: { id?: string };
    };
    if (!body.channelId || !body.event) {
      webhookEvents.inc({ provider: 'wa_bridge', outcome: 'invalid_payload' });
      return reply.status(400).send();
    }

    // Message events dedupe on WhatsApp's own message id, same as Meta.
    // Session-state events (qr, ready, disconnected…) have no such id, so the
    // timestamp the bridge attached stands in — good enough since these are
    // status transitions, not customer data that must never duplicate.
    const externalId = body.event === 'message' && body.message?.id
      ? body.message.id
      : `${body.channelId}:${body.event}:${body.at ?? Date.now()}`;

    const inserted = await withoutTenant(ctx.control, 'spooling a verified provider webhook', (tx) =>
      tx.query<{ id: string }>(
        `insert into webhook_events (provider, external_id, signature_ok, payload)
         values ('wa_bridge', $1, true, $2)
         on conflict (provider, external_id) do nothing
         returning id`,
        [externalId, JSON.stringify(body)],
      ));

    webhookEvents.inc({ provider: 'wa_bridge', outcome: inserted[0] ? 'accepted' : 'duplicate' });
    if (inserted[0]) {
      await ctx.dispatch({ queue: 'inbound.normalise', payload: { webhookEventId: inserted[0].id } });
    }

    return reply.status(200).send({ received: true });
  });

  /**
   * The Instagram Playwright bridge (`apps/ig-bridge`) — the counterpart to
   * `/v1/webhooks/wa-bridge` for a scraped, unofficial session. There is no
   * real provider message id to dedupe on (scraping never sees one), so the
   * bridge's own poller deliberately re-reports every message it still sees
   * on each pass; the external id here is a deterministic hash of
   * (tenant, thread, sender, text) so a message that was already ingested
   * lands on the same `webhook_events` row instead of a new one — the same
   * `(provider, external_id)` idempotency barrier every other provider uses,
   * just fed a synthesized key instead of one Meta or WhatsApp handed us.
   */
  app.post('/v1/webhooks/ig-bridge', async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${ctx.env.IG_BRIDGE_SECRET}`) {
      req.log.warn({ ip: req.ip }, 'ig-bridge webhook rejected: bad secret');
      webhookEvents.inc({ provider: 'ig_bridge_dm', outcome: 'bad_signature' });
      return reply.status(401).send();
    }

    const body = req.body as {
      tenantId?: string; event?: string; error?: string;
      message?: {
        threadId?: string; participantUsername?: string; senderUsername?: string; text?: string;
        direction?: 'inbound' | 'outbound'; index?: number;
      };
    };
    if (!body.tenantId || !body.event) {
      webhookEvents.inc({ provider: 'ig_bridge_dm', outcome: 'invalid_payload' });
      return reply.status(400).send();
    }

    const m = body.event === 'message' ? body.message : null;
    if (body.event === 'message'
      && (!m?.threadId || !m.participantUsername || !m.senderUsername || !m.text || !m.direction || m.index === undefined)) {
      webhookEvents.inc({ provider: 'ig_bridge_dm', outcome: 'invalid_payload' });
      return reply.status(400).send();
    }

    // Keyed on the sender and the message's position in the thread, not
    // just its text — scraping gives no real per-message id, and without
    // the position a repeated word ("halo", "oyy", ...), routine in casual
    // chat, would hash identically to its own earlier occurrence and be
    // dropped as a false duplicate on every repeat after the first.
    const externalId = m
      ? crypto.createHash('sha256')
          .update(`ig_dm:${body.tenantId}:${m.threadId}:${m.senderUsername}:${m.index}:${m.text}`)
          .digest('hex')
      : `${body.tenantId}:${body.event}:${Date.now()}`;

    const inserted = await withoutTenant(ctx.control, 'spooling a verified provider webhook', (tx) =>
      tx.query<{ id: string }>(
        `insert into webhook_events (provider, external_id, signature_ok, payload)
         values ('ig_bridge_dm', $1, true, $2)
         on conflict (provider, external_id) do nothing
         returning id`,
        [externalId, JSON.stringify(body)],
      ));

    webhookEvents.inc({ provider: 'ig_bridge_dm', outcome: inserted[0] ? 'accepted' : 'duplicate' });
    req.log.info(
      { tenantId: body.tenantId, event: body.event, outcome: inserted[0] ? 'accepted' : 'duplicate' },
      'ig-bridge webhook received',
    );
    if (inserted[0]) {
      await ctx.dispatch({ queue: 'inbound.normalise', payload: { webhookEventId: inserted[0].id } });
    }

    return reply.status(200).send({ received: true });
  });

  /**
   * The Facebook bridge (`apps/fb-bridge`) — Messenger DMs and Page comments
   * read off the real facebook.com UI. Same shape of trust as the other two
   * bridges: an internal service on loopback authenticating with a shared
   * secret, not a provider signing its own payloads.
   *
   * INBOUND ONLY. There is no outbound counterpart to this route and no
   * `messenger_bridge` branch in the outbound sender, so nothing this accepts
   * can turn into a reply.
   *
   * The external id is chosen carefully, because it is the idempotency barrier
   * for the whole channel:
   *   - a message with a real Facebook `mid.*` keys on that directly;
   *   - a message without one keys on a hash of
   *     (tenant, thread, sender, seq, text) — `seq` being a counter the bridge
   *     hands out once per genuinely new message, never a DOM position. Text
   *     alone would collapse a customer's second "halo" into their first;
   *   - a comment keys on Facebook's own comment id, which the bridge refuses
   *     to synthesise a substitute for.
   * `apps/worker` recomputes the identical string when it writes the row, so
   * the two dedupe layers cannot disagree. Change one and you must change both;
   * `tests/facebook-bridge.test.ts` asserts they still match.
   */
  /**
   * Which of these message ids the CRM already holds.
   *
   * This is what makes Postgres the source of truth for reconciliation. The
   * bridge could keep its own file of what it has reported, and did — but a
   * file on the bridge's disk is a second opinion, and the two drift the moment
   * either side is restored, reset or redeployed. Asking here means a backfill
   * stops at what the database actually contains.
   *
   * A read, so it opens the tenant's own context rather than the control pool:
   * the bridge states the tenant, and row-level security applies from the first
   * query to the last.
   */
  app.post('/v1/webhooks/fb-bridge/known', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${ctx.env.FB_BRIDGE_SECRET}`) {
      req.log.warn({ ip: req.ip }, 'fb-bridge known-ids rejected: bad secret');
      return reply.status(401).send();
    }
    const body = req.body as { tenantId?: string; externalIds?: string[] };
    if (!body.tenantId || !Array.isArray(body.externalIds)) return reply.status(400).send();
    // Bounded: a backfill asks about one window of one thread, never a history.
    const externalIds = body.externalIds.filter((id) => typeof id === 'string').slice(0, 500);

    const known = await withTenant(ctx.db, body.tenantId, async (tx) => {
      const channel = await findMessengerBridgeChannel({ tx, tenantId: body.tenantId!, kek: ctx.kek });
      if (!channel) return [] as string[];
      const found = await knownMessengerMessageIds({ tx, tenantId: body.tenantId!, kek: ctx.kek }, {
        channelId: channel.channelId, providerMessageIds: externalIds,
      });
      return [...found];
    });

    return reply.send({ known });
  });

  app.post('/v1/webhooks/fb-bridge', async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${ctx.env.FB_BRIDGE_SECRET}`) {
      req.log.warn({ ip: req.ip }, 'fb-bridge webhook rejected: bad secret');
      webhookEvents.inc({ provider: 'fb_bridge', outcome: 'bad_signature' });
      return reply.status(401).send();
    }

    const body = req.body as {
      tenantId?: string; event?: string; at?: string; error?: string;
      message?: {
        threadId?: string; externalMessageId?: string | null; senderId?: string; senderName?: string;
        text?: string; sentAt?: string | null; direction?: string; seq?: number;
      };
      comment?: {
        commentId?: string; postId?: string; authorId?: string | null; authorName?: string;
        text?: string; commentedAt?: string | null; pageId?: string; pageName?: string | null;
      };
    };
    if (!body.tenantId || !body.event) {
      webhookEvents.inc({ provider: 'fb_bridge', outcome: 'invalid_payload' });
      return reply.status(400).send();
    }

    // Validated here rather than trusted, so a bridge that half-broke sends a
    // 400 it can log instead of writing a row with an empty sender into the
    // customer's inbox.
    const m = (body.event === 'message' ? body.message : null) ?? null;
    if (body.event === 'message') {
      const ok = m?.threadId && m.senderId && m.senderName && m.text
        && (m.direction === 'inbound' || m.direction === 'outbound')
        && typeof m.seq === 'number';
      if (!ok) {
        webhookEvents.inc({ provider: 'fb_bridge', outcome: 'invalid_payload' });
        return reply.status(400).send();
      }
    }

    const c = (body.event === 'comment' ? body.comment : null) ?? null;
    if (body.event === 'comment' && !(c?.commentId && c.postId && c.pageId && c.text)) {
      webhookEvents.inc({ provider: 'fb_bridge', outcome: 'invalid_payload' });
      return reply.status(400).send();
    }

    const externalId = facebookExternalId(body.tenantId, body.event, m, c);

    // A row that FAILED is re-spooled, not treated as a duplicate. The bridge
    // re-emits a message on every reconciliation until the CRM says it holds
    // it, and the CRM only holds it once `messages` does — so an event that
    // failed in the processor (confirmed live: two DMs that arrived before the
    // Page was connected, refused for having no channel) would otherwise hit
    // this conflict on every retry and be dropped as "duplicate" forever. A
    // `processed` row stays a duplicate; only a failure is worth another go.
    const inserted = await withoutTenant(ctx.control, 'spooling a verified provider webhook', (tx) =>
      tx.query<{ id: string }>(
        `insert into webhook_events (provider, external_id, signature_ok, payload)
         values ('fb_bridge', $1, true, $2)
         on conflict (provider, external_id) do update
           set status = 'received', payload = excluded.payload, error = null, processed_at = null
           where webhook_events.status = 'failed'
         returning id`,
        [externalId, JSON.stringify(body)],
      ));

    webhookEvents.inc({ provider: 'fb_bridge', outcome: inserted[0] ? 'accepted' : 'duplicate' });
    req.log.info(
      { tenantId: body.tenantId, event: body.event, outcome: inserted[0] ? 'accepted' : 'duplicate' },
      'fb-bridge webhook received',
    );
    if (inserted[0]) {
      await ctx.dispatch({ queue: 'inbound.normalise', payload: { webhookEventId: inserted[0].id } });
    }

    return reply.status(200).send({ received: true });
  });
}

/**
 * The spool key for one `fb-bridge` event.
 *
 * Kept as a named function rather than inlined so the worker's copy can be
 * compared against it directly — the two must produce byte-identical strings or
 * a redelivered event passes the spool barrier and inserts a second message.
 */
export function facebookExternalId(
  tenantId: string,
  event: string,
  message: { threadId?: string; externalMessageId?: string | null; senderId?: string; seq?: number; text?: string } | null,
  comment: { commentId?: string } | null,
): string {
  if (message) {
    // Facebook's own id when it exists — an identity it assigned beats one we
    // derived, and it stays stable even if the text is edited afterwards.
    if (message.externalMessageId) return `fb_dm:${tenantId}:${message.externalMessageId}`;
    return crypto.createHash('sha256')
      .update(`fb_dm:${tenantId}:${message.threadId}:${message.senderId}:${message.seq}:${message.text}`)
      .digest('hex');
  }
  if (comment) return `fb_comment:${tenantId}:${comment.commentId}`;
  // Session-state events are status transitions, not customer data that must
  // never duplicate, so the clock stands in for an id the same way the
  // wa-bridge route already does for its lifecycle events.
  return `fb_bridge:${tenantId}:${event}:${Date.now()}`;
}
