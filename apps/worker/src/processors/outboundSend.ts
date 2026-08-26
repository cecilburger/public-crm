import { guardOutbound, sendRatePerSecond, normalisePhone, toMicros, META_RATE_IDR } from '@kirana/core';
import { withTenant, openField, tenantKeys, incrementUsage, ensureBillingPeriod, type Database } from '@kirana/db';
import type { MetaClient } from '../meta.ts';

export interface SendDeps {
  db: Database;
  kek: Buffer;
  meta: MetaClient;
  accessTokenFor: (tenantId: string, channelId: string) => Promise<string>;
}

/**
 * The only code path that talks to a provider.
 *
 * The policy gate runs here, not in the API: an automation, a retry or a
 * broadcast must not be able to route around the 24-hour window rule, and a
 * message that sat in the queue for ten minutes may have fallen out of the
 * window while it waited.
 */
export async function processOutbound(deps: SendDeps, job: { tenantId: string; messageId: string }) {
  return withTenant(deps.db, job.tenantId, async (tx) => {
    const rows = await tx.query<{
      id: string; body_enc: string | null; template_name: string | null; status: string;
      channel_id: string; conversation_id: string; contact_id: string;
      last_inbound_at: Date | null; quality: string; external_id: string | null; phone_enc: string | null;
    }>(
      `select m.id, m.body_enc, m.template_name, m.status, m.channel_id, m.conversation_id,
              c.contact_id, c.last_inbound_at, ch.quality, ch.external_id, ct.phone_enc
         from messages m
         join conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
         join channels ch on ch.id = m.channel_id and ch.tenant_id = m.tenant_id
         join contacts ct on ct.id = c.contact_id and ct.tenant_id = m.tenant_id
        where m.tenant_id = $1 and m.id = $2`,
      [job.tenantId, job.messageId],
    );
    const msg = rows[0];
    if (!msg) return { status: 'not_found' };
    if (msg.status !== 'queued') return { status: 'already_sent' };

    const quality = msg.quality as 'green' | 'yellow' | 'red' | 'flagged';
    const guard = guardOutbound({
      lastInboundAt: msg.last_inbound_at ? new Date(msg.last_inbound_at) : null,
      now: new Date(),
      hasApprovedTemplate: Boolean(msg.template_name),
      channelQuality: quality,
      contactOptedOut: false,
      isTemplateSend: Boolean(msg.template_name),
    });

    if (!guard.ok) {
      await markFailed(tx, job, guard.reason ?? 'blocked');
      return { status: 'blocked', reason: guard.reason };
    }
    if (sendRatePerSecond(quality) === 0) return { status: 'paused' };

    const keys = await tenantKeys(tx, deps.kek, job.tenantId);
    const body = msg.body_enc ? openField(keys, job.tenantId, msg.body_enc) : '';
    const to = msg.phone_enc ? normalisePhone(openField(keys, job.tenantId, msg.phone_enc)) : null;
    if (!to || !msg.external_id) {
      await markFailed(tx, job, 'channel_unavailable');
      return { status: 'failed' };
    }

    try {
      const sent = await deps.meta.send({
        channelExternalId: msg.external_id,
        toE164: to,
        body,
        templateName: msg.template_name,
        accessToken: await deps.accessTokenFor(job.tenantId, msg.channel_id),
      });

      await tx.query(
        `update messages set status = 'sent', provider_message_id = $3, meta_category = $4
          where tenant_id = $1 and id = $2`,
        [job.tenantId, job.messageId, sent.providerMessageId, sent.category],
      );
      await tx.query('delete from message_outbox where tenant_id = $1 and message_id = $2',
        [job.tenantId, job.messageId]);

      // Meta's fee, recorded at cost against the conversation it belongs to.
      const period = await ensureBillingPeriod(tx, job.tenantId, new Date());
      const costIdr = META_RATE_IDR[sent.category];
      if (costIdr > 0) {
        await tx.query(
          `insert into meta_cost_events (tenant_id, channel_id, provider_conversation_id, category, cost_micros, billing_period_id)
           values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
          [job.tenantId, msg.channel_id, sent.providerMessageId, sent.category, toMicros(costIdr), period.id],
        );
        await incrementUsage(tx, job.tenantId, period.id, 'meta_cost_micros', toMicros(costIdr));
      }

      return { status: 'sent', providerMessageId: sent.providerMessageId };
    } catch (err) {
      const permanent = (err as { permanent?: boolean }).permanent === true;
      if (permanent) {
        await markFailed(tx, job, (err as Error).message.slice(0, 500));
        return { status: 'failed' };
      }
      await tx.query(
        `update message_outbox
            set attempts = attempts + 1,
                next_attempt_at = now() + make_interval(secs => least(300, power(2, attempts + 1))),
                last_error = $3
          where tenant_id = $1 and message_id = $2`,
        [job.tenantId, job.messageId, (err as Error).message.slice(0, 500)],
      );
      throw err; // let the queue's backoff own the retry schedule
    }
  });
}

async function markFailed(tx: { query: (t: string, p?: readonly unknown[]) => Promise<unknown> }, job: { tenantId: string; messageId: string }, reason: string) {
  await tx.query(
    `update messages set status = 'failed', error = $3 where tenant_id = $1 and id = $2`,
    [job.tenantId, job.messageId, JSON.stringify({ reason })],
  );
  await tx.query('delete from message_outbox where tenant_id = $1 and message_id = $2',
    [job.tenantId, job.messageId]);
}
