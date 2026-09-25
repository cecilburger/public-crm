import { Worker, type Job } from 'bullmq';
import { env, loadKek, LogAlertSink, FanOutSink } from '@kirana/core';
import { WebhookAlertSink } from './alerts/webhook.ts';
import { connectPostgres, withTenant, rotateTenantDek } from '@kirana/db';
import { GraphMetaClient } from './meta.ts';
import { WaBridgeClient } from './waBridge.ts';
import { IgBridgeClient } from './igBridgeClient.ts';
import { FbBridgeClient } from './fbBridgeClient.ts';
import { resolveSender, sendBillingEmail } from './email/send.ts';
import { processInboundWebhook } from './processors/inboundNormalise.ts';
import { processOutbound, markSendExhausted } from './processors/outboundSend.ts';
import { processAutopilotDraft } from './processors/autopilotDraft.ts';
import { ClaudeAutopilot, ScriptedAutopilot, type AutopilotModel } from './autopilot/model.ts';
import { purgeExpiredData, verifyAllAuditChains, expireUnpaidOrders, sweepSecurityClocks } from './processors/retention.ts';
import { runHealthChecks } from './processors/healthChecks.ts';
import { closePeriodAndIssueInvoice, checkUsageThresholds, runDunning } from './processors/billingRollup.ts';
import { bdBrainFromEnv } from './bdBrain.ts';
import { processChatbotReply, CHATBOT_REPLY_QUEUE, type ChatbotJob } from './processors/chatbotReply.ts';
import { processLegacyBdDraft, LEGACY_BD_DRAFT_QUEUE } from './processors/bdDraft.ts';
import { deferWhileBusy, handOverFailedChatbotJob } from './processors/chatbotQueue.ts';
import { processIgCommentReply } from './processors/igCommentReply.ts';
import {
  processCommentPublicReply, processCommentDm, processCommentAutopilot, dispatchCommentSweeps,
  COMMENT_REPLY_QUEUE, COMMENT_DM_QUEUE, COMMENT_SWEEP_QUEUE,
} from './processors/facebookComments.ts';

const e = env();
const kek = loadKek(e.KIRANA_KEK);
const connection = { url: e.REDIS_URL };

const db = await connectPostgres(e.DATABASE_URL, {
  max: e.DATABASE_MAX_CONNECTIONS, poolMode: e.DATABASE_POOL_MODE,
});
// kirana_provisioner, not kirana_app — see CONTROL_DATABASE_URL in packages/core/src/env.ts.
const control = await connectPostgres(e.CONTROL_DATABASE_URL ?? e.DATABASE_URL, { max: 4, poolMode: e.DATABASE_POOL_MODE });

const { Queue } = await import('bullmq');
const queues = new Map<string, InstanceType<typeof Queue>>();
const queueFor = (name: string) => {
  let q = queues.get(name);
  if (!q) { q = new Queue(name, { connection }); queues.set(name, q); }
  return q;
};
const dispatch = async ({ queue, payload }: { queue: string; payload: unknown }) => {
  await queueFor(queue).add(queue, payload, { attempts: 8, backoff: { type: 'exponential', delay: 2_000 } });
};

// The API's `/v1/realtime` connections live in a different process (a
// different container) than this one — Redis pub/sub is the bridge between
// the process that writes a message and the one holding the console's open
// connection to tell it about it.
const IORedis = await import('ioredis');
const Redis = (IORedis as unknown as { default?: typeof IORedis.Redis }).default ?? IORedis.Redis;
const realtimePub = new Redis(e.REDIS_URL);
realtimePub.on('error', (err: Error) => console.error('[redis] realtime publisher:', err.message));
const publish = (tenantId: string, event: { type: 'message'; conversationId: string }) => {
  void realtimePub.publish('kirana:realtime', JSON.stringify({ tenantId, event })).catch((err: Error) =>
    console.error('[redis] realtime publish failed:', err.message));
};

const meta = new GraphMetaClient(e.META_GRAPH_URL);
const waBridge = new WaBridgeClient(e.WA_BRIDGE_URL, e.WA_BRIDGE_SECRET);
const igBridge = new IgBridgeClient(e.IG_BRIDGE_URL, e.IG_BRIDGE_SECRET);
const fbBridge = new FbBridgeClient(e.FB_BRIDGE_URL, e.FB_BRIDGE_SECRET);
const emailSender = resolveSender(e);
const email = { db, sender: emailSender };

// Alerts always reach the log; a webhook is added when one is configured.
const alerts = e.ALERT_WEBHOOK_URL
  ? new FanOutSink([
      new LogAlertSink(),
      new WebhookAlertSink(e.ALERT_WEBHOOK_URL, fetch, (err) =>
        console.error('[alerts] webhook delivery failed:', err.message)),
    ])
  : new LogAlertSink();

