/**
 * The operational checks, as arithmetic.
 *
 * `OPERATIONS.md` lists six things that should page somebody. They were written
 * down and wired to nothing; these are the thresholds, kept pure so they can be
 * tested without a database and tuned without redeploying a worker.
 */

export type HealthStatus = 'ok' | 'warn' | 'critical';

export interface HealthCheck {
  key: string;
  label: string;
  status: HealthStatus;
  /** The observed number, whatever it measures. */
  value: number;
  unit: string;
  detail: string;
}

export const THRESHOLDS = {
  /** Spooled webhooks nobody has processed. Ingestion has stalled. */
  webhookBacklogSeconds: { warn: 120, critical: 300 },
  /** Replies written but not sent. */
  outboxDepth: { warn: 200, critical: 1_000 },
  outboxAgeSeconds: { warn: 300, critical: 600 },
  /** Unacknowledged critical security events. */
  openCriticalEvents: { warn: 1, critical: 3 },
  /** Postgres connections in use, as a fraction of the pool. */
  connectionSaturation: { warn: 0.7, critical: 0.85 },
  /** Difference between billed windows and the counter. Must be zero. */
  meteringDrift: { warn: 1, critical: 1 },
} as const;

const rate = (value: number, warn: number, critical: number): HealthStatus =>
  value >= critical ? 'critical' : value >= warn ? 'warn' : 'ok';

export function checkWebhookBacklog(oldestUnprocessedSeconds: number): HealthCheck {
  const t = THRESHOLDS.webhookBacklogSeconds;
  return {
    key: 'webhook_backlog', label: 'Webhook ingestion',
    status: rate(oldestUnprocessedSeconds, t.warn, t.critical),
    value: oldestUnprocessedSeconds, unit: 'seconds',
    detail: oldestUnprocessedSeconds === 0
      ? 'Nothing waiting'
      : `Oldest unprocessed webhook is ${oldestUnprocessedSeconds}s old`,
  };
}

export function checkOutbox(depth: number, oldestSeconds: number): HealthCheck {
  const byDepth = rate(depth, THRESHOLDS.outboxDepth.warn, THRESHOLDS.outboxDepth.critical);
  const byAge = rate(oldestSeconds, THRESHOLDS.outboxAgeSeconds.warn, THRESHOLDS.outboxAgeSeconds.critical);
  // Either signal alone is enough: a small queue that is not moving is as bad as
  // a large one that is.
  const status = byDepth === 'critical' || byAge === 'critical' ? 'critical'
    : byDepth === 'warn' || byAge === 'warn' ? 'warn' : 'ok';

  return {
    key: 'outbox', label: 'Outbound sending',
    status, value: depth, unit: 'messages',
    detail: depth === 0 ? 'Nothing waiting' : `${depth} waiting, oldest ${oldestSeconds}s`,
  };
}

export function checkFlaggedChannels(flagged: number): HealthCheck {
  return {
    key: 'channel_quality', label: 'WhatsApp number quality',
    // A flagged number means Meta has restricted it — always critical, because
    // the shop is silently unable to reach its customers.
    status: flagged > 0 ? 'critical' : 'ok',
    value: flagged, unit: 'channels',
    detail: flagged > 0 ? `${flagged} number(s) flagged by Meta` : 'All numbers healthy',
  };
}

export function checkOpenCriticalEvents(open: number): HealthCheck {
  const t = THRESHOLDS.openCriticalEvents;
  return {
    key: 'security_events', label: 'Unacknowledged security events',
    status: rate(open, t.warn, t.critical),
    value: open, unit: 'events',
    detail: open === 0 ? 'None open' : `${open} critical event(s) nobody has looked at`,
  };
}

export function checkConnectionSaturation(inUse: number, max: number): HealthCheck {
  const fraction = max > 0 ? inUse / max : 0;
  const t = THRESHOLDS.connectionSaturation;
  return {
    key: 'db_connections', label: 'Database connections',
    status: rate(fraction, t.warn, t.critical),
    value: Math.round(fraction * 100), unit: 'percent',
    detail: `${inUse} of ${max} connections in use`,
  };
}

/**
 * Billed windows versus the counter they increment. Any difference means a
 * customer is being over- or under-charged, so the warn and critical thresholds
 * are the same number: one.
 */
export function checkMeteringDrift(windows: number, counter: number): HealthCheck {
  const drift = Math.abs(windows - counter);
  return {
    key: 'metering_drift', label: 'Metering accuracy',
    status: drift >= THRESHOLDS.meteringDrift.critical ? 'critical' : 'ok',
    value: drift, unit: 'conversations',
    detail: drift === 0
      ? 'Counters match the billed windows exactly'
      : `${windows} billed windows against a counter of ${counter}`,
  };
}

export const worstStatus = (checks: HealthCheck[]): HealthStatus =>
  checks.some((c) => c.status === 'critical') ? 'critical'
  : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';

export const failing = (checks: HealthCheck[]): HealthCheck[] =>
  checks.filter((c) => c.status !== 'ok');
