import crypto from 'node:crypto';
import {
  withTenant, withoutTenant, ingestInboundMessage, ingestInboundInstagramMessage, ingestInboundInstagramDmMessage,
  recordPhoneReply, recordIgBridgeAgentReply, advanceDealsOnEvent, getDecryptedIgToken, type Database,
} from '@kirana/db';

const IG_GRAPH_URL = 'https://graph.instagram.com';

export interface NormaliseDeps {
  db: Database;
  control: Database;
  kek: Buffer;
  dispatch: (job: { queue: string; payload: unknown }) => Promise<void>;
  /** Told about every new message so an open console can refresh instead of polling. Optional: nothing breaks without a listener. */
  publish?: (tenantId: string, event: { type: 'message'; conversationId: string }) => void;
}

/**
 * Turns one spooled provider payload into domain rows.
 *
 * The whole job is idempotent: the spool row is claimed with a status check,
 * and ingestion dedupes on the provider's message id. Replaying the queue after
 * an incident is therefore safe, which is the property that lets us replay at all.
 */
export async function processInboundWebhook(deps: NormaliseDeps, webhookEventId: string): Promise<{ status: string }> {
  const claimedRows = await withoutTenant(deps.control, 'claiming a spooled webhook', (tx) =>
    tx.query<{ id: string; provider: string; payload: Record<string, unknown> | string }>(
      `update webhook_events set status = 'processed', processed_at = now()
        where id = $1 and status = 'received'
        returning id, provider, payload`,
      [webhookEventId],
    ));
  // PGlite (tests, dev-stack) hands `payload` back already parsed; postgres-js
  // (the real driver) returns the raw jsonb text — same defensive check
  // audit.ts/documents.ts/security.ts already use for their own jsonb reads.
  const claimed = claimedRows.map((r) => ({
    ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) as Record<string, unknown> : r.payload,
  }));

  if (!claimed[0]) return { status: 'already_processed' };
  // Same spool, same idempotency barrier, different shape on the wire — the
  // bridge is its own provider rather than pretending to be Meta.
  if (claimed[0].provider === 'wa_bridge') {
    return processWaBridgeEvent(deps, webhookEventId, claimed[0].payload as unknown as WaBridgeEventPayload);
  }
  if (claimed[0].provider === 'ig_bridge_dm') {
    return processIgBridgeDmEvent(deps, webhookEventId, claimed[0].payload as unknown as IgBridgeDmEventPayload);
  }
  if ((claimed[0].payload as { platform?: string }).platform === 'instagram') {
    return processInstagramEvent(deps, webhookEventId, claimed[0].payload as unknown as InstagramEventPayload);
  }

  const value = claimed[0].payload as {
    metadata?: { phone_number_id?: string };
    contacts?: { profile?: { name?: string }; wa_id?: string }[];
    messages?: { id: string; from: string; timestamp?: string; text?: { body?: string }; type?: string }[];
    statuses?: { id: string; status: string; conversation?: { id?: string; origin?: { type?: string } } }[];
  };

  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return await fail(deps, webhookEventId, 'no phone_number_id in payload');

  // Channel → tenant. Read through the control pool: at this point we do not
  // yet know which tenant context to open.
  const channels = await withoutTenant(deps.control, 'resolving channel to tenant', (tx) =>
    tx.query<{ id: string; tenant_id: string }>(
      `select id, tenant_id from channels where kind = 'whatsapp' and external_id = $1`,
      [phoneNumberId],
    ));
  const channel = channels[0];
  if (!channel) return await fail(deps, webhookEventId, `unknown channel ${phoneNumberId}`);

  for (const message of value.messages ?? []) {
    const body = message.text?.body ?? `[${message.type ?? 'unsupported'} message]`;
    const profileName = value.contacts?.[0]?.profile?.name ?? null;
    const providerTs = message.timestamp ? new Date(Number(message.timestamp) * 1000) : undefined;

    const result = await withTenant(deps.db, channel.tenant_id, (tx) =>
      ingestInboundMessage({ tx, tenantId: channel.tenant_id, kek: deps.kek }, {
        channelId: channel.id, from: message.from, body,
        providerMessageId: message.id, displayName: profileName, providerTs,
      }));

    if (!result.duplicate) {
      deps.publish?.(channel.tenant_id, { type: 'message', conversationId: result.conversationId });
      await deps.dispatch({
        queue: 'autopilot.draft',
        payload: { tenantId: channel.tenant_id, conversationId: result.conversationId, messageId: result.messageId },
      });
    }
  }

  for (const status of value.statuses ?? []) {
    await withTenant(deps.db, channel.tenant_id, async (tx) => {
      await tx.query(
        `update messages set status = $3
          where tenant_id = $1 and provider_message_id = $2 and status <> 'read'`,
        [channel.tenant_id, status.id, status.status],
      );
    });
  }

  return { status: 'processed' };
}