// With no key configured, Autopilot answers from the catalogue deterministically
// instead of failing every job — the guardrails, metering and handover paths are
// identical either way, so a workspace without a key still behaves correctly.
const autopilot: AutopilotModel = process.env.ANTHROPIC_API_KEY
  ? new ClaudeAutopilot({ model: e.AUTOPILOT_MODEL, effort: e.AUTOPILOT_EFFORT })
  : new ScriptedAutopilot();
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY is not set — Autopilot is running in offline mode');
}

// Channel credentials are stored encrypted per tenant; the worker unwraps them
// only in memory, only for the send it is performing.
const accessTokenFor = async (tenantId: string, channelId: string): Promise<string> => {
  const { tenantKeys, openField } = await import('@kirana/db');
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.query<{ credentials_enc: string | null }>(
      'select credentials_enc from channels where tenant_id = $1 and id = $2', [tenantId, channelId]);
    if (!rows[0]?.credentials_enc) throw new Error('Channel has no stored credentials');
    const keys = await tenantKeys(tx, kek, tenantId);
    return (JSON.parse(openField(keys, tenantId, rows[0].credentials_enc)) as { accessToken: string }).accessToken;
  });
};

// The DM chatbot's brain is `trained-cb` (Python), reached over HTTP. Without
// it every run is recorded as skipped (`brain_not_configured`) — never retried,
// and never answered by Autopilot instead.
const bdBrain = bdBrainFromEnv();
if (!bdBrain) {
  console.warn('BD_BRAIN_URL is not set — the DM chatbot will not answer (runs recorded as brain_not_configured)');
}
const chatbotDeps = { db, kek, brain: bdBrain, dispatch };

/**
 * What the bot says to a comment, asked of the bot itself.
 *
 * Not held in the CRM: a second copy of these two texts would drift from
 * `templates.py` without anyone noticing, and the place that would surface
 * is a public reply under a brand's post.
 */
