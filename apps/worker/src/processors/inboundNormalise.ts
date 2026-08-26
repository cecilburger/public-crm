import { withTenant, withoutTenant, ingestInboundMessage, advanceDealsOnEvent, type Database } from '@kirana/db';

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
    tx.query<{ id: string; payload: Record<string, unknown> }>(
      `update webhook_events set status = 'processed', processed_at = now()
        where id = $1 and status = 'received'
        returning id, payload`,
      [webhookEventId],
    ));

  if (!claimed[0]) return { status: 'already_processed' };
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

async function fail(deps: NormaliseDeps, id: string, reason: string) {
  await withoutTenant(deps.control, 'marking a webhook unprocessable', (tx) =>
    tx.query(`update webhook_events set status = 'failed', error = $2 where id = $1`, [id, reason]));
  return { status: 'failed' };
}
