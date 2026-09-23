import { guardOutbound, sendRatePerSecond, normalisePhone, toMicros, META_RATE_IDR } from '@kirana/core';
import {
  withTenant, openField, tenantKeys, incrementUsage, ensureBillingPeriod, getDecryptedIgToken,
  type Database,
} from '@kirana/db';
import type { MetaClient } from '../meta.ts';
import type { WaBridgeClient } from '../waBridge.ts';
import type { IgBridgeClient } from '../igBridgeClient.ts';
import type { FbBridgeClient } from '../fbBridgeClient.ts';

const IG_GRAPH_URL = 'https://graph.instagram.com';

export interface SendDeps {
  db: Database;
  kek: Buffer;
  meta: MetaClient;
  waBridge: WaBridgeClient;
  igBridge: IgBridgeClient;
  fbBridge: FbBridgeClient;
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
      channel_id: string; conversation_id: string; contact_id: string; channel_kind: string;
      last_inbound_at: Date | null; quality: string; external_id: string | null; phone_enc: string | null;
      ig_psid_enc: string | null; ig_thread_id_enc: string | null; ig_username_enc: string | null;
      fb_thread_id_enc: string | null;
    }>(
      `select m.id, m.body_enc, m.template_name, m.status, m.channel_id, m.conversation_id,
              c.contact_id, c.last_inbound_at, ch.kind as channel_kind, ch.quality, ch.external_id,
              ct.phone_enc, ct.ig_psid_enc, ct.ig_thread_id_enc, ct.ig_username_enc, ct.fb_thread_id_enc
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

    const keys = await tenantKeys(tx, deps.kek, job.tenantId);
    const body = msg.body_enc ? openField(keys, job.tenantId, msg.body_enc) : '';

    // No phone number in the loop at all for Instagram — the recipient is an
    // opaque IGSID on the contact, and the credential lives in
    // `ig_meta_connections`, not on the channel row the way Meta's WhatsApp
    // Cloud API credential does.
    if (msg.channel_kind === 'instagram') {
      const psid = msg.ig_psid_enc ? openField(keys, job.tenantId, msg.ig_psid_enc) : null;
      const ig = psid ? await getDecryptedIgToken({ tx, tenantId: job.tenantId, kek: deps.kek }) : null;
      if (!psid || !ig) {
        await markFailed(tx, job, 'channel_unavailable');
        return { status: 'failed' };
      }
      try {
        const res = await fetch(`${IG_GRAPH_URL}/${ig.igUserId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ig.accessToken}` },
          body: JSON.stringify({ recipient: { id: psid }, message: { text: body } }),
        });
        const resBody = await res.json() as { message_id?: string; error?: { message?: string } };
        if (!res.ok) throw new Error(resBody.error?.message ?? `Instagram send failed (${res.status})`);

        await tx.query(
          `update messages set status = 'sent', provider_message_id = $3 where tenant_id = $1 and id = $2`,
          [job.tenantId, job.messageId, resBody.message_id ?? null],
        );
        await tx.query('delete from message_outbox where tenant_id = $1 and message_id = $2',
          [job.tenantId, job.messageId]);
        return { status: 'sent', providerMessageId: resBody.message_id };
      } catch (err) {
        // Instagram gives no structured "retry vs permanent" signal the way
        // Meta's WhatsApp error codes do, so a failed send here is treated as
        // permanent rather than retried into the same error forever.
        await markFailed(tx, job, (err as Error).message.slice(0, 500));
        return { status: 'failed' };
      }
    }

    // `instagram-private-api`-driven, so there is no template/window/quality
    // policy to run through `guardOutbound` here either — same reasoning as
    // `whatsapp_web` just below, and its own simpler path for the same reason.
    // The thread id (not a phone number or IGSID) is what tells `apps/ig-bridge`
    // which DM to open; it was stashed on the contact by the last inbound
    // message from them, so a contact who has never messaged in has nowhere to
    // send. Checked *before* the phone-number branch below, not after it: a
    // bridge contact has no `phone_enc` at all, so the generic "no phone on
    // record" guard meant for the phone-based channels caught and failed
    // every bridge send before it ever reached this block — confirmed live,
    // this was the reason nothing sent through Chat IG ever went anywhere.
    if (msg.channel_kind === 'instagram_bridge') {
      const threadId = msg.ig_thread_id_enc ? openField(keys, job.tenantId, msg.ig_thread_id_enc) : null;
      if (!threadId) {
        await markFailed(tx, job, 'channel_unavailable');
        return { status: 'failed' };
      }
      try {
        // The username travels with the send so the bridge can settle "did
        // this land?" by looking in Instagram's own inbox rather than at the
        // thread page. A message Instagram renders as a link preview — which
        // is any message naming a domain, so every opener this bot sends —
        // is invisible to the page scrape, and calling that a failure is what
        // had the same opener delivered three times to one prospect.
        const username = msg.ig_username_enc
          ? openField(keys, job.tenantId, msg.ig_username_enc)
          : undefined;
        await deps.igBridge.send({ tenantId: job.tenantId, threadId, body, username });
        await tx.query(`update messages set status = 'sent' where tenant_id = $1 and id = $2`,
          [job.tenantId, job.messageId]);
        await tx.query('delete from message_outbox where tenant_id = $1 and message_id = $2',
          [job.tenantId, job.messageId]);
        return { status: 'sent' };
      } catch (err) {
        if ((err as { permanent?: boolean }).permanent === true) {
          await markFailed(tx, job, (err as Error).message.slice(0, 500));
          return { status: 'failed' };
        }
        await scheduleRetry(tx, job, err as Error);
        throw err;
      }
    }

    // Facebook. The whole chain below is real — thread id, client, the success
    // and failure handling — and it is exercised end to end today. What it
    // reaches is a bridge that answers 501, because driving Messenger's composer
    // needs selectors read off the live site and every selector guessed for this
    // bridge so far has been wrong. The client turns that into a permanent
    // failure, so the message is marked failed with the bridge's own reason
    // rather than sitting at 'queued' looking sent — which is exactly what
    // happened to a real agent replying to a real customer.
    //
    // It sits above the phone lookup because a Facebook contact is identified by
    // a Facebook id and has no phone number at all; the generic
    // 'channel_unavailable' failure fired first and buried the real reason.
    if (msg.channel_kind === 'messenger_bridge') {
      const threadId = msg.fb_thread_id_enc ? openField(keys, job.tenantId, msg.fb_thread_id_enc) : null;
      if (!threadId) {
        await markFailed(tx, job, 'Percakapan Facebook ini belum punya thread id — tidak bisa dibalas');
        return { status: 'failed' };
      }
      try {
        await deps.fbBridge.send({ tenantId: job.tenantId, threadId, body });
        await tx.query(`update messages set status = 'sent' where tenant_id = $1 and id = $2`,
          [job.tenantId, job.messageId]);
        await tx.query('delete from message_outbox where tenant_id = $1 and message_id = $2',
          [job.tenantId, job.messageId]);
        return { status: 'sent' };
      } catch (err) {
        if ((err as { permanent?: boolean }).permanent === true) {
          await markFailed(tx, job, (err as Error).message.slice(0, 500));
          return { status: 'failed' };
        }
        await scheduleRetry(tx, job, err as Error);
        throw err;
      }
    }

    const to = msg.phone_enc ? normalisePhone(openField(keys, job.tenantId, msg.phone_enc)) : null;
    if (!to) {
      await markFailed(tx, job, 'channel_unavailable');
      return { status: 'failed' };
    }

    // A QR-paired session has no Meta template/window rules and no per-second
    // quality cap to pace against — those are policed by the guard in
    // `guardOutbound`, which exists to enforce Meta's rules and does not apply
    // here. It gets its own, much simpler path rather than a maze of
    // conditionals inside the Meta one.
    if (msg.channel_kind === 'whatsapp_web') {
      try {
        const sent = await deps.waBridge.send({ channelId: msg.channel_id, toE164: to, body });
        await tx.query(
          `update messages set status = 'sent', provider_message_id = $3 where tenant_id = $1 and id = $2`,
          [job.tenantId, job.messageId, sent.providerMessageId],
        );
        await tx.query('delete from message_outbox where tenant_id = $1 and message_id = $2',
          [job.tenantId, job.messageId]);
        return { status: 'sent', providerMessageId: sent.providerMessageId };
      } catch (err) {
        if ((err as { permanent?: boolean }).permanent === true) {
          await markFailed(tx, job, (err as Error).message.slice(0, 500));
          return { status: 'failed' };
        }
        await scheduleRetry(tx, job, err as Error);
        throw err;
      }
    }

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
    if (!msg.external_id) {
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
      await scheduleRetry(tx, job, err as Error);
      throw err; // let the queue's backoff own the retry schedule
    }
  });
}

type Tx = { query: (t: string, p?: readonly unknown[]) => Promise<unknown> };

async function scheduleRetry(tx: Tx, job: { tenantId: string; messageId: string }, err: Error) {
  await tx.query(
    `update message_outbox
        set attempts = attempts + 1,
            next_attempt_at = now() + make_interval(secs => least(300, power(2, attempts + 1))),
            last_error = $3
      where tenant_id = $1 and message_id = $2`,
    [job.tenantId, job.messageId, err.message.slice(0, 500)],
  );
}

async function markFailed(tx: Tx, job: { tenantId: string; messageId: string }, reason: string) {
  await tx.query(
    `update messages set status = 'failed', error = $3 where tenant_id = $1 and id = $2`,
    [job.tenantId, job.messageId, JSON.stringify({ reason })],
  );
  await tx.query('delete from message_outbox where tenant_id = $1 and message_id = $2',
    [job.tenantId, job.messageId]);
}
