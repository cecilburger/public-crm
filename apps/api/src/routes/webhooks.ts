import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { verifyWebhookSignature, ipAllowed, parseAllowList } from '@kirana/core';
import {
  withoutTenant, withTenant, findMessengerBridgeChannel, knownMessengerMessageIds, bridgeSessionHome,
  knownFacebookCommentIds, storedFacebookCommentPosts,
} from '@kirana/db';
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
      tenantId?: string; sessionKey?: string; event?: string; error?: string;
      message?: {
        threadId?: string; participantUsername?: string; senderUsername?: string; text?: string;
        direction?: 'inbound' | 'outbound'; index?: number;
      };
    };
    if (!body.tenantId || !body.event) {
      webhookEvents.inc({ provider: 'ig_bridge_dm', outcome: 'invalid_payload' });
      return reply.status(400).send();
    }

    // The session key names which division's browser profile this came off.
    // A bridge that predates divisions sends none, and its events are
    // Marketing's — whose key is the bare tenant id, so the dedupe strings
    // below stay byte-identical to the ones already spooled.
    const sessionKey = body.sessionKey ?? body.tenantId;
    const home = await bridgeSessionHome(ctx.control, sessionKey);
    if (!home || home.tenantId !== body.tenantId) {
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
          .update(`ig_dm:${sessionKey}:${m.threadId}:${m.senderUsername}:${m.index}:${m.text}`)
          .digest('hex')
      : `${sessionKey}:${body.event}:${Date.now()}`;

    const inserted = await withoutTenant(ctx.control, 'spooling a verified provider webhook', (tx) =>
      tx.query<{ id: string }>(
        `insert into webhook_events (provider, external_id, signature_ok, payload)
         values ('ig_bridge_dm', $1, true, $2)
         on conflict (provider, external_id) do nothing
         returning id`,
        [externalId, JSON.stringify({ ...body, sessionKey })],
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
   * Comments on our own posts, read off the page by `apps/ig-bridge`.
   *
   * Spooled like every other provider event rather than written straight
   * through: the reader re-reads a post on every pass, so the same comment
   * arrives again and again, and `(provider, external_id)` is the barrier
   * that already knows what to do about that.
   *
   * A comment is deliberately NOT a message — it never reaches the inbox or
   * the flow. `processIgComment` files it in `ig_comments`, where the rule
   * that governs it (one short public line, the real answer in DM) can be
   * applied by whoever is allowed to apply it.
   */
  app.post('/v1/webhooks/ig-comments', async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${ctx.env.IG_BRIDGE_SECRET}`) {
      req.log.warn({ ip: req.ip }, 'ig-comments webhook rejected: bad secret');
      webhookEvents.inc({ provider: 'ig_comment', outcome: 'bad_signature' });
      return reply.status(401).send();
    }

    const body = req.body as {
      tenantId?: string; sessionKey?: string;
      comment?: {
        postRef?: string; commentRef?: string; commenter?: string; text?: string; at?: string;
        parentRef?: string | null;
      };
    };
    const c = body.comment;
    if (!body.tenantId || !c?.postRef || !c.commentRef || !c.commenter || !c.text) {
      webhookEvents.inc({ provider: 'ig_comment', outcome: 'invalid_payload' });
      return reply.status(400).send();
    }

    // Same rule as `/v1/webhooks/ig-bridge`: the session key is the division,
    // and a bridge that sends none is reporting for Marketing.
    const sessionKey = body.sessionKey ?? body.tenantId;
    const home = await bridgeSessionHome(ctx.control, sessionKey);
    if (!home || home.tenantId !== body.tenantId) {
      webhookEvents.inc({ provider: 'ig_comment', outcome: 'invalid_payload' });
      return reply.status(400).send();
    }

    const inserted = await withoutTenant(ctx.control, 'spooling a verified provider webhook', (tx) =>
      tx.query<{ id: string }>(
        `insert into webhook_events (provider, external_id, signature_ok, payload)
         values ('ig_comment', $1, true, $2)
         on conflict (provider, external_id) do nothing
         returning id`,
        [`${sessionKey}:${c.commentRef}`, JSON.stringify({ ...body, sessionKey })],
      ));

    webhookEvents.inc({ provider: 'ig_comment', outcome: inserted[0] ? 'accepted' : 'duplicate' });
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
    const body = req.body as {
      tenantId?: string; sessionKey?: string; externalIds?: string[]; commentIds?: string[];
      commentPosts?: Record<string, unknown>;
    };
    if (!body.tenantId || !Array.isArray(body.externalIds)) return reply.status(400).send();
    // Bounded: a backfill asks about one window of one thread, never a history;
    // a comment sweep about the few posts it just read.
    const externalIds = body.externalIds.filter((id) => typeof id === 'string').slice(0, 500);
    const commentIds = (Array.isArray(body.commentIds) ? body.commentIds : [])
      .filter((id) => typeof id === 'string').slice(0, 500);
    // The post the sweep read each comment under, when it says: a comment held
    // under a slug Facebook has since re-issued is not known, so it is offered
    // again and re-filed. A bridge that names no post is answered by id alone.
    const offeredPosts = body.commentPosts && typeof body.commentPosts === 'object' ? body.commentPosts : {};
    const postIdByComment = new Map(commentIds.flatMap((id) => {
      const postId = Object.hasOwn(offeredPosts, id) ? offeredPosts[id] : null;
      return typeof postId === 'string' && postId !== '' ? [[id, postId] as const] : [];
    }));

    // The session names the division, and so the Page whose channel is asked.
    const home = await bridgeSessionHome(ctx.control, body.sessionKey ?? body.tenantId);
    if (!home || home.tenantId !== body.tenantId) return reply.status(400).send();

    const { known, knownComments } = await withTenant(ctx.db, home.tenantId, async (tx) => {
      const scope = { tx, tenantId: home.tenantId, kek: ctx.kek, divisionId: home.divisionId };
      const comments = [...await knownFacebookCommentIds(scope, { commentIds, postIdByComment })];
      const channel = externalIds.length > 0 ? await findMessengerBridgeChannel(scope) : null;
      if (!channel) return { known: [] as string[], knownComments: comments };
      const found = await knownMessengerMessageIds(scope, {
        channelId: channel.channelId, providerMessageIds: externalIds,
      });
      return { known: [...found], knownComments: comments };
    }, { divisionId: home.divisionId });

    if (commentIds.length > 0) {
      req.log.info({
        event: 'fb_comment_known_checked', tenantId: home.tenantId, divisionId: home.divisionId,
        asked: commentIds.length, known: knownComments.length,
      }, 'fb_comment_known_checked');
    }
    return reply.send({ known, knownComments });
  });

  app.post('/v1/webhooks/fb-bridge', async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${ctx.env.FB_BRIDGE_SECRET}`) {
      req.log.warn({ ip: req.ip }, 'fb-bridge webhook rejected: bad secret');
      webhookEvents.inc({ provider: 'fb_bridge', outcome: 'bad_signature' });
      return reply.status(401).send();
    }

    const body = req.body as {
      tenantId?: string; sessionKey?: string; event?: string; at?: string; error?: string;
      message?: {
        threadId?: string; externalMessageId?: string | null; senderId?: string; senderName?: string;
        text?: string; sentAt?: string | null; direction?: string; seq?: number;
      };
      comment?: {
        commentId?: string; postId?: string; parentCommentId?: string | null;
        authorId?: string | null; authorName?: string;
        text?: string; commentedAt?: string | null; pageId?: string; pageName?: string | null;
      };
    };
    if (!body.tenantId || !body.event) {
      webhookEvents.inc({ provider: 'fb_bridge', outcome: 'invalid_payload' });
      return reply.status(400).send();
    }

    // The session key names which division's Page this came off; a bridge
    // that predates divisions sends none and is reporting for Marketing —
    // whose key is the bare tenant id, so every dedupe string below is
    // byte-identical to what is already spooled.
    const sessionKey = body.sessionKey ?? body.tenantId;
    const home = await bridgeSessionHome(ctx.control, sessionKey);
    if (!home || home.tenantId !== body.tenantId) {
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
    const commentIds = c ? {
      tenantId: home.tenantId, divisionId: home.divisionId, sessionKey,
      pageId: c.pageId ?? null, postId: c.postId ?? null, commentId: c.commentId ?? null,
      parentCommentId: c.parentCommentId ?? null, authorId: c.authorId ?? null,
    } : null;
    // `postId` must be the string the bridge parsed: a stored post is compared
    // against it, and anything else would read as a moved post on every offer.
    if (body.event === 'comment' && !(c?.commentId && typeof c.postId === 'string' && c.postId && c.pageId && c.text)) {
      webhookEvents.inc({ provider: 'fb_bridge', outcome: 'invalid_payload' });
      // Named, not silent: a comment refused here is gone until the bridge
      // offers it again, and "why" is the only thing worth keeping of it.
      const missing = (['commentId', 'postId', 'pageId', 'text'] as const)
        .filter((k) => !c?.[k] || (k === 'postId' && typeof c?.postId !== 'string'));
      req.log.warn({ event: 'fb_comment_webhook_rejected', ...commentIds, missing }, 'fb_comment_webhook_rejected');
      return reply.status(400).send();
    }

    const externalId = facebookExternalId(sessionKey, body.event, m, c);

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
        [externalId, JSON.stringify({ ...body, sessionKey })],
      ));

    // A comment the spool calls a duplicate may still never have been stored:
    // the worker marks the row processed BEFORE it does the work, so one that
    // died in between left a claimed row and no comment — and the bridge,
    // which asks the CRM what it holds, keeps offering it. Only the comment
    // table can say whether that offer is a repeat. Not stored means the row
    // is taken again; `recordFacebookComment` is idempotent on the comment id,
    // so an offer racing a slow first attempt still stores one row. Stored
    // under a different post is taken again too: Facebook re-issued the post's
    // slug, and the worker moves the one existing row onto it.
    let spooledRow = inserted[0] ?? null;
    let respooled = false;
    let respoolReason: 'not_stored' | 'post_moved' | null = null;
    if (!spooledRow && body.event === 'comment' && c?.commentId) {
      const stored = await withTenant(ctx.db, home.tenantId, (tx) =>
        storedFacebookCommentPosts(
          { tx, tenantId: home.tenantId, kek: ctx.kek, divisionId: home.divisionId }, { commentIds: [c.commentId!] }),
      { divisionId: home.divisionId });
      const storedPostId = stored.get(c.commentId);
      if (storedPostId !== c.postId) {
        respoolReason = storedPostId === undefined ? 'not_stored' : 'post_moved';
        const retaken = await withoutTenant(ctx.control, 're-spooling a comment not stored as offered', (tx) =>
          tx.query<{ id: string }>(
            `update webhook_events
                set status = 'received', payload = $2, error = null, processed_at = null
              where provider = 'fb_bridge' and external_id = $1 and status = 'processed'
              returning id`,
            [externalId, JSON.stringify({ ...body, sessionKey })],
          ));
        spooledRow = retaken[0] ?? null;
        respooled = spooledRow !== null;
      }
    }

    const outcome = respooled ? 'respooled' : spooledRow ? 'accepted' : 'duplicate';
    webhookEvents.inc({ provider: 'fb_bridge', outcome: spooledRow ? 'accepted' : 'duplicate' });
    req.log.info({ tenantId: body.tenantId, event: body.event, outcome }, 'fb-bridge webhook received');
    if (commentIds) {
      req.log.info({
        event: 'fb_comment_webhook_received', ...commentIds, spool: outcome, webhookEventId: spooledRow?.id ?? null,
        ...(respooled ? { respoolReason } : {}),
      }, 'fb_comment_webhook_received');
    }
    if (spooledRow) {
      await ctx.dispatch({ queue: 'inbound.normalise', payload: { webhookEventId: spooledRow.id } });
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
 *
 * Keyed on the bridge session, which names the division's Page. Marketing's
 * session key is the tenant id itself, so every key minted before divisions
 * existed is still the key that event maps to today.
 */
export function facebookExternalId(
  sessionKey: string,
  event: string,
  message: { threadId?: string; externalMessageId?: string | null; senderId?: string; seq?: number; text?: string } | null,
  comment: { commentId?: string } | null,
): string {
  if (message) {
    // Facebook's own id when it exists — an identity it assigned beats one we
    // derived, and it stays stable even if the text is edited afterwards.
    if (message.externalMessageId) return `fb_dm:${sessionKey}:${message.externalMessageId}`;
    return crypto.createHash('sha256')
      .update(`fb_dm:${sessionKey}:${message.threadId}:${message.senderId}:${message.seq}:${message.text}`)
      .digest('hex');
  }
  if (comment) return `fb_comment:${sessionKey}:${comment.commentId}`;
  // Session-state events are status transitions, not customer data that must
  // never duplicate, so the clock stands in for an id the same way the
  // wa-bridge route already does for its lifecycle events.
  return `fb_bridge:${sessionKey}:${event}:${Date.now()}`;
}
