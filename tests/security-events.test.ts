import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  clockState, notificationDeadline, isNotifiable, severityOf,
  LogAlertSink, FanOutSink, env,
  type SecurityAlert, type AlertSink,
} from '@kirana/core';
import { WebhookAlertSink } from '../apps/worker/src/alerts/webhook.ts';
import { withTenant, recordSecurityEvent, listSecurityEvents, type Database } from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { verifyAllAuditChains, sweepSecurityClocks } from '../apps/worker/src/processors/retention.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

class CollectingSink implements AlertSink {
  alerts: SecurityAlert[] = [];
  async deliver(alert: SecurityAlert) { this.alerts.push(alert); }
}

const HOUR = 3600_000;

describe('the statutory clock', () => {
  const detectedAt = new Date('2026-03-01T09:00:00Z');

  it('runs only for events where personal data is plausibly affected', () => {
    expect(isNotifiable('audit_chain_broken')).toBe(true);
    expect(isNotifiable('cross_tenant_denied')).toBe(true);
    expect(isNotifiable('refresh_token_reuse')).toBe(true);
    expect(isNotifiable('login_lockout')).toBe(false);
    expect(clockState({ kind: 'login_lockout', detectedAt, notifiedAt: null }, detectedAt))
      .toBe('not_applicable');
  });

  it('gives exactly 3×24 hours from becoming aware', () => {
    expect(notificationDeadline(detectedAt).toISOString()).toBe('2026-03-04T09:00:00.000Z');
  });

  it('warns while there is still time to act, not after', () => {
    const event = { kind: 'audit_chain_broken' as const, detectedAt, notifiedAt: null };
    expect(clockState(event, new Date(detectedAt.getTime() + 1 * HOUR))).toBe('running');
    expect(clockState(event, new Date(detectedAt.getTime() + 61 * HOUR))).toBe('due_soon');
    expect(clockState(event, new Date(detectedAt.getTime() + 73 * HOUR))).toBe('overdue');
  });

  it('stops once the notification has been made', () => {
    const notified = { kind: 'audit_chain_broken' as const, detectedAt, notifiedAt: new Date() };
    expect(clockState(notified, new Date(detectedAt.getTime() + 100 * HOUR))).toBe('notified');
  });

  it('rates a tampered audit log as critical', () => {
    expect(severityOf('audit_chain_broken')).toBe('critical');
    expect(severityOf('login_lockout')).toBe('info');
  });
});

describe('alert delivery', () => {
  const alert: SecurityAlert = {
    kind: 'audit_chain_broken', severity: 'critical', tenantId: 't1',
    summary: 'broken', detail: { at: 4 }, detectedAt: new Date('2026-03-01T09:00:00Z'), notifiable: true,
  };

  it('writes a structured line that a log pipeline can alert on', async () => {
    const lines: string[] = [];
    await new LogAlertSink((l) => lines.push(l)).deliver(alert);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ level: 'fatal', event: 'security_alert', kind: 'audit_chain_broken' });
  });

  it('posts the deadline to an operations webhook', async () => {
    let body: Record<string, unknown> = {};
    const fake = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)); return new Response('ok');
    }) as unknown as typeof fetch;

    await new WebhookAlertSink('https://ops.example/hook', fake).deliver(alert);
    expect(body.deadline).toBe('2026-03-04T09:00:00.000Z');
    expect(String(body.text)).toContain('CRITICAL');
  });

  it('never lets a dead webhook swallow the alert entirely', async () => {
    const lines: string[] = [];
    const errors: Error[] = [];
    const broken = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    await new FanOutSink([
      new LogAlertSink((l) => lines.push(l)),
      new WebhookAlertSink('https://ops.example/hook', broken, (e) => errors.push(e)),
    ]).deliver(alert);

    expect(lines).toHaveLength(1);      // the log still got it
    expect(errors[0]!.message).toBe('ECONNREFUSED');
  });
});