const commentTexts = async (): Promise<{ publicReply: string; dmOpener: string } | null> => {
  if (!process.env.BD_BRAIN_URL) return null;
  try {
    const res = await fetch(`${process.env.BD_BRAIN_URL}/v1/comment-reply`, {
      headers: { authorization: `Bearer ${process.env.BD_BRAIN_SECRET ?? ''}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { publicReply?: string; dmOpener?: string };
    if (!body.publicReply || !body.dmOpener) return null;
    return { publicReply: body.publicReply, dmOpener: body.dmOpener };
  } catch {
    return null;
  }
};

const commentDeps = { db, kek, fbBridge, dispatch, env: e };

const workers = [
  new Worker('inbound.normalise', async (job: Job) =>
    processInboundWebhook({ db, control, kek, dispatch, publish }, job.data.webhookEventId), { connection, concurrency: 16 }),

  new Worker('outbound.send', async (job: Job) =>
    processOutbound({ db, kek, meta, waBridge, igBridge, fbBridge, accessTokenFor }, job.data), { connection, concurrency: 8 }),

  new Worker('autopilot.draft', async (job: Job) =>
    processAutopilotDraft({ db, kek, model: autopilot, dispatch }, job.data), { connection, concurrency: 6 }),

  new Worker(CHATBOT_REPLY_QUEUE, async (job: Job, token?: string) =>
    processChatbotReply(chatbotDeps, job.data as ChatbotJob, { onBusy: deferWhileBusy(job, token) }), {
    connection, concurrency: 6,
    // `BdBrainClient.book()` (apps/worker/src/bdBrain.ts) gives Google
    // Calendar and an LLM read up to 45s to answer, comfortably past
    // BullMQ's 30s default lock. A job that outlives its lock gets marked
    // stalled and handed to a second worker while the first is still
    // running — confirmed live: two "Meeting wilson x MCN Asia" tasks, same
    // due date, same Meet link, created 43 seconds apart, because one
    // in-flight booking call ran under two workers at once. `createTask`'s
    // own conflict guard (packages/db/src/tasks.ts) is the second half of
    // this fix and is what actually stops the duplicate row; this half is
    // what stops the duplicate run from happening to begin with.
    lockDuration: 60_000,
  }),

  // Drains jobs queued under the old name before this release; remove with the next one.
  new Worker(LEGACY_BD_DRAFT_QUEUE, async (job: Job, token?: string) =>
    processLegacyBdDraft(chatbotDeps, job.data, { onBusy: deferWhileBusy(job, token) }),
  { connection, concurrency: 6, lockDuration: 60_000 }),

  new Worker('igComment.reply', async (job: Job) => {
    // Off by default is the wrong default for a feature someone turned on,
    // but this one speaks in public under the workspace's own name — so it
    // is a switch that exists, is named, and can be flipped without a
    // deploy. `IG_COMMENT_AUTOREPLY=false` stops every reply going out while
    // comments keep being collected and shown on the page for a person.
    if (process.env.IG_COMMENT_AUTOREPLY === 'false') return { status: 'disabled' };
    return processIgCommentReply({ db, kek, igBridge, commentTexts }, job.data);
  }, { connection, concurrency: 1 }),

  new Worker('billing.rollup', async (job: Job) =>
    closePeriodAndIssueInvoice(db, job.data.tenantId, new Date(), email), { connection, concurrency: 4 }),

  new Worker('email.send', async (job: Job) =>
    sendBillingEmail(email, job.data.tenantId, job.data.invoiceId, job.data.kind),
    { connection, concurrency: 4 }),

  // Facebook comments: the two actions, and the sweep that feeds them. The
  // actions run one at a time on purpose — each is a browser typing into the
  // real site, and a burst of parallel replies is precisely the pattern Meta's
  // anti-abuse systems look for. The volume (FB_COMMENT_BATCH per cooldown per
  // tenant) needs no more than that.
  new Worker(COMMENT_REPLY_QUEUE, async (job: Job) =>
    processCommentPublicReply(commentDeps, job.data), { connection, concurrency: 1 }),

  new Worker(COMMENT_DM_QUEUE, async (job: Job) =>
    processCommentDm(commentDeps, job.data), { connection, concurrency: 1 }),

  // The scheduler's tick carries no tenant and fans out; a fanned-out job
  // carries one and sweeps it. Same queue, so the sweep has one name everywhere.
  new Worker(COMMENT_SWEEP_QUEUE, async (job: Job) => (
    job.data?.tenantId
      ? processCommentAutopilot(commentDeps, job.data)
      : dispatchCommentSweeps({ control, dispatch })
  ), { connection, concurrency: 2 }),

  new Worker('maintenance', async (job: Job) => {
    switch (job.name) {
      case 'retention.purge': return purgeExpiredData(db, control);
      case 'audit.verify': return verifyAllAuditChains(db, control, alerts);
      case 'security.sweep': return sweepSecurityClocks(db, control, alerts);
      case 'usage.thresholds': return checkUsageThresholds(db, control);
      case 'billing.dunning': return runDunning(db, control, alerts, new Date(), email);
      case 'health.checks': return runHealthChecks(db, control, { sink: alerts, poolMax: e.DATABASE_MAX_CONNECTIONS });
      case 'orders.expire': return expireUnpaidOrders(db, control);
      // Resumable: if this worker dies mid-rotation the next run continues from
      // its cursor, and the old key stays readable until every table is done.
      case 'keys.rotate': return rotateTenantDek(db, kek, job.data.tenantId, { batchSize: 500 });
      default: throw new Error(`Unknown maintenance job ${job.name}`);
    }
  }, { connection, concurrency: 1 }),
];

for (const w of workers) {
  w.on('failed', (job, err) => {
    console.error(`[${w.name}] ${job?.id} failed:`, err.message);
    // `job.attemptsMade` includes this failed attempt, so once it reaches the
    // configured `attempts` there is no next retry coming — BullMQ has given
    // up quietly, and without this the message stayed 'queued' forever with
    // no visible sign it never actually reached the customer.
    if (w.name === 'outbound.send' && job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const { tenantId, messageId } = job.data as { tenantId: string; messageId: string };
      void markSendExhausted(db, tenantId, messageId, err.message)
        .catch((e: Error) => console.error('[outbound.send] could not mark message failed:', e.message));
    }
    // The contact is still waiting for an answer the bot will not give.
    if (job) {
      void handOverFailedChatbotJob(db, w.name, job, err)
        .catch((e: Error) => console.error(`[${w.name}] could not hand the conversation over:`, e.message));
    }
  });
}

// The comment sweep is the one periodic job this process schedules for itself
// (the maintenance queue is fed from outside). A job scheduler is idempotent on
// its id, so every boot converges on exactly one; with the feature off it is
// removed, so flipping the flag and restarting really does stop the ticks
// rather than leaving a stale scheduler firing no-ops forever. The interval is
// the cooldown, floored at a minute: the per-row cooldown is what actually
// paces, this only bounds how often the worker looks.
const SWEEP_MIN_INTERVAL_MS = 60_000;
const sweepQueue = queueFor(COMMENT_SWEEP_QUEUE);
if (e.FB_COMMENT_AUTO_DM) {
  await sweepQueue.upsertJobScheduler(
    COMMENT_SWEEP_QUEUE,
    { every: Math.max(SWEEP_MIN_INTERVAL_MS, e.FB_COMMENT_COOLDOWN_MS) },
    { name: 'tick', data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } },
  );
} else {
  await sweepQueue.removeJobScheduler(COMMENT_SWEEP_QUEUE);
}

console.log(`worker ready: ${workers.map((w) => w.name).join(', ')}`);

const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([...queues.values()].map((q) => q.close()));
  realtimePub.disconnect();
  await Promise.all([db.close(), control.close()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
