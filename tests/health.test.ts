import { describe, it, expect } from 'vitest';
import {
  checkWebhookBacklog, checkOutbox, checkFlaggedChannels, checkOpenCriticalEvents,
  checkConnectionSaturation, checkMeteringDrift, worstStatus, failing, THRESHOLDS,
} from '@kirana/core';
import { runHealthChecks, readiness } from '../apps/worker/src/processors/healthChecks.ts';
import { LogAlertSink, type SecurityAlert, type AlertSink } from '@kirana/core';
import { freshDb, makeTenant } from './helpers/db.ts';

class Collecting implements AlertSink {
  alerts: SecurityAlert[] = [];
  async deliver(a: SecurityAlert) { this.alerts.push(a); }
}

describe('the thresholds', () => {
  it('escalates webhook backlog by age', () => {
    expect(checkWebhookBacklog(0).status).toBe('ok');
    expect(checkWebhookBacklog(THRESHOLDS.webhookBacklogSeconds.warn).status).toBe('warn');
    expect(checkWebhookBacklog(THRESHOLDS.webhookBacklogSeconds.critical).status).toBe('critical');
  });

  it('treats a small stuck queue as seriously as a large moving one', () => {
    // 10 messages is nothing; 10 messages that have not moved in 11 minutes is
    // an outage.
    expect(checkOutbox(10, 0).status).toBe('ok');
    expect(checkOutbox(10, 660).status).toBe('critical');
    expect(checkOutbox(1_500, 5).status).toBe('critical');
  });

  it('calls any flagged WhatsApp number critical, however few', () => {
    expect(checkFlaggedChannels(0).status).toBe('ok');
    expect(checkFlaggedChannels(1).status).toBe('critical');
    expect(checkFlaggedChannels(1).detail).toContain('Meta');
  });

  it('warns on the first unacknowledged critical security event', () => {
    expect(checkOpenCriticalEvents(0).status).toBe('ok');
    expect(checkOpenCriticalEvents(1).status).toBe('warn');
    expect(checkOpenCriticalEvents(3).status).toBe('critical');
  });

  it('reports connection use as a percentage of the pool', () => {
    expect(checkConnectionSaturation(5, 20)).toMatchObject({ status: 'ok', value: 25 });
    expect(checkConnectionSaturation(15, 20).status).toBe('warn');
    expect(checkConnectionSaturation(18, 20).status).toBe('critical');
    expect(checkConnectionSaturation(1, 0).status).toBe('ok'); // no pool size known
  });

  it('treats any metering drift at all as critical', () => {
    // A customer being charged for one conversation they did not have is not a
    // warning, so warn and critical are the same number.
    expect(checkMeteringDrift(100, 100).status).toBe('ok');
    expect(checkMeteringDrift(100, 99).status).toBe('critical');
    expect(checkMeteringDrift(99, 100).status).toBe('critical');
  });

  it('reports the worst status across all checks', () => {
    const ok = checkWebhookBacklog(0);
    const warn = checkOpenCriticalEvents(1);
    const bad = checkFlaggedChannels(1);
    expect(worstStatus([ok, ok])).toBe('ok');
    expect(worstStatus([ok, warn])).toBe('warn');
    expect(worstStatus([ok, warn, bad])).toBe('critical');
    expect(failing([ok, warn, bad])).toHaveLength(2);
  });
});