/**
 * Payment and quotation events from the billing side advance deals with no
 * human dragging a card. Same entry point for Xendit, Midtrans or our own Billing module.
 */
export async function processCommerceEvent(
  deps: NormaliseDeps,
  ev: { tenantId: string; contactId: string; event: string },
): Promise<{ moved: number }> {
  const moved = await withTenant(deps.db, ev.tenantId, (tx) =>
    advanceDealsOnEvent({ tx, tenantId: ev.tenantId, kek: deps.kek }, {
      contactId: ev.contactId, event: ev.event,
    }));
  return { moved: moved.length };
}

/* --------------------------------------------------------------- wa-bridge */

export interface WaBridgeEventPayload {
  channelId: string;
  event: 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'auth_failure' | 'message';
  qr?: { dataUrl: string; expiresInMs: number };
  ready?: { phoneE164: string };
  disconnected?: { reason: string };
  message?: {
    id: string; from: string; to: string; body: string; type: string;
    timestampSec: number; fromMe: boolean; displayName: string | null;
  };
}

/**
 * The bridge reports both session lifecycle (qr, ready, disconnected…) and
 * chat messages through the same event, because both need the same first
 * step: turning a `channelId` into the tenant that owns it. Everything after
 * that step runs inside that tenant's context, same as the Meta path.
 */
async function processWaBridgeEvent(
  deps: NormaliseDeps, webhookEventId: string, payload: WaBridgeEventPayload,
): Promise<{ status: string }> {
  const channels = await withoutTenant(deps.control, 'resolving wa-bridge channel to tenant', (tx) =>
    tx.query<{ id: string; tenant_id: string }>(
      `select id, tenant_id from channels where kind = 'whatsapp_web' and id = $1`,
      [payload.channelId],
    ));
  const channel = channels[0];
  if (!channel) return await fail(deps, webhookEventId, `unknown wa-bridge channel ${payload.channelId}`);

  if (payload.event === 'message') {
    const m = payload.message;
    if (!m) return { status: 'processed' };

    // A message the owner typed on their own phone, outside the console,
    // still reaches us as `fromMe` — recorded on the same conversation as an
    // outbound message so the transcript stays complete either way, deduped
    // against whatever the console itself already queued and sent.
    if (m.fromMe) {
      const result = await withTenant(deps.db, channel.tenant_id, (tx) =>
        recordPhoneReply({ tx, tenantId: channel.tenant_id, kek: deps.kek }, {
          channelId: channel.id, to: m.to, body: m.body || `[${m.type} message]`,
          displayName: m.displayName, providerMessageId: m.id, providerTs: new Date(m.timestampSec * 1000),
        }));
      if (!result.duplicate) deps.publish?.(channel.tenant_id, { type: 'message', conversationId: result.conversationId });
      return { status: 'processed' };
    }

    const result = await withTenant(deps.db, channel.tenant_id, (tx) =>
      ingestInboundMessage({ tx, tenantId: channel.tenant_id, kek: deps.kek }, {
        channelId: channel.id, from: m.from, body: m.body || `[${m.type} message]`,
        displayName: m.displayName, providerMessageId: m.id, providerTs: new Date(m.timestampSec * 1000),
      }));

    if (!result.duplicate) {
      deps.publish?.(channel.tenant_id, { type: 'message', conversationId: result.conversationId });
      await deps.dispatch({
        queue: 'autopilot.draft',
        payload: { tenantId: channel.tenant_id, conversationId: result.conversationId, messageId: result.messageId },
      });
    }
    return { status: 'processed' };
  }

  await withTenant(deps.db, channel.tenant_id, async (tx) => {
    switch (payload.event) {
      case 'qr':
        if (!payload.qr) break;
        await tx.query(
          `update wa_bridge_sessions
              set status = 'qr_pending', qr_data = $3, qr_expires_at = $4, updated_at = now()
            where tenant_id = $1 and channel_id = $2`,
          [channel.tenant_id, channel.id, payload.qr.dataUrl, new Date(Date.now() + payload.qr.expiresInMs)],
        );
        break;
      case 'authenticated':
        await tx.query(
          `update wa_bridge_sessions set status = 'authenticated', qr_data = null, updated_at = now()
            where tenant_id = $1 and channel_id = $2`,
          [channel.tenant_id, channel.id],
        );
        break;
      case 'ready':
        await tx.query(
          `update wa_bridge_sessions
              set status = 'ready', phone_e164 = $3, qr_data = null, last_seen_at = now(), updated_at = now()
            where tenant_id = $1 and channel_id = $2`,
          [channel.tenant_id, channel.id, payload.ready?.phoneE164 ?? null],
        );
        await tx.query(
          `update channels set status = 'connected', phone_e164 = $3 where tenant_id = $1 and id = $2`,
          [channel.tenant_id, channel.id, payload.ready?.phoneE164 ?? null],
        );
        break;
      case 'disconnected':
      case 'auth_failure':
        await tx.query(
          `update wa_bridge_sessions set status = $3, last_error = $4, updated_at = now()
            where tenant_id = $1 and channel_id = $2`,
          [channel.tenant_id, channel.id, payload.event === 'auth_failure' ? 'error' : 'disconnected',
           payload.disconnected?.reason ?? payload.event],
        );
        await tx.query(`update channels set status = 'error' where tenant_id = $1 and id = $2`,
          [channel.tenant_id, channel.id]);
        break;
    }
  });

  return { status: 'processed' };
}

