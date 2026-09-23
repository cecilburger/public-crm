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
import { processOutbound } from './processors/outboundSend.ts';
import { processAutopilotDraft } from './processors/autopilotDraft.ts';
import { ClaudeAutopilot, ScriptedAutopilot, type AutopilotModel } from './autopilot/model.ts';
import { purgeExpiredData, verifyAllAuditChains, expireUnpaidOrders, sweepSecurityClocks } from './processors/retention.ts';
import { runHealthChecks } from './processors/healthChecks.ts';
import { closePeriodAndIssueInvoice, checkUsageThresholds, runDunning } from './processors/billingRollup.ts';
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
const control = await connectPostgres(e.DATABASE_URL, { max: 4, poolMode: e.DATABASE_POOL_MODE });

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

const commentDeps = { db, kek, fbBridge, dispatch, env: e };

const workers = [
  new Worker('inbound.normalise', async (job: Job) =>
    processInboundWebhook({ db, control, kek, dispatch, publish }, job.data.webhookEventId), { connection, concurrency: 16 }),

  new Worker('outbound.send', async (job: Job) =>
    processOutbound({ db, kek, meta, waBridge, igBridge, fbBridge, accessTokenFor }, job.data), { connection, concurrency: 8 }),

  new Worker('autopilot.draft', async (job: Job) =>
    processAutopilotDraft({ db, kek, model: autopilot, dispatch }, job.data), { connection, concurrency: 6 }),

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
  w.on('failed', (job, err) => console.error(`[${w.name}] ${job?.id} failed:`, err.message));
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
