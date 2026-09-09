/**
 * The only code path that sends through a WhatsApp Web session — the
 * counterpart to `GraphMetaClient` for the unofficial channel. `apps/wa-bridge`
 * holds the live Puppeteer session; this just calls it.
 */
export class WaBridgeClient {
  constructor(private baseUrl: string, private secret: string) {}

  async send(args: { channelId: string; toE164: string; body: string }): Promise<{ providerMessageId: string }> {
    const res = await fetch(`${this.baseUrl}/internal/sessions/${args.channelId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      body: JSON.stringify({ to: args.toE164, body: args.body }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`wa-bridge send failed: ${res.status} ${text}`) as Error & { permanent?: boolean };
      // Not connected, or not a WhatsApp number — retrying will not help either.
      // Anything else (the bridge is briefly unreachable) gets the queue's
      // exponential backoff like any other transient failure.
      err.permanent = res.status === 400 || res.status === 404 || res.status === 409;
      throw err;
    }

    return (await res.json()) as { providerMessageId: string };
  }
}
