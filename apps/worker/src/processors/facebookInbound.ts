import crypto from 'node:crypto';
import {
  withTenant, findMessengerBridgeChannel, ingestInboundMessengerMessage, recordMessengerAgentReply,
  recordFacebookComment, setFbBridgeConnection, bridgeSessionHome,
} from '@kirana/db';
import type { NormaliseDeps } from './inboundNormalise.ts';

/**
 * `apps/fb-bridge`'s events, turned into rows.
 *
 * Its own file rather than another branch inside `inboundNormalise.ts` for two
 * reasons: that file is shared ground every channel's work lands in at once,
 * and — more usefully — everything here runs inside `withTenant`, because
 * `apps/fb-bridge` states the tenant in its payload. The one control-plane
 * read is turning the bridge's session key into the division it was issued
 * for (`bridgeSessionHome`, ids only); from there on it stays inside row-level
 * security, pinned to that division, from the first query to the last.
 */

/** Re-declared rather than imported from `apps/fb-bridge`: the two services
 * deploy separately, so a shared type would claim a coupling that does not
 * exist. The webhook route validates every field this relies on before the
 * payload is ever spooled, and adds `sessionKey` (the bridge's own when it
 * sent one, else the tenant id — Marketing's key). */
export type FbBridgeEventPayload =
  | {
      tenantId: string; sessionKey?: string; event: 'message'; at?: string;
      message: {
        threadId: string; externalMessageId: string | null; senderId: string; senderName: string;
        text: string; sentAt: string | null; direction: 'inbound' | 'outbound'; seq: number;
      };
    }
  | {
      tenantId: string; sessionKey?: string; event: 'comment'; at?: string;
      comment: {
        commentId: string; postId: string; authorId: string | null; authorName: string;
        text: string; commentedAt: string | null; pageId: string; pageName: string | null;
      };
    }
  | { tenantId: string; sessionKey?: string; event: 'session_error'; at?: string; error: string; needsLogin?: boolean };

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
 *
 * Keyed on the bridge session, which names the division's Page. Marketing's
 * session key is the tenant id itself, so every key minted before divisions
 * existed is still the key that message maps to today.
 */
export function facebookMessageKey(
  sessionKey: string,
  message: { threadId: string; externalMessageId: string | null; senderId: string; seq: number; text: string },
): string {
  if (message.externalMessageId) return `fb_dm:${sessionKey}:${message.externalMessageId}`;
  return crypto.createHash('sha256')
    .update(`fb_dm:${sessionKey}:${message.threadId}:${message.senderId}:${message.seq}:${message.text}`)
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
  // Which division's Page this came off. A bridge from before divisions sends
  // no session key and is reporting for Marketing, whose key is the bare
  // tenant id — so its events, and their dedupe keys, are unchanged.
  const sessionKey = payload.sessionKey ?? payload.tenantId;
  const home = await bridgeSessionHome(deps.control, sessionKey);
  if (!home || home.tenantId !== payload.tenantId) {
    console.error(`[fb-bridge] event for unknown session ${sessionKey} (tenant ${payload.tenantId})`);
    return await fail(`unknown fb-bridge session ${sessionKey}`);
  }
  const scope = { divisionId: home.divisionId };
  const ctxOf = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
    ({ tx, tenantId: home.tenantId, kek: deps.kek, divisionId: home.divisionId });

  if (payload.event === 'session_error') {
    // Loud and terminal. Facebook wants a human — the operator has to open the
    // login window and finish there — so this marks the channel unusable rather
    // than leaving it looking healthy while delivering nothing. Only this
    // division's Page: the other division's session is a different browser.
    await withTenant(deps.db, home.tenantId, async (tx) => {
      await setFbBridgeConnection(ctxOf(tx), {
        status: payload.needsLogin ? 'checkpoint_required' : 'error',
        lastError: payload.error,
        actorId: null,
      });
      await tx.query(
        `update channels set status = 'error'
          where tenant_id = $1 and division_id = $2 and kind = 'messenger_bridge'`,
        [home.tenantId, home.divisionId],
      );
    }, scope);
    return { status: 'processed' };
  }

  if (payload.event === 'comment') {
    const c = payload.comment;
    // No channel lookup and no conversation: a comment belongs to a Page and a
    // post, not to a thread with one person in it. Nothing here replies, sends
    // a DM, moves anyone to WhatsApp, or reaches a chatbot.
    const result = await withTenant(deps.db, home.tenantId, (tx) =>
      recordFacebookComment(ctxOf(tx), {
        pageId: c.pageId, pageName: c.pageName, postId: c.postId, commentId: c.commentId,
        authorExternalId: c.authorId, authorName: c.authorName, body: c.text,
        commentedAt: parseAt(c.commentedAt) ?? null,
      }), scope);
    console.log(`[fb-bridge] comment ${result.duplicate ? 'duplicate, skipped' : 'recorded'}: ${c.commentId} on post ${c.postId}`);
    return { status: 'processed' };
  }

  const m = payload.message;
  const channel = await withTenant(deps.db, home.tenantId, (tx) =>
    findMessengerBridgeChannel(ctxOf(tx)), scope);
  if (!channel) {
    // Deliberately a hard failure with an instruction attached, not a silent
    // drop: the fix is one action in the console, and a message that vanished
    // quietly is a customer nobody answers.
    console.error(
      `[fb-bridge] no 'messenger_bridge' channel for session ${sessionKey} — `
      + 'connect a Page from Pengaturan → Facebook so the channel row gets created',
    );
    return await fail(`no messenger_bridge channel for session ${sessionKey}`);
  }

  // Identity is the id out of the thread URL either way. The display name is
  // carried alongside for the inbox to show, and only ever fills an empty
  // contact name — never matches one.
  const common = {
    channelId: channel.channelId,
    fbUserId: m.senderId,
    threadId: m.threadId,
    body: m.text,
    providerMessageId: facebookMessageKey(sessionKey, m),
    displayName: m.senderName,
    providerTs: parseAt(m.sentAt),
  };

  // An 'outbound' event is history: a reply the Page already sent, found while
  // reconciling a thread. It is written straight in as sent, with no outbox row
  // — queueing it would deliver it to a real person a second time.
  const result = m.direction === 'outbound'
    ? await withTenant(deps.db, home.tenantId, (tx) => recordMessengerAgentReply(ctxOf(tx), common), scope)
    : await withTenant(deps.db, home.tenantId, (tx) => ingestInboundMessengerMessage(ctxOf(tx), common), scope);

  console.log(`[fb-bridge] ${m.direction} message ${result.duplicate ? 'duplicate, skipped' : 'ingested'}: thread ${m.threadId}`);

  if (!result.duplicate) {
    deps.publish?.(home.tenantId, {
      type: 'message', conversationId: result.conversationId, divisionId: home.divisionId,
    });
  }

  // NO AUTOPILOT, NO BD, NO CHATBOT. The original reason — that `outboundSend`
  // had no `messenger_bridge` branch, so a draft would fall through to the Meta
  // Graph sender this feature exists to avoid — no longer holds: that branch
  // exists and drives the bridge. What remains is a product decision rather
  // than a technical one. Every Facebook send goes through a real browser on
  // somebody's machine, against Terms of Service, with a session that can be
  // checkpointed; putting a generated reply on that path without anyone asking
  // for it is not a default worth choosing. Wiring it up is a deliberate
  // follow-up, not an oversight.

  return { status: 'processed' };
}
