import crypto from 'node:crypto';
import {
  withTenant, findMessengerBridgeChannel, ingestInboundMessengerMessage, recordMessengerAgentReply,
  recordFacebookComment, setFbBridgeConnection,
} from '@kirana/db';
import type { NormaliseDeps } from './inboundNormalise.ts';

/**
 * `apps/fb-bridge`'s events, turned into rows.
 *
 * Its own file rather than another branch inside `inboundNormalise.ts` for two
 * reasons: that file is shared ground every channel's work lands in at once,
 * and — more usefully — everything here runs inside `withTenant`, because
 * `apps/fb-bridge` states the tenant in its payload. The other providers have
 * to resolve a channel to a tenant through the control pool before they know
 * whose context to open; this one never does, so it stays inside row-level
 * security from the first query to the last.
 */

/** Re-declared rather than imported from `apps/fb-bridge`: the two services
 * deploy separately, so a shared type would claim a coupling that does not
 * exist. The webhook route validates every field this relies on before the
 * payload is ever spooled. */
export type FbBridgeEventPayload =
  | {
      tenantId: string; event: 'message'; at?: string;
      message: {
        threadId: string; externalMessageId: string | null; senderId: string; senderName: string;
        text: string; sentAt: string | null; direction: 'inbound' | 'outbound';
      };
    }
  | {
      tenantId: string; event: 'comment'; at?: string;
      comment: {
        commentId: string; postId: string; authorId: string | null; authorName: string;
        text: string; commentedAt: string | null; pageId: string; pageName: string | null;
      };
    }
  | { tenantId: string; event: 'session_error'; at?: string; error: string; needsLogin?: boolean };

/**
 * The spool key, recomputed exactly as `apps/api/src/routes/webhooks.ts`
 * computed it.
 *
 * These two must agree byte for byte. The spool's unique index on
 * `(provider, external_id)` and `messages`' unique index on
 * `(tenant_id, channel_id, provider_message_id)` are two separate barriers
 * against the same redelivery, and if they keyed on different strings an event
 * that the spool correctly recognised as a duplicate could still reach the
 * second barrier under a fresh key and insert a second copy of a customer's
 * message. `tests/facebook-bridge.test.ts` asserts the two stay identical.
 */
export function facebookMessageKey(
  tenantId: string,
  message: { threadId: string; externalMessageId: string | null; senderId: string; sentAt: string | null; text: string },
): string {
  if (message.externalMessageId) return `fb_dm:${tenantId}:${message.externalMessageId}`;
  // `sentAt` rather than a sequence number, because a counter belongs to the
  // process that read the message and not to the message: it restarted at zero
  // with the bridge and hashed a customer's new text to the key their earlier
  // identical text already held, which the spool then discarded as a
  // redelivery. `compositeMessageKey` in apps/fb-bridge/src/events.ts carries
  // the full account.
  return crypto.createHash('sha256')
    .update(`fb_dm:${tenantId}:${message.threadId}:${message.senderId}:${message.sentAt}:${message.text}`)
    .digest('hex');
}

/** An ISO string from the bridge, or undefined when it had none. Never a
 * guess: a wrong `provider_ts` silently reorders a conversation, which is
 * worse than having no provider timestamp and falling back to arrival. */
function parseAt(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

export async function processFbBridgeEvent(
  deps: NormaliseDeps,
  payload: FbBridgeEventPayload,
  fail: (reason: string) => Promise<{ status: string }>,
): Promise<{ status: string }> {
  if (payload.event === 'session_error') {
    // Loud and terminal. Facebook wants a human — the operator has to open the
    // login window and finish there — so this marks the channel unusable rather
    // than leaving it looking healthy while delivering nothing.
    await withTenant(deps.db, payload.tenantId, async (tx) => {
      const ctx = { tx, tenantId: payload.tenantId, kek: deps.kek };
      await setFbBridgeConnection(ctx, {
        status: payload.needsLogin ? 'checkpoint_required' : 'error',
        lastError: payload.error,
        actorId: null,
      });
      await tx.query(
        `update channels set status = 'error' where tenant_id = $1 and kind = 'messenger_bridge'`,
        [payload.tenantId],
      );
    });
    return { status: 'processed' };
  }

  if (payload.event === 'comment') {
    const c = payload.comment;
    // No channel lookup and no conversation: a comment belongs to a Page and a
    // post, not to a thread with one person in it. Nothing here replies, sends
    // a DM, moves anyone to WhatsApp, or reaches a chatbot.
    const result = await withTenant(deps.db, payload.tenantId, (tx) =>
      recordFacebookComment({ tx, tenantId: payload.tenantId, kek: deps.kek }, {
        pageId: c.pageId, pageName: c.pageName, postId: c.postId, commentId: c.commentId,
        authorExternalId: c.authorId, authorName: c.authorName, body: c.text,
        commentedAt: parseAt(c.commentedAt) ?? null,
      }));
    console.log(`[fb-bridge] comment ${result.duplicate ? 'duplicate, skipped' : 'recorded'}: ${c.commentId} on post ${c.postId}`);
    return { status: 'processed' };
  }

  const m = payload.message;
  const channel = await withTenant(deps.db, payload.tenantId, (tx) =>
    findMessengerBridgeChannel({ tx, tenantId: payload.tenantId, kek: deps.kek }));
  if (!channel) {
    // Deliberately a hard failure with an instruction attached, not a silent
    // drop: the fix is one action in the console, and a message that vanished
    // quietly is a customer nobody answers.
    console.error(
      `[fb-bridge] no 'messenger_bridge' channel for tenant ${payload.tenantId} — `
      + 'connect a Page from Pengaturan → Facebook so the channel row gets created',
    );
    return await fail(`no messenger_bridge channel for tenant ${payload.tenantId}`);
  }

  // Identity is the id out of the thread URL either way. The display name is
  // carried alongside for the inbox to show, and only ever fills an empty
  // contact name — never matches one.
  const common = {
    channelId: channel.channelId,
    fbUserId: m.senderId,
    threadId: m.threadId,
    body: m.text,
    providerMessageId: facebookMessageKey(payload.tenantId, m),
    displayName: m.senderName,
    providerTs: parseAt(m.sentAt),
  };

  // An 'outbound' event is history: a reply the Page already sent, found while
  // reconciling a thread. It is written straight in as sent, with no outbox row
  // — queueing it would deliver it to a real person a second time.
  const result = m.direction === 'outbound'
    ? await withTenant(deps.db, payload.tenantId, (tx) =>
        recordMessengerAgentReply({ tx, tenantId: payload.tenantId, kek: deps.kek }, common))
    : await withTenant(deps.db, payload.tenantId, (tx) =>
        ingestInboundMessengerMessage({ tx, tenantId: payload.tenantId, kek: deps.kek }, common));

  console.log(`[fb-bridge] ${m.direction} message ${result.duplicate ? 'duplicate, skipped' : 'ingested'}: thread ${m.threadId}`);

  if (!result.duplicate) {
    deps.publish?.(payload.tenantId, { type: 'message', conversationId: result.conversationId });
  }

  // NO AUTOPILOT, NO BD, NO CHATBOT — and this is a correctness decision, not
  // caution. `outboundSend` has no `messenger_bridge` branch, so a reply queued
  // against this channel falls through to the Meta Graph sender: it would try
  // to call graph.facebook.com, which this whole feature exists to avoid, and
  // would fail there anyway because the bridge has no send path to deliver it.
  // Drafting an answer nobody can send is worse than not drafting one — it
  // looks to an agent like the message was handled.
  //
  // Wiring this up is a deliberate follow-up that needs an outbound path first.

  return { status: 'processed' };
}
