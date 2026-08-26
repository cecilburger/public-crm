import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env, type Env } from '@kirana/core';
import { withTenant, type Database } from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

const PASSWORD = 'correct horse battery staple';

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

const waPayload = (phoneNumberId: string, messageId: string, from = '628123456789') => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba-1',
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: phoneNumberId, display_phone_number: '628110000001' },
        contacts: [{ profile: { name: 'Bu Sari' }, wa_id: from }],
        messages: [{ id: messageId, from, timestamp: '1772000000', type: 'text',
                     text: { body: 'Sis, batik parang size M masih ada?' } }],
      },
    }],
  }],
});

describe('the API end to end', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let e: Env;
  let access: string;
  let refresh: string;

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'endtoend');
    e = env();

    app = buildApp({
      db, control: db, kek: TEST_KEK, env: e,
      // Tests run the queue inline so the whole path is exercised in one process.
      dispatch: async ({ queue, payload }) => {
        if (queue === 'inbound.normalise') {
          await processInboundWebhook(
            { db, control: db, kek: TEST_KEK, dispatch: async () => {} },
            (payload as { webhookEventId: string }).webhookEventId,
          );
        }
      },
    });
    await app.ready();
  });

  afterAll(async () => { await app.close(); await db.close(); });

  it('refuses anonymous access to tenant data', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/conversations' });
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toContain('unauthenticated');
  });

  it('signs a user in and returns a usable session', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'endtoend', email: 'owner@endtoend.test', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.role).toBe('owner');
    expect(body.user.tenantId).toBe(t.tenantId);
    access = body.accessToken;
    refresh = body.refreshToken;

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${access}` } });
    expect(me.json().workspace.slug).toBe('endtoend');
  });

  it('gives the same answer for a wrong password and an unknown workspace', async () => {
    const wrongPassword = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'endtoend', email: 'owner@endtoend.test', password: 'not the password' },
    });
    const unknownWorkspace = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'does-not-exist', email: 'owner@endtoend.test', password: PASSWORD },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownWorkspace.statusCode).toBe(401);
    expect(wrongPassword.json().detail).toBe(unknownWorkspace.json().detail);
  });

  it('rejects a webhook whose signature does not match the bytes received', async () => {
    const body = JSON.stringify(waPayload('wa-endtoend', 'wamid.bad'));
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('wrong-secret', body) },
      payload: body,
    });
    expect(res.statusCode).toBe(401);

    const spooled = await db.query('select count(*)::int as n from webhook_events');
    expect((spooled[0] as { n: number }).n).toBe(0);
  });

  it('accepts a signed webhook and turns it into a conversation', async () => {
    const body = JSON.stringify(waPayload('wa-endtoend', 'wamid.good.1'));
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(e.META_APP_SECRET, body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 1, accepted: 1 });

    const list = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: { authorization: `Bearer ${access}` },
    });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].display_name).toBe('Bu Sari');
  });

  it('spools a redelivered webhook only once', async () => {
    const body = JSON.stringify(waPayload('wa-endtoend', 'wamid.good.1'));
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/meta',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(e.META_APP_SECRET, body) },
      payload: body,
    });
    expect(res.json()).toEqual({ received: 1, accepted: 0 });

    const list = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: { authorization: `Bearer ${access}` },
    });
    expect(list.json()).toHaveLength(1);
  });

  it('decrypts the thread for a reader and reveals the phone by entitlement', async () => {
    const list = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: { authorization: `Bearer ${access}` },
    });
    const id = list.json()[0].id;

    const res = await app.inject({
      method: 'GET', url: `/v1/conversations/${id}`, headers: { authorization: `Bearer ${access}` },
    });
    const body = res.json();
    expect(body.messages[0].body).toBe('Sis, batik parang size M masih ada?');
    // The thread is dated by the customer's clock, not by our ingest time.
    expect(new Date(body.messages[0].at).getTime()).toBe(1772000000 * 1000);
    expect(body.contact.phone).toBe('+628123456789'); // owner holds contact:export
    expect(body.conversation.serviceWindowOpen).toBe(false); // the fixture is dated 2026-02-25
  });

  it('queues a reply and counts it against the plan', async () => {
    const list = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: { authorization: `Bearer ${access}` },
    });
    const id = list.json()[0].id;

    // The fixture's inbound is old, so the free-form window is shut and Meta
    // would reject a plain text reply. The API says so before the send.
    const blocked = await app.inject({
      method: 'POST', url: `/v1/conversations/${id}/messages`,
      headers: { authorization: `Bearer ${access}` },
      payload: { body: 'Halo Bu Sari, stok masih ada' },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().detail).toMatch(/24-hour reply window/);

    const sent = await app.inject({
      method: 'POST', url: `/v1/conversations/${id}/messages`,
      headers: { authorization: `Bearer ${access}` },
      payload: { body: 'Halo Bu Sari, stok masih ada', templateName: 'stock_followup_id' },
    });
    expect(sent.statusCode).toBe(202);

    const usage = await app.inject({
      method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${access}` },
    });
    const u = usage.json();
    expect(u.usage.conversations).toBe(1);
    expect(u.usage.messages_out).toBe(1);
    expect(u.included.conversations).toBe(3_000);
    expect(u.projectedTotalIdr).toBe(3_900_000);
  });

  it('quotes the same price the website does', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/billing/estimate?plan=growth&interval=monthly&extraNumbers=2&extraSeats=3',
    });
    expect(res.json().totalMonthlyIdr).toBe(5_150_000);
  });

  it("stops an agent from doing an admin's job", async () => {
    const created = await app.inject({
      method: 'POST', url: '/v1/members', headers: { authorization: `Bearer ${access}` },
      payload: { email: 'agent@endtoend.test', name: 'Agent', password: 'another long password', role: 'agent' },
    });
    expect(created.statusCode).toBe(201);

    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'endtoend', email: 'agent@endtoend.test', password: 'another long password' },
    });
    const agentToken = login.json().accessToken;

    const canRead = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(canRead.statusCode).toBe(200);

    const cannotInvite = await app.inject({
      method: 'POST', url: '/v1/members', headers: { authorization: `Bearer ${agentToken}` },
      payload: { email: 'x@endtoend.test', name: 'X', password: 'yet another password', role: 'agent' },
    });
    expect(cannotInvite.statusCode).toBe(403);

    const cannotAudit = await app.inject({
      method: 'GET', url: '/v1/audit', headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(cannotAudit.statusCode).toBe(403);
  });

  it('locks out repeated sign-in attempts on the same account', async () => {
    // A different email, so the lockout cannot spill onto the other tests: the
    // key is (workspace, email), which is what credential stuffing targets.
    const attempt = () => app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'endtoend', email: 'victim@endtoend.test', password: 'wrong guess here' },
    });

    for (let i = 0; i < 8; i += 1) expect((await attempt()).statusCode).toBe(401);

    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.json().detail).toMatch(/sign-in attempts/i);

    // The owner is unaffected — the limit is per account, not per workspace.
    const unaffected = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'endtoend', email: 'owner@endtoend.test', password: PASSWORD },
    });
    expect(unaffected.statusCode).toBe(200);
  });

  it('rotates refresh tokens and kills the family when one is replayed', async () => {
    const first = await app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { workspace: 'endtoend', refreshToken: refresh },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json().refreshToken;
    expect(rotated).not.toBe(refresh);

    // Replaying the old token is the signal that it was copied.
    const replay = await app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { workspace: 'endtoend', refreshToken: refresh },
    });
    expect(replay.statusCode).toBe(401);

    // …and the token issued from that family dies with it.
    const afterBurn = await app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { workspace: 'endtoend', refreshToken: rotated },
    });
    expect(afterBurn.statusCode).toBe(401);
  });

  it('writes an audit trail that verifies', async () => {
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'endtoend', email: 'owner@endtoend.test', password: PASSWORD },
    });
    const token = login.json().accessToken;

    const trail = await app.inject({
      method: 'GET', url: '/v1/audit', headers: { authorization: `Bearer ${token}` },
    });
    const actions = trail.json().map((r: { action: string }) => r.action);
    expect(actions).toContain('message.sent');
    expect(actions).toContain('auth.login');
    expect(actions).toContain('tenant.provisioned');

    const verify = await app.inject({
      method: 'GET', url: '/v1/audit/verify', headers: { authorization: `Bearer ${token}` },
    });
    expect(verify.json()).toEqual({ ok: true });
  });

  it('erases a customer on request without breaking the invoice', async () => {
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'endtoend', email: 'owner@endtoend.test', password: PASSWORD },
    });
    const token = login.json().accessToken;

    const contactId = await withTenant(db, t.tenantId, async (tx) => {
      const rows = await tx.query<{ id: string }>('select id from contacts limit 1');
      return rows[0]!.id;
    });

    const dsr = await app.inject({
      method: 'POST', url: '/v1/dsr', headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'erasure', contactId, reason: 'customer asked over WhatsApp' },
    });
    expect(dsr.statusCode).toBe(201);

    const executed = await app.inject({
      method: 'POST', url: `/v1/dsr/${dsr.json().id}/execute`, headers: { authorization: `Bearer ${token}` },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json().messagesRedacted).toBeGreaterThan(0);

    const after = await withTenant(db, t.tenantId, async (tx) => ({
      contact: await tx.query<{ phone_enc: string | null; phone_bidx: string | null }>(
        'select phone_enc, phone_bidx from contacts where id = $1', [contactId]),
      bodies: await tx.query<{ n: number }>(
        'select count(*)::int as n from messages where body_enc is not null'),
      counters: await tx.query<{ value: string }>(
        `select value from usage_counters where metric = 'conversations'`),
    }));

    expect(after.contact[0]!.phone_enc).toBeNull();
    expect(after.contact[0]!.phone_bidx).toBeNull();
    expect(after.bodies[0]!.n).toBe(0);
    // Billing history survives erasure: it holds counts, not people.
    expect(Number(after.counters[0]!.value)).toBe(1);
  });
});

describe('the API budget', () => {
  let db: Database;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    db = await freshDb();
    const t = await makeTenant(db, 'budget');
    app = buildApp({
      db, control: db, kek: TEST_KEK, env: env(),
      dispatch: async () => {},
      rateLimit: { max: 3, windowMs: 60_000 },
    });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'budget', email: `owner@budget.test`, password: PASSWORD },
    });
    token = login.json().accessToken;
    void t;
  });
  afterAll(async () => { await app.close(); await db.close(); });

  it('refuses once a workspace has spent its budget, and says when to come back', async () => {
    const call = () => app.inject({
      method: 'GET', url: '/v1/conversations', headers: { authorization: `Bearer ${token}` },
    });

    const first = await call();
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');

    await call();
    await call();
    const blocked = await call();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.json().type).toContain('rate_limited');
  });

  it('never throttles the provider webhook, which has to absorb bursts', async () => {
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: 'POST', url: '/v1/webhooks/meta',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=nope' },
        payload: '{}',
      });
      // 401 for the bad signature, never 429.
      expect(res.statusCode).toBe(401);
    }
  });

  it('keeps health probes outside the budget', async () => {
    for (let i = 0; i < 6; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
  });
});