/* --------------------------------------------------------------- instagram */

export interface InstagramEventPayload {
  platform: 'instagram';
  igAccountId: string;
  messagingEvent: {
    sender?: { id?: string };
    recipient?: { id?: string };
    timestamp?: number;
    message?: { mid?: string; text?: string; is_echo?: boolean };
  };
}

/**
 * Instagram's webhook is Messenger-Platform-shaped, not the `changes[].value`
 * shape WhatsApp Business Account uses — `apps/api`'s webhook route already
 * told them apart at spool time, so this only ever sees the Instagram shape.
 */
async function processInstagramEvent(
  deps: NormaliseDeps, webhookEventId: string, payload: InstagramEventPayload,
): Promise<{ status: string }> {
  const m = payload.messagingEvent.message;
  if (!m?.mid) return { status: 'processed' };

  // Meta echoes a message this app itself just sent back through the same
  // webhook, flagged `is_echo` — `queueOutboundMessage` already recorded it
  // once at send time, so the echo is acknowledged and dropped, not ingested
  // a second time as if it were new.
  if (m.is_echo) return { status: 'processed' };

  const channels = await withoutTenant(deps.control, 'resolving instagram channel to tenant', (tx) =>
    tx.query<{ id: string; tenant_id: string }>(
      `select id, tenant_id from channels where kind = 'instagram' and external_id = $1`,
      [payload.igAccountId],
    ));
  const channel = channels[0];
  if (!channel) return await fail(deps, webhookEventId, `unknown instagram channel ${payload.igAccountId}`);

  const psid = payload.messagingEvent.sender?.id;
  if (!psid) return await fail(deps, webhookEventId, 'instagram message with no sender psid');

  // Instagram's webhook carries no profile info the way WhatsApp's does
  // inline (`contacts[].profile.name`) — a lookup is the only way to show
  // something better than the bare psid. Best-effort: a contact still gets
  // recorded even when this fails, just without a name yet.
  const displayName = await withTenant(deps.db, channel.tenant_id, async (tx) => {
    const ig = await getDecryptedIgToken({ tx, tenantId: channel.tenant_id, kek: deps.kek });
    if (!ig) return null;
    try {
      const res = await fetch(`${IG_GRAPH_URL}/${psid}?${new URLSearchParams({
        fields: 'username', access_token: ig.accessToken,
      })}`);
      if (!res.ok) return null;
      const profile = await res.json() as { username?: string };
      return profile.username ?? null;
    } catch {
      return null;
    }
  });

  const result = await withTenant(deps.db, channel.tenant_id, (tx) =>
    ingestInboundInstagramMessage({ tx, tenantId: channel.tenant_id, kek: deps.kek }, {
      channelId: channel.id, psid, body: m.text || '[unsupported message]',
      providerMessageId: m.mid!, displayName,
      providerTs: payload.messagingEvent.timestamp ? new Date(payload.messagingEvent.timestamp) : undefined,
    }));

  if (!result.duplicate) {
    deps.publish?.(channel.tenant_id, { type: 'message', conversationId: result.conversationId });
    await deps.dispatch({
      queue: 'autopilot.draft',
      payload: { tenantId: channel.tenant_id, conversationId: result.conversationId, messageId: result.messageId },
    });
  }
  return { status: 'processed' };
}

/* ----------------------------------------------------------------- ig-bridge */

export type IgBridgeDmEventPayload =
  | {
      tenantId: string; event: 'message';
      message: {
        threadId: string; participantUsername: string; senderUsername: string; text: string;
        direction: 'inbound' | 'outbound'; index: number;
      };
    }
  | { tenantId: string; event: 'session_error'; error: string };

