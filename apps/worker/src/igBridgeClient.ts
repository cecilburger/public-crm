/**
 * The only code path that sends through `apps/ig-bridge`'s session — the
 * counterpart to `WaBridgeClient`. One engine (`instagram-private-api`),
 * one route.
 */
export class IgBridgeClient {
  constructor(private baseUrl: string, private secret: string) {}

  /** `sessionKey` is the division's browser profile on the bridge
   * (`bridgeSessionKey` in @kirana/core), not the tenant id. */
  async send(args: { sessionKey: string; threadId: string; body: string; username?: string }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/sessions/${args.sessionKey}/threads/${args.threadId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      // `username` is optional and only used to confirm a send the thread
      // scrape could not see. A send without it still works; it just falls
      // back to reporting an unconfirmed send as a failure.
      body: JSON.stringify({ text: args.body, username: args.username }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`ig-bridge send failed: ${res.status} ${text}`) as Error & { permanent?: boolean };
      // No session, no thread, or a bad request — retrying will not help.
      // Anything else (the bridge briefly unreachable, or the send itself
      // failed for an unclear reason) gets the queue's normal exponential
      // backoff like any other transient failure.
      err.permanent = res.status === 400 || res.status === 404;
      throw err;
    }
  }

  /**
   * Answer a comment: the short public line, then the DM that actually says
   * something. Returns what happened to each half rather than throwing on a
   * partial success — a public reply that lands while the DM bounces is a
   * normal outcome (a commenter can simply be unreachable by DM), and the
   * caller records both.
   */
  async replyToComment(args: {
    sessionKey: string; postRef: string; commentRef: string; commenter: string;
    publicReply?: string; dmText?: string;
  }): Promise<{
    public: { sent: boolean; error?: string };
    dm: { sent: boolean; alreadyThere?: boolean; threadId?: string; error?: string };
  }> {
    const res = await fetch(`${this.baseUrl}/internal/sessions/${args.sessionKey}/comments/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({
        postRef: args.postRef, commentRef: args.commentRef, commenter: args.commenter,
        publicReply: args.publicReply, dmText: args.dmText,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`ig-bridge comment reply failed: ${res.status} ${text}`) as Error & { permanent?: boolean };
      err.permanent = res.status === 400 || res.status === 404;
      throw err;
    }
    return await res.json() as Awaited<ReturnType<IgBridgeClient['replyToComment']>>;
  }
}
