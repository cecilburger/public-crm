/**
 * The wire contract between `apps/fb-bridge` and the CRM.
 *
 * This is the whole interface. The bridge knows nothing about tenants beyond
 * carrying an id it was handed, nothing about contacts, conversations or
 * billing, and it never touches the database — it posts one of these shapes to
 * `POST /v1/webhooks/fb-bridge` and that is the entire coupling.
 *
 * `sessionKey` names the browser profile an event came off — one per
 * Marketing/AI division, issued by the CRM (`bridgeSessionKey` there). A
 * Marketing profile's key is the bare tenant id, which is what every profile
 * was named before divisions existed, so nothing on disk moved. The tenant id
 * the CRM also expects on the wire is added by `postEvent` in main.ts from the
 * profile's marker, or recovered from the key itself.
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
  sessionKey: string;
  /** When the bridge emitted this, ISO-8601. Not when Facebook says it was
   * sent — that is `sentAt`, which may be missing. */
  at: string;
  message: {
    /** The `/messages/t/<id>` segment. Stable per conversation. */
    threadId: string;
    /**
     * Facebook's own message id (`mid.$...`) when the DOM exposes one, else
     * null. When it is present the CRM keys idempotency on it directly; when it
     * is not, the CRM falls back to a composite of thread + sender + `seq` +
     * a hash of the text. Text alone is never an identity: a customer sending
     * "halo" twice is two messages, not one.
     */
    externalMessageId: string | null;
    /** The other party's numeric Facebook id, read from the thread URL. This is
     * the contact identity; a display name is not. */
    senderId: string;
    senderName: string;
    text: string;
    /** ISO-8601, or null when the DOM did not expose a timestamp. */
    sentAt: string | null;
    direction: Direction;
    /**
     * A per-thread counter that only ever goes up, assigned once at the moment
     * a message is first recognised as new — NOT its index in the DOM.
     * `apps/ig-bridge` learned this the hard way: Facebook's rendered message
     * window does not cover the same slice of history on every read, so a
     * DOM-position index makes already-ingested messages resurface as new.
     * This is only ever handed out once per genuinely new message, which is
     * what makes the composite id above stable.
     */
    seq: number;
  };
}

export interface FbCommentEvent {
  event: 'comment';
  sessionKey: string;
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
  sessionKey: string;
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
 */
export function compositeMessageKey(args: {
  sessionKey: string; threadId: string; senderId: string; seq: number; text: string;
}): string {
  return `fb_dm:${args.sessionKey}:${args.threadId}:${args.senderId}:${args.seq}:${args.text}`;
}
