/**
 * The only code path that talks to `apps/fb-bridge` — the counterpart to
 * `IgBridgeClient` and `WaBridgeClient`.
 *
 * Three actions, one error shape. Every failure carries `permanent`, and the
 * callers branch on nothing else: a permanent failure is recorded with the
 * bridge's own reason and never retried, anything else gets the queue's
 * backoff. `status` and `code` ride along so a processor can put a sentence an
 * agent understands on the row instead of a bare "409".
 *
 * The comment endpoints are built against a contract, not a running bridge:
 * they do not exist on the bridge yet and land after a live DOM probe. Nothing
 * here should need to change when they do.
 */

export type FbBridgeError = Error & {
  /** True when no retry can ever succeed. Absent or false means try again later. */
  permanent?: boolean;
  /** The HTTP status the bridge answered with, when it answered at all. */
  status?: number;
  /** The bridge's machine-readable reason, e.g. 'comment_not_found'. */
  code?: string;
};

/** A comment, as the bridge needs it named: which Page session, which post,
 * which comment on it — and what to say. The session is a division's, not a
 * tenant's: `sessionKey` is what the bridge files that division's browser
 * profile under (`bridgeSessionKey` in @kirana/core). */
export interface CommentTarget {
  sessionKey: string;
  postId: string;
  commentId: string;
  text: string;
}

/** Statuses after which trying again can only produce the same answer. */
const PERMANENT_STATUSES = new Set([400, 404, 409, 501]);

export class FbBridgeClient {
  constructor(private baseUrl: string, private secret: string) {}

  /**
   * Types a message into a Messenger thread's composer.
   *
   * A 502 `send_not_confirmed` means the message was typed but not seen in the
   * thread — it most likely arrived, and a retry would type it a second time.
   * For a DM that is final: the row fails saying so and a person checks the
   * inbox. Comment actions keep their own rule in `facebookComments.ts`.
   */
  async send(args: { sessionKey: string; threadId: string; body: string }): Promise<void> {
    try {
      await this.post(
        `/internal/sessions/${args.sessionKey}/threads/${args.threadId}/send`, { text: args.body }, 'send',
      );
    } catch (err) {
      const e = err as FbBridgeError;
      if (e.status !== 502 || e.code !== 'send_not_confirmed') throw err;
      const unconfirmed = new Error(
        'fb-bridge send unconfirmed: pesan sudah diketik tapi tidak terkonfirmasi terkirim — '
        + 'periksa kotak masuk Facebook sebelum mengirim ulang',
      ) as FbBridgeError;
      unconfirmed.status = e.status;
      unconfirmed.code = e.code;
      unconfirmed.permanent = true;
      throw unconfirmed;
    }
  }

  /**
   * Replies to a comment in public, under the comment itself.
   *
   * Resolves only once the bridge has seen the reply appear on the post. A 502
   * `reply_not_confirmed` is the uncomfortable middle — typed, not seen — and
   * is transient by contract; what a retry may do with it is decided by the
   * processor (`processors/facebookComments.ts`), because the answer is "not
   * type it again".
   */
  async replyToComment(args: CommentTarget): Promise<void> {
    await this.post(
      `/internal/sessions/${args.sessionKey}/comments/reply`,
      { postId: args.postId, commentId: args.commentId, text: args.text },
      'comment reply',
    );
  }

  /**
   * Facebook's "private reply": one Messenger message to a commenter, offered
   * once per comment and only for a while. The thread id that comes back is
   * the only handle the CRM will ever have on that conversation, which is why
   * a 200 without one is treated as a failure rather than shrugged off.
   */
  async privateReplyToComment(args: CommentTarget): Promise<{ threadId: string }> {
    const body = await this.post(
      `/internal/sessions/${args.sessionKey}/comments/private-reply`,
      { postId: args.postId, commentId: args.commentId, text: args.text },
      'private reply',
    );
    const threadId = (body as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId !== 'string' || threadId.length === 0) {
      // The message went out — the bridge said so — but there is no thread to
      // attach it to. Permanent: a retry would send a second message to find
      // out the same thing. The processor records this against the comment.
      throw fbBridgeFailure('private reply', 200,
        JSON.stringify({ error: 'bridge answered 200 without a threadId', code: 'malformed_response' }),
        { permanent: true });
    }
    return { threadId };
  }

  private async post(path: string, payload: unknown, what: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => '');
    if (res.ok) return parseBody(text);
    throw fbBridgeFailure(what, res.status, text);
  }
}

/**
 * The bridge's answer, as an error the processors can branch on.
 *
 * Exported so a test can hand a stub bridge exactly the error the real client
 * would have thrown, rather than a hand-built lookalike that drifts.
 *
 * 409: the thread is a message request with no composer, the comment is gone,
 * or Facebook offers no reply box / private reply for it. 501: no such
 * capability on the bridge. 400/404: a bad request, or no session. None of
 * those improve by trying again. Anything else — the bridge briefly
 * unreachable, or an action that was typed but never confirmed on the page
 * (Facebook silently rate-limiting does this) — is left to the queue's backoff.
 *
 * The bridge says what happened in the body; carrying it through is what puts
 * a readable reason on the row rather than a bare status.
 */
export function fbBridgeFailure(
  what: string, status: number, body: string, over: { permanent?: boolean } = {},
): FbBridgeError {
  const parsed = parseBody(body) as { error?: unknown; code?: unknown } | null;
  const detail = typeof parsed?.error === 'string' ? parsed.error : `${status} ${body}`.trim();
  const err = new Error(`fb-bridge ${what} failed: ${detail}`) as FbBridgeError;
  err.status = status;
  if (typeof parsed?.code === 'string') err.code = parsed.code;
  err.permanent = over.permanent ?? PERMANENT_STATUSES.has(status);
  return err;
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}
