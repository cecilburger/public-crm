/**
 * The wire contract between `apps/fb-bridge` and the CRM.
 *
 * This is the whole interface. The bridge knows nothing about tenants beyond
 * carrying an id it was handed, nothing about contacts, conversations or
 * billing, and it never touches the database — it posts one of these shapes to
 * `POST /v1/webhooks/fb-bridge` and that is the entire coupling.
 *
 * `apps/worker` re-declares the payload it parses rather than importing this
 * file, the same way it already does for `apps/ig-bridge`'s events: the two
 * services deploy separately, so a shared type would be a lie about how tightly
 * their versions are actually coupled. Keep the two in step by hand; the
 * webhook route validates every field it depends on and rejects with 400
 * rather than trusting the sender.
 */

/**
 * Which way a message went.
 *
 * 'outbound' is reported only while reconciling a thread's history — replies
 * the Page already sent, long ago, which the CRM needs so a conversation does
 * not read as a customer talking to nobody. They are stored as history and
 * never queued to be sent again.
 *
 * The live watcher still reports inbound only. Echoing back a reply the CRM
 * itself just sent would double it, and one the operator typed in the Facebook
 * app has no send record to dedupe against.
 */
export type Direction = 'inbound' | 'outbound';

export interface FbMessageEvent {
  event: 'message';
  tenantId: string;
  /** When the bridge emitted this, ISO-8601. Not when Facebook says it was
   * sent — that is `sentAt`, which may be missing. */
  at: string;
  message: {
    /** The `/messages/t/<id>` segment. Stable per conversation. */
    threadId: string;
    /**
     * Facebook's own message id (`mid.$...`) when the DOM exposes one, else
     * null. When it is present the CRM keys idempotency on it directly; when it
     * is not, the CRM falls back to a composite of thread + sender + `sentAt` +
     * a hash of the text. Text alone is never an identity: a customer sending
     * "halo" twice is two messages, not one.
     */
    externalMessageId: string | null;
    /** The other party's numeric Facebook id, read from the thread URL. This is
     * the contact identity; a display name is not. */
    senderId: string;
    senderName: string;
    text: string;
    /**
     * ISO-8601, from Facebook's own `data-utime` on the row.
     *
     * Required whenever `externalMessageId` is null, because it is then the
     * only thing keeping two identical texts apart — the watcher refuses to
     * emit a message that has neither. Null is therefore only possible
     * alongside a real `mid.$...`, which is already an identity on its own.
     */
    sentAt: string | null;
    direction: Direction;
  };
}

export interface FbCommentEvent {
  event: 'comment';
  tenantId: string;
  at: string;
  comment: {
    /** Facebook's own comment id — the idempotency key. A comment with no id
     * is dropped by the watcher rather than synthesised, because there would be
     * nothing to stop it being ingested again on the next reconciliation pass. */
    commentId: string;
    postId: string;
    authorId: string | null;
    authorName: string;
    text: string;
    commentedAt: string | null;
    /** Page/account context, carried on every comment: a comment belongs to a
     * Page, not to a conversation, so there is no channel row to infer it from. */
    pageId: string;
    pageName: string | null;
  };
}

/**
 * Loud by design. Every condition an operator has to physically act on —
 * session expired, a checkpoint, a two-factor prompt, a selector that stopped
 * matching — arrives here rather than being retried silently. `needsLogin`
 * separates "a human must open the browser window and log in" from "something
 * broke but the session is probably fine".
 */
export interface FbSessionErrorEvent {
  event: 'session_error';
  tenantId: string;
  at: string;
  error: string;
  needsLogin: boolean;
}

export type FbBridgeEvent = FbMessageEvent | FbCommentEvent | FbSessionErrorEvent;

/**
 * The composite fallback id, in one place so the bridge and the CRM cannot
 * drift apart on it.
 *
 * Both sides must produce byte-identical strings: `apps/api` commits the spool
 * row under this key and `apps/worker` writes `messages.provider_message_id`
 * under it, and if the two disagreed a redelivered event would pass the first
 * barrier and insert a second copy at the second. The CRM has its own copy of
 * this function for exactly that reason — it does not import this file — so any
 * change here has to be made in `apps/worker/src/processors/facebookInbound.ts`
 * too, and the test suite asserts the two agree.
 *
 * WHY `sentAt` AND NOT A COUNTER. This used to interpolate a per-thread
 * sequence number the watcher handed out in memory. A counter is not a
 * property of the message — it is a property of the process that saw it — so
 * it restarted at zero every time the bridge did, and `tsx watch` restarts on
 * every save. After a restart a customer's new "halo" got seq 0 again and
 * hashed to exactly what their first "halo" had hashed to, whereupon the spool
 * discarded it as a redelivery and the message was never seen by anyone. That
 * is the same failure `apps/ig-bridge` shipped with its unpersisted
 * `.thread-sequences.json`, and persisting this one would only have moved the
 * problem onto a file that can be lost or copied between machines.
 *
 * `sentAt` belongs to the message: Facebook's own `data-utime`, the same value
 * on every read, on every restart, and from either transport. The residual
 * collision is two identical texts in one thread within the same second with
 * no `mid.$...` on either — which is what the `mid` branch above exists for.
 */
export function compositeMessageKey(args: {
  tenantId: string; threadId: string; senderId: string; sentAt: string; text: string;
}): string {
  return `fb_dm:${args.tenantId}:${args.threadId}:${args.senderId}:${args.sentAt}:${args.text}`;
}