/**
 * `apps/ig-bridge`'s scraped counterpart to `processInstagramEvent` — same
 * destination rows, different source and a different identity column
 * (`ingestInboundInstagramDmMessage`/`recordIgBridgeAgentReply` key on
 * @username, not an IGSID, since scraping never sees one). `direction`
 * tells the two apart: an 'outbound' event is a reply the connected account
 * sent from the real Instagram app itself — `DmWatcher` already recognises
 * (and skips re-reporting) anything sent *through* the console, so every
 * 'outbound' event that reaches here genuinely came from the phone.
 */
async function processIgBridgeDmEvent(
  deps: NormaliseDeps, webhookEventId: string, payload: IgBridgeDmEventPayload,
): Promise<{ status: string }> {
  if (payload.event === 'session_error') {
    await withoutTenant(deps.control, 'recording an expired ig-bridge session', (tx) =>
      tx.query(
        `update ig_bridge_connections set status = 'error', last_error = $2, updated_at = now()
          where tenant_id = $1`,
        [payload.tenantId, payload.error],
      ));
    await withoutTenant(deps.control, 'marking the ig-bridge channel disconnected', (tx) =>
      tx.query(`update channels set status = 'error' where tenant_id = $1 and kind = 'instagram_bridge'`,
        [payload.tenantId]));
    return { status: 'processed' };
  }

  const channels = await withoutTenant(deps.control, 'resolving ig-bridge channel to tenant', (tx) =>
    tx.query<{ id: string }>(
      `select id from channels where tenant_id = $1 and kind = 'instagram_bridge'`,
      [payload.tenantId],
    ));
  const channel = channels[0];
  if (!channel) {
    console.error(`[ig-bridge-dm] no 'instagram_bridge' channel found for tenant ${payload.tenantId} — reconnect from Pengaturan → Instagram so the channel row gets (re)created`);
    return await fail(deps, webhookEventId, `no ig-bridge channel for tenant ${payload.tenantId}`);
  }

  // Keyed on the sender and the message's position in the thread, not just
  // its text (mirrors the hash the webhook route already committed the
  // spool row under) — scraping gives no real per-message id, so a
  // repeated word sent at two different times would otherwise hash
  // identically to its own earlier occurrence and vanish as a false
  // duplicate every time after the first.
  const externalId = crypto.createHash('sha256')
    .update(`ig_dm:${payload.tenantId}:${payload.message.threadId}:${payload.message.senderUsername}:${payload.message.index}:${payload.message.text}`)
    .digest('hex');

  // Scraping never sees a contact's real display name, only their @handle —
  // both repo calls default a new contact's `display_name` to null when
  // nothing is passed here, which is what left every ig-bridge contact
  // showing "—" in the console instead of anything at all. The @handle is
  // the only identity this bridge ever has, so it's what gets used; it only
  // applies on first creation (`upsertContactByIgUsername` coalesces against
  // whatever's already there), so a name filled in by hand later stays put.
  const result = payload.message.direction === 'outbound'
    ? await withTenant(deps.db, payload.tenantId, (tx) =>
        recordIgBridgeAgentReply({ tx, tenantId: payload.tenantId, kek: deps.kek }, {
          channelId: channel.id, username: payload.message.participantUsername, threadId: payload.message.threadId,
          body: payload.message.text, providerMessageId: externalId,
          displayName: payload.message.participantUsername,
        }))
    : await withTenant(deps.db, payload.tenantId, (tx) =>
        ingestInboundInstagramDmMessage({ tx, tenantId: payload.tenantId, kek: deps.kek }, {
          channelId: channel.id, username: payload.message.participantUsername, threadId: payload.message.threadId,
          body: payload.message.text, providerMessageId: externalId,
          displayName: payload.message.participantUsername,
        }));

  console.log(`[ig-bridge-dm] ${result.duplicate ? 'duplicate, skipped' : 'ingested'} (${payload.message.direction}): ${payload.message.participantUsername} in thread ${payload.message.threadId}`);

  if (!result.duplicate) {
    deps.publish?.(payload.tenantId, { type: 'message', conversationId: result.conversationId });
    // A reply the agent already sent — from the console or, here, from
    // their own phone — needs no autopilot draft; there is nothing new for
    // it to answer.
    if (payload.message.direction === 'inbound') {
      await deps.dispatch({
        queue: 'autopilot.draft',
        payload: { tenantId: payload.tenantId, conversationId: result.conversationId, messageId: result.messageId },
      });
    }
  }
  return { status: 'processed' };
}

async function fail(deps: NormaliseDeps, id: string, reason: string) {
  await withoutTenant(deps.control, 'marking a webhook unprocessable', (tx) =>
    tx.query(`update webhook_events set status = 'failed', error = $2 where id = $1`, [id, reason]));
  return { status: 'failed' };
}
