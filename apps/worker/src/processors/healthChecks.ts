import {
  checkWebhookBacklog, checkOutbox, checkFlaggedChannels, checkOpenCriticalEvents,
  checkConnectionSaturation, checkMeteringDrift, worstStatus, failing,
  LogAlertSink, type HealthCheck, type HealthStatus, type AlertSink,
} from '@kirana/core';
import { platformHealthSnapshot, type Database } from '@kirana/db';

export interface HealthReport {
  status: HealthStatus;
  checks: HealthCheck[];
  at: Date;
}

/**
 * The six checks `OPERATIONS.md` said should page somebody.
 *
 * They run against the whole platform rather than one tenant, because "is
 * ingestion moving?" is not a per-workspace question. Anything failing is
 * delivered to the alert sink; everything is returned so a status page or a
 * scrape can read it.
 */
export async function runHealthChecks(
  db: Database,
  control: Database,
  opts: { sink?: AlertSink; poolMax?: number; now?: Date } = {},
): Promise<HealthReport> {
  const sink = opts.sink ?? new LogAlertSink();
  const now = opts.now ?? new Date();
  // One pass, one auditable place. The worker decides what the numbers mean; it
  // does not go looking for them across tenants itself.
  const snapshot = await platformHealthSnapshot(control);

  const checks: HealthCheck[] = [
    checkWebhookBacklog(snapshot.webhookBacklogSeconds),
    checkOutbox(snapshot.outboxDepth, snapshot.outboxOldestSeconds),
    checkFlaggedChannels(snapshot.flaggedChannels),
    checkOpenCriticalEvents(snapshot.openCriticalEvents),
    checkConnectionSaturation(snapshot.connectionsInUse, opts.poolMax ?? 20),
    checkMeteringDrift(snapshot.meteringWindows, snapshot.meteringCounter),
  ];

  const report: HealthReport = { status: worstStatus(checks), checks, at: now };

  for (const check of failing(checks)) {
    await sink.deliver({
      kind: 'dsr_overdue', // operational channel: something needs a person
      severity: check.status === 'critical' ? 'critical' : 'warning',
      tenantId: 'platform',
      summary: `${check.label}: ${check.detail}`,
      detail: { key: check.key, value: check.value, unit: check.unit },
      detectedAt: now,
      notifiable: false,
    });
  }

  return report;
}

/**
 * Readiness, as distinct from liveness.
 *
 * Liveness asks whether the process is alive; readiness asks whether it should
 * receive traffic. A worker whose database is unreachable should be taken out of
 * rotation, not restarted.
 */
export async function readiness(db: Database): Promise<{ ready: boolean; detail: string }> {
  try {
    await db.query('select 1');
    return { ready: true, detail: 'database reachable' };
  } catch (err) {
    return { ready: false, detail: (err as Error).message.slice(0, 200) };
  }
}
