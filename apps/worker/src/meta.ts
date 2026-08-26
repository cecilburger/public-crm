import type { MetaCategory } from '@kirana/core';

export interface SendRequest {
  channelExternalId: string;
  toE164: string;
  body: string;
  templateName?: string | null;
  accessToken: string;
}

export interface SendResult {
  providerMessageId: string;
  category: MetaCategory;
}

export interface MetaClient {
  send(req: SendRequest): Promise<SendResult>;
}

/**
 * The real Graph client. Retries are the queue's job, not ours — this either
 * returns an id or throws with enough context for the retry policy to decide.
 */
export class GraphMetaClient implements MetaClient {
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = fetch) {}

  async send(req: SendRequest): Promise<SendResult> {
    const url = `${this.baseUrl}/${req.channelExternalId}/messages`;
    const payload = req.templateName
      ? { messaging_product: 'whatsapp', to: req.toE164, type: 'template',
          template: { name: req.templateName, language: { code: 'id' } } }
      : { messaging_product: 'whatsapp', to: req.toE164, type: 'text', text: { body: req.body } };

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${req.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`Meta send failed (${res.status}): ${detail.slice(0, 300)}`);
      // 4xx other than 429 will never succeed on retry; the processor uses this.
      (err as Error & { permanent?: boolean }).permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw err;
    }

    const json = await res.json() as { messages?: { id: string }[] };
    return {
      providerMessageId: json.messages?.[0]?.id ?? `unknown-${Date.now()}`,
      category: req.templateName ? 'marketing' : 'service',
    };
  }
}
