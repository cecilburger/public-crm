/**
 * The only code path that sends through `apps/ig-bridge`'s session — the
 * counterpart to `WaBridgeClient`. One engine (`instagram-private-api`),
 * one route.
 */
export class IgBridgeClient {
  constructor(private baseUrl: string, private secret: string) {}

  async send(args: { tenantId: string; threadId: string; body: string }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/sessions/${args.tenantId}/threads/${args.threadId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({ text: args.body }),
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
}