describe('running them against a real database', () => {
  it('reports healthy on a quiet system, and alerts on nothing', async () => {
    const db = await freshDb();
    try {
      await makeTenant(db, 'health');
      const sink = new Collecting();
      const report = await runHealthChecks(db, db, { sink });

      expect(report.status).toBe('ok');
      expect(report.checks.map((c) => c.key)).toEqual([
        'webhook_backlog', 'outbox', 'channel_quality',
        'security_events', 'db_connections', 'metering_drift',
      ]);
      expect(sink.alerts).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it('notices a flagged number and tells somebody', async () => {
    const db = await freshDb();
    try {
      const t = await makeTenant(db, 'flagged');
      await db.query(`update channels set quality = 'flagged' where tenant_id = $1`, [t.tenantId]);

      const sink = new Collecting();
      const report = await runHealthChecks(db, db, { sink });

      expect(report.status).toBe('critical');
      expect(report.checks.find((c) => c.key === 'channel_quality')!.status).toBe('critical');
      expect(sink.alerts).toHaveLength(1);
      expect(sink.alerts[0]!.severity).toBe('critical');
      expect(sink.alerts[0]!.summary).toContain('number quality');
    } finally {
      await db.close();
    }
  });

  it('catches metering drift, which is the number a customer would notice', async () => {
    const db = await freshDb();
    try {
      const t = await makeTenant(db, 'drift');
      // A counter that disagrees with the windows it is supposed to count.
      await db.query(
        `insert into billing_periods (tenant_id, starts_at, ends_at, plan_code)
         values ($1, now() - interval '1 day', now() + interval '29 days', 'growth')`, [t.tenantId]);
      const period = await db.query<{ id: string }>('select id from billing_periods limit 1');
      await db.query(
        `insert into usage_counters (tenant_id, billing_period_id, metric, value)
         values ($1, $2, 'conversations', 7)`, [t.tenantId, period[0]!.id]);

      const report = await runHealthChecks(db, db, { sink: new LogAlertSink() });
      const drift = report.checks.find((c) => c.key === 'metering_drift')!;
      expect(drift.status).toBe('critical');
      expect(drift.value).toBe(7);   // seven counted, zero actually billed
    } finally {
      await db.close();
    }
  });

  it('separates readiness from liveness', async () => {
    const db = await freshDb();
    expect(await readiness(db)).toEqual({ ready: true, detail: 'database reachable' });
    await db.close();

    const dead = await readiness(db);
    expect(dead.ready).toBe(false);
  });
});

describe('the metrics endpoint', () => {
  it('never lets a uuid in the path create a time series per conversation', async () => {
    const { routeLabel } = await import('../apps/api/src/metrics.ts');
    // With a route pattern, use it verbatim.
    expect(routeLabel('/v1/conversations/:id', '/v1/conversations/abc')).toBe('/v1/conversations/:id');
    // Without one, collapse uuids so cardinality stays bounded.
    expect(routeLabel(undefined, '/v1/conversations/7e640a9a-0009-443d-88cb-0883cfacbe35/messages'))
      .toBe('/v1/conversations/:id/messages');
    expect(routeLabel(undefined, '/v1/usage?x=1')).toBe('/v1/usage');
  });

  it('serves Prometheus text, and hides itself when a token is configured', async () => {
    const { buildApp } = await import('../apps/api/src/app.ts');
    const { env } = await import('@kirana/core');
    const db = await freshDb();
    try {
      const open = buildApp({ db, control: db, kek: Buffer.alloc(32, 3), env: env(), dispatch: async () => {} });
      await open.ready();
      const res = await open.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('kirana_http_requests_total');
      expect(res.body).toContain('kirana_billable_conversations_total');
      // No tenant identifiers anywhere in a scrape.
      expect(res.body).not.toMatch(/tenant="/);
      await open.close();

      const guarded = buildApp({
        db, control: db, kek: Buffer.alloc(32, 3),
        env: { ...env(), METRICS_TOKEN: 'secret-token' },
        dispatch: async () => {},
      });
      await guarded.ready();
      // 404 rather than 401: an unauthenticated scraper should not learn the
      // endpoint exists.
      expect((await guarded.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
      const ok = await guarded.inject({
        method: 'GET', url: '/metrics', headers: { authorization: 'Bearer secret-token' },
      });
      expect(ok.statusCode).toBe(200);
      await guarded.close();
    } finally {
      await db.close();
    }
  });
});