describe('recording and working through events', () => {
  let db: Database;
  let t: TestTenant;

  beforeEach(async () => { db = await freshDb(); t = await makeTenant(db, 'sec'); });
  afterEach(async () => { await db.close(); });

  it('writes down when we became aware, with the clock attached', async () => {
    await withTenant(db, t.tenantId, (tx) =>
      recordSecurityEvent(tx, t.tenantId, 'cross_tenant_denied', { path: '/v1/contacts' }));

    const events = await withTenant(db, t.tenantId, (tx) => listSecurityEvents(tx, t.tenantId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'cross_tenant_denied', severity: 'critical', notifiable: true });
    expect(events[0]!.clock).toBe('running');
    expect(events[0]!.deadline).toBeInstanceOf(Date);
  });

  it('keeps one tenant"s security events away from another', async () => {
    const other = await makeTenant(db, 'sec-other');
    await withTenant(db, t.tenantId, (tx) =>
      recordSecurityEvent(tx, t.tenantId, 'audit_chain_broken', {}));

    const seen = await withTenant(db, other.tenantId, (tx) => listSecurityEvents(tx, other.tenantId));
    expect(seen).toHaveLength(0);
  });

  it('raises a critical event the moment the audit chain fails to verify', async () => {
    const sink = new CollectingSink();
    expect((await verifyAllAuditChains(db, db, sink)).broken).toEqual([]);
    expect(sink.alerts).toHaveLength(0);

    // Tamper with history the way only a database-level actor could.
    await withTenant(db, t.tenantId, (tx) =>
      tx.query(`update audit_events set action = 'nothing.happened' where tenant_id = $1`, [t.tenantId])
        .catch(() => undefined));
    await db.exec(`update audit_events set action = 'nothing.happened'
                    where id = (select min(id) from audit_events)`);

    const result = await verifyAllAuditChains(db, db, sink);
    expect(result.broken).toHaveLength(1);
    expect(sink.alerts[0]).toMatchObject({ kind: 'audit_chain_broken', severity: 'critical', notifiable: true });

    const recorded = await withTenant(db, t.tenantId, (tx) => listSecurityEvents(tx, t.tenantId));
    expect(recorded[0]!.kind).toBe('audit_chain_broken');
  });

  it('chases a clock that is running out, and screams once it has', async () => {
    const sink = new CollectingSink();
    await withTenant(db, t.tenantId, (tx) =>
      recordSecurityEvent(tx, t.tenantId, 'refresh_token_reuse', {}, new Date(Date.now() - 65 * HOUR)));

    const dueSoon = await sweepSecurityClocks(db, db, sink);
    expect(dueSoon[0]!.clock).toBe('due_soon');
    expect(sink.alerts[0]!.summary).toContain('due within 12 hours');

    await withTenant(db, t.tenantId, (tx) =>
      tx.query(`update security_events set detected_at = now() - interval '80 hours' where tenant_id = $1`,
        [t.tenantId]));

    const overdue = await sweepSecurityClocks(db, db, sink);
    expect(overdue[0]!.clock).toBe('overdue');
    expect(sink.alerts[1]!.summary).toContain('OVERDUE');
    expect(sink.alerts[1]!.severity).toBe('critical');
  });
});

describe('the API a person actually uses', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let token = '';
  const sink = new CollectingSink();

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'secapi');
    app = buildApp({ db, control: db, kek: TEST_KEK, env: env(), dispatch: async () => {}, alerts: sink });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'secapi', email: 'owner@secapi.test', password: 'correct horse battery staple' },
    });
    token = login.json().accessToken;
  });
  afterEach(async () => { await app.close(); await db.close(); });

  it('shows how many clocks are running, which is the number that matters', async () => {
    await withTenant(db, t.tenantId, async (tx) => {
      await recordSecurityEvent(tx, t.tenantId, 'audit_chain_broken', {});
      await recordSecurityEvent(tx, t.tenantId, 'login_lockout', {});
    });

    const res = await app.inject({
      method: 'GET', url: '/v1/security/events', headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().events).toHaveLength(2);
    expect(res.json().clocksRunning).toBe(1);   // the lockout is not notifiable
    expect(res.json().overdue).toBe(0);
  });

  it('keeps security events away from agents', async () => {
    await app.inject({
      method: 'POST', url: '/v1/members', headers: { authorization: `Bearer ${token}` },
      payload: { email: 'agent@secapi.test', name: 'Agent', password: 'another long password', role: 'agent' },
    });
    const agent = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'secapi', email: 'agent@secapi.test', password: 'another long password' },
    });
    const res = await app.inject({
      method: 'GET', url: '/v1/security/events',
      headers: { authorization: `Bearer ${agent.json().accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('records who stopped the clock, and audits it', async () => {
    const recorded = await withTenant(db, t.tenantId, (tx) =>
      recordSecurityEvent(tx, t.tenantId, 'audit_chain_broken', {}));

    const noNotes = await app.inject({
      method: 'POST', url: `/v1/security/events/${recorded.id}/notified`,
      headers: { authorization: `Bearer ${token}` }, payload: {},
    });
    expect(noNotes.statusCode).toBe(422); // stopping a statutory clock needs a record of why

    const done = await app.inject({
      method: 'POST', url: `/v1/security/events/${recorded.id}/notified`,
      headers: { authorization: `Bearer ${token}` },
      payload: { notes: 'Notified Kominfo and 42 affected customers on 2 March' },
    });
    expect(done.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET', url: '/v1/security/events', headers: { authorization: `Bearer ${token}` },
    });
    expect(after.json().events[0].clock).toBe('notified');
    expect(after.json().clocksRunning).toBe(0);

    const trail = await app.inject({
      method: 'GET', url: '/v1/audit', headers: { authorization: `Bearer ${token}` },
    });
    expect(trail.json().map((r: { action: string }) => r.action)).toContain('security.breach_notified');
  });

  it('raises an event when a refresh token is presented twice', async () => {
    sink.alerts.length = 0;
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'secapi', email: 'owner@secapi.test', password: 'correct horse battery staple' },
    });
    const refresh = login.json().refreshToken;

    await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { workspace: 'secapi', refreshToken: refresh } });
    await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { workspace: 'secapi', refreshToken: refresh } });

    // The alert is raised outside the request, so give it a tick to land.
    await new Promise((r) => setTimeout(r, 60));
    expect(sink.alerts.some((a) => a.kind === 'refresh_token_reuse')).toBe(true);

    const events = await withTenant(db, t.tenantId, (tx) => listSecurityEvents(tx, t.tenantId));
    expect(events.some((e) => e.kind === 'refresh_token_reuse')).toBe(true);
  });
});
