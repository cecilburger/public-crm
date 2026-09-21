/**
 * The only code path that sends through `apps/fb-bridge` — the counterpart to
 * `IgBridgeClient` and `WaBridgeClient`.
 *
 * Today the bridge answers 501: the composer selectors have not been verified
 * against the real Messenger DOM, so there is no way to actually deliver a
 * message. That is treated as permanent, which is the point — the caller fails
 * the message with a reason an agent can read instead of retrying forever
 * against a capability that does not exist yet. When the sender lands, nothing
 * here changes.
 */
export class FbBridgeClient {
  constructor(private baseUrl: string, private secret: string) {}

  async send(args: { tenantId: string; threadId: string; body: string }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/sessions/${args.tenantId}/threads/${args.threadId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({ text: args.body }),
    });
    if (res.ok) return;

    const text = await res.text().catch(() => '');
    // The bridge says what happened in the body; carrying it through is what
    // puts a readable reason on the failed message rather than a bare status.
    const detail = parseDetail(text) ?? `${res.status} ${text}`.trim();
    const err = new Error(`fb-bridge send failed: ${detail}`) as Error & { permanent?: boolean };
    // 501: no sender yet. 400/404: a bad request, or no session and no thread.
    // None of those improve by trying again. Anything else — the bridge briefly
    // unreachable, or a send that failed for an unclear reason — gets the
    // queue's normal backoff like any other transient failure.
    err.permanent = res.status === 501 || res.status === 400 || res.status === 404;
    throw err;
  }
}

function parseDetail(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error ?? null;
  } catch {
    return null;
  }
}
