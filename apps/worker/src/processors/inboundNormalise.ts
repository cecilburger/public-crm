import { withTenant, withoutTenant, ingestInboundMessage, recordPhoneReply, advanceDealsOnEvent, type Database } from '@kirana/db';

export interface NormaliseDeps {
  db: Database;
  control: Database;
  kek: Buffer;
  dispatch: (job: { queue: string; payload: unknown }) => Promise<void>;
}

/**
 * Turns one spooled provider payload into domain rows.
 *
 * The whole job is idempotent: the spool row is claimed with a status check,
 * and ingestion dedupes on the provider's message id. Replaying the queue after
 * an incident is therefore safe, which is the property that lets us replay at all.
 */
export async function processInboundWebhook(deps: NormaliseDeps, webhookEventId: string): Promise<{ status: string }> {
  const claimed = await withoutTenant(deps.control, 'claiming a spooled webhook', (tx) =>
    tx.query<{ id: string; provider: string; payload: Record<string, unknown> }>(
      `update webhook_events set status = 'processed', processed_at = now()
        where id = $1 and status = 'received'
        returning id, provider, payload`,
      [webhookEventId],
    ));

  if (!claimed[0]) return { status: 'already_processed' };
  // Same spool, same idempotency barrier, different shape on the wire — the
  // bridge is its own provider rather than pretending to be Meta.
  if (claimed[0].provider === 'wa_bridge') {
    return processWaBridgeEvent(deps, webhookEventId, claimed[0].payload as unknown as WaBridgeEventPayload);
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
      await withTenant(deps.db, channel.tenant_id, (tx) =>
        recordPhoneReply({ tx, tenantId: channel.tenant_id, kek: deps.kek }, {
          channelId: channel.id, to: m.to, body: m.body || `[${m.type} message]`,
          displayName: m.displayName, providerMessageId: m.id, providerTs: new Date(m.timestampSec * 1000),
        }));
      return { status: 'processed' };
    }

    const result = await withTenant(deps.db, channel.tenant_id, (tx) =>
      ingestInboundMessage({ tx, tenantId: channel.tenant_id, kek: deps.kek }, {
        channelId: channel.id, from: m.from, body: m.body || `[${m.type} message]`,
        displayName: m.displayName, providerMessageId: m.id, providerTs: new Date(m.timestampSec * 1000),
      }));

    if (!result.duplicate) {
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

async function fail(deps: NormaliseDeps, id: string, reason: string) {
  await withoutTenant(deps.control, 'marking a webhook unprocessable', (tx) =>
    tx.query(`update webhook_events set status = 'failed', error = $2 where id = $1`, [id, reason]));
  return { status: 'failed' };
}
