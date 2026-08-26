import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  totalsFor, formatInvoiceNumber, dueDate, dunningFor, ManualTransferProvider,
  env, ESCALATE_AFTER_DAYS, type InvoiceLine,
} from '@kirana/core';
import {
  withTenant, issueInvoiceForPeriod, listInvoices, getInvoice, markInvoicePaid,
  nextInvoiceNumber, type Database,
} from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { closePeriodAndIssueInvoice, runDunning } from '../apps/worker/src/processors/billingRollup.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

const DAY = 86_400_000;
const line = (over: Partial<InvoiceLine> = {}): InvoiceLine => ({
  key: 'plan', label: 'Growth', qty: 1, unitIdr: 3_900_000, amountIdr: 3_900_000, ...over,
});

describe('invoice arithmetic', () => {
  it('adds PPN on top and rounds exactly once', () => {
    const totals = totalsFor([line()], 0.11);
    expect(totals.subtotalIdr).toBe(3_900_000);
    expect(totals.ppnIdr).toBe(429_000);
    expect(totals.totalIdr).toBe(4_329_000);
  });

  it('rounds the tax on the total, not line by line', () => {
    // Three lines that each round up would drift; one rounding at the end cannot.
    const lines = [line({ amountIdr: 333 }), line({ amountIdr: 333 }), line({ amountIdr: 333 })];
    const totals = totalsFor(lines, 0.11);
    expect(totals.subtotalIdr).toBe(999);
    expect(totals.ppnIdr).toBe(Math.round(999 * 0.11));
    expect(totals.ppnIdr).not.toBe(3 * Math.round(333 * 0.11));
  });

  it('handles a credit line without going negative on tax by accident', () => {
    const totals = totalsFor([line(), line({ key: 'discount', amountIdr: -650_000 })], 0.11);
    expect(totals.subtotalIdr).toBe(3_250_000);
    expect(totals.totalIdr).toBe(3_250_000 + Math.round(3_250_000 * 0.11));
  });

  it('numbers invoices the way a bookkeeper expects', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('KIR/2026/000001');
    expect(formatInvoiceNumber(2026, 123_456)).toBe('KIR/2026/123456');
  });

  it('gives fourteen days to pay', () => {
    expect(dueDate(new Date('2026-03-01T00:00:00Z')).toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });
});

describe('chasing an unpaid invoice', () => {
  const dueAt = new Date('2026-03-01T00:00:00Z');
  const at = (days: number) => new Date(dueAt.getTime() + days * DAY);

  it('says nothing before the due date', () => {
    expect(dunningFor({ status: 'issued', dueAt, remindersSent: 0 }, at(-1)).action).toBe('none');
  });

  it('reminds at three, seven and fourteen days — once each', () => {
    expect(dunningFor({ status: 'issued', dueAt, remindersSent: 0 }, at(3)))
      .toEqual({ action: 'remind', step: 1, daysOverdue: 3 });
    // Already reminded once: nothing more until the next threshold.
    expect(dunningFor({ status: 'overdue', dueAt, remindersSent: 1 }, at(4)).action).toBe('none');
    expect(dunningFor({ status: 'overdue', dueAt, remindersSent: 1 }, at(7)))
      .toEqual({ action: 'remind', step: 2, daysOverdue: 7 });
    expect(dunningFor({ status: 'overdue', dueAt, remindersSent: 2 }, at(14)))
      .toEqual({ action: 'remind', step: 3, daysOverdue: 14 });
    expect(dunningFor({ status: 'overdue', dueAt, remindersSent: 3 }, at(15)).action).toBe('none');
  });

  it('escalates to a person at three weeks rather than cutting anyone off', () => {
    const decision = dunningFor({ status: 'overdue', dueAt, remindersSent: 3 }, at(ESCALATE_AFTER_DAYS));
    expect(decision).toEqual({ action: 'escalate', daysOverdue: ESCALATE_AFTER_DAYS });
  });

  it('leaves a paid invoice alone', () => {
    expect(dunningFor({ status: 'paid', dueAt, remindersSent: 0 }, at(30)).action).toBe('none');
  });
});

describe('issuing invoices', () => {
  let db: Database;
  let t: TestTenant;

  const period = async (endsAt: Date) => withTenant(db, t.tenantId, async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into billing_periods (tenant_id, starts_at, ends_at, plan_code)
       values ($1, $2, $3, 'growth') returning id`,
      [t.tenantId, new Date(endsAt.getTime() - 30 * DAY), endsAt],
    );
    return rows[0]!.id;
  });

  beforeEach(async () => { db = await freshDb(); t = await makeTenant(db, 'inv'); });
  afterEach(async () => { await db.close(); });

  it('numbers sequentially within a year', async () => {
    const numbers = await withTenant(db, t.tenantId, async (tx) => [
      await nextInvoiceNumber(tx, t.tenantId, 2026),
      await nextInvoiceNumber(tx, t.tenantId, 2026),
      await nextInvoiceNumber(tx, t.tenantId, 2027),
    ]);
    expect(numbers).toEqual(['KIR/2026/000001', 'KIR/2026/000002', 'KIR/2027/000001']);
  });

  it('writes a durable invoice with its lines and totals', async () => {
    const periodId = await period(new Date());
    const issued = await withTenant(db, t.tenantId, (tx) =>
      issueInvoiceForPeriod(tx, t.tenantId, {
        billingPeriodId: periodId,
        lines: [line(), line({ key: 'overage', label: '200 extra', qty: 200, unitIdr: 1_500, amountIdr: 300_000 })],
      }));

    expect(issued!.totalIdr).toBe(Math.round(4_200_000 * 1.11));
    const stored = await withTenant(db, t.tenantId, (tx) => getInvoice(tx, t.tenantId, issued!.id));
    expect(stored!.status).toBe('issued');
    expect(stored!.lines).toHaveLength(2);
    expect(stored!.lines[1]!.qty).toBe(200);
    expect(stored!.dueAt).toBeInstanceOf(Date);
  });

  it('will not bill the same period twice', async () => {
    const periodId = await period(new Date());
    const first = await withTenant(db, t.tenantId, (tx) =>
      issueInvoiceForPeriod(tx, t.tenantId, { billingPeriodId: periodId, lines: [line()] }));
    const second = await withTenant(db, t.tenantId, (tx) =>
      issueInvoiceForPeriod(tx, t.tenantId, { billingPeriodId: periodId, lines: [line()] }));

    expect(second!.id).toBe(first!.id);
    expect(second!.number).toBe(first!.number);
    const all = await withTenant(db, t.tenantId, (tx) => listInvoices(tx, t.tenantId));
    expect(all).toHaveLength(1);
  });

  it('snapshots who the bill is made out to, so later edits cannot change it', async () => {
    await withTenant(db, t.tenantId, (tx) => tx.query(
      `insert into billing_profiles (tenant_id, legal_name, npwp) values ($1, 'PT Toko Demo', '01.234.567.8-901.000')`,
      [t.tenantId]));

    const periodId = await period(new Date());
    const issued = await withTenant(db, t.tenantId, (tx) =>
      issueInvoiceForPeriod(tx, t.tenantId, { billingPeriodId: periodId, lines: [line()] }));

    await withTenant(db, t.tenantId, (tx) => tx.query(
      `update billing_profiles set legal_name = 'PT Nama Baru' where tenant_id = $1`, [t.tenantId]));

    const stored = await withTenant(db, t.tenantId, (tx) => getInvoice(tx, t.tenantId, issued!.id));
    expect(stored!.billToName).toBe('PT Toko Demo');
    expect(stored!.billToNpwp).toBe('01.234.567.8-901.000');
  });

  it('turns a closed period into an invoice, and marks the period invoiced', async () => {
    await period(new Date(Date.now() - DAY));
    const summary = await closePeriodAndIssueInvoice(db, t.tenantId);

    expect(summary).not.toBeNull();
    expect(summary!.number).toMatch(/^KIR\/\d{4}\/\d{6}$/);
    expect(summary!.lines.some((l) => l.key === 'plan')).toBe(true);

    const state = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string }>('select status from billing_periods'));
    expect(state[0]!.status).toBe('invoiced');
  });

  it('records a bank transfer against the invoice and restores good standing', async () => {
    const periodId = await period(new Date());
    const issued = await withTenant(db, t.tenantId, (tx) =>
      issueInvoiceForPeriod(tx, t.tenantId, { billingPeriodId: periodId, lines: [line()] }));

    await withTenant(db, t.tenantId, (tx) =>
      tx.query(`update tenants set status = 'past_due' where id = $1`, [t.tenantId]));

    const paid = await withTenant(db, t.tenantId, async (tx) => {
      const user = await tx.query<{ id: string }>('select id from users limit 1');
      return markInvoicePaid(tx, t.tenantId, issued!.id, {
        userId: user[0]!.id, reference: 'BCA/2026-03-04/8891',
      });
    });
    expect(paid).toBe(true);

    const after = await withTenant(db, t.tenantId, async (tx) => ({
      invoice: await getInvoice(tx, t.tenantId, issued!.id),
      tenant: await tx.query<{ status: string }>('select status from tenants where id = $1', [t.tenantId]),
    }));
    expect(after.invoice!.status).toBe('paid');
    expect(after.invoice!.paidAt).toBeInstanceOf(Date);
    expect(after.tenant[0]!.status).toBe('active');
  });

  it('refuses to mark an already-paid invoice paid again', async () => {
    const periodId = await period(new Date());
    const issued = await withTenant(db, t.tenantId, (tx) =>
      issueInvoiceForPeriod(tx, t.tenantId, { billingPeriodId: periodId, lines: [line()] }));

    const twice = await withTenant(db, t.tenantId, async (tx) => {
      const user = await tx.query<{ id: string }>('select id from users limit 1');
      const first = await markInvoicePaid(tx, t.tenantId, issued!.id, { userId: user[0]!.id, reference: 'a' });
      const second = await markInvoicePaid(tx, t.tenantId, issued!.id, { userId: user[0]!.id, reference: 'b' });
      return [first, second];
    });
    expect(twice).toEqual([true, false]);
  });

  it('chases, then flags the account, without ever cutting service', async () => {
    const periodId = await period(new Date());
    const issued = await withTenant(db, t.tenantId, (tx) =>
      issueInvoiceForPeriod(tx, t.tenantId, { billingPeriodId: periodId, lines: [line()] }));

    const overdueBy = (days: number) => withTenant(db, t.tenantId, (tx) =>
      tx.query(`update invoices set due_at = now() - make_interval(days => $2) where tenant_id = $1`,
        [t.tenantId, days]));

    await overdueBy(3);
    expect((await runDunning(db, db))[0]).toMatchObject({ action: 'remind', number: issued!.number });

    await overdueBy(7);
    expect((await runDunning(db, db))[0]!.action).toBe('remind');

    await overdueBy(ESCALATE_AFTER_DAYS + 1);
    expect((await runDunning(db, db))[0]!.action).toBe('escalate');

    const tenant = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string }>('select status from tenants where id = $1', [t.tenantId]));
    expect(tenant[0]!.status).toBe('past_due');   // flagged, not suspended
  });
});

describe('the manual transfer provider', () => {
  it('is a real provider that simply has no URL to send anyone to', async () => {
    const provider = new ManualTransferProvider('BCA 1234567890 a.n. PT Toko Demo');
    const handle = await provider.createPayment({
      reference: 'KIR/2026/000001', amountIdr: 4_329_000, description: 'Growth — March',
    });
    expect(handle).toMatchObject({ provider: 'manual_transfer', url: null });
    expect(handle.instructions).toContain('BCA');
    expect(provider.parseCallback()).toBeNull();
  });
});

describe('the invoices API', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let token = '';

  beforeEach(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'invapi');
    app = buildApp({ db, control: db, kek: TEST_KEK, env: env(), dispatch: async () => {} });
    await app.ready();
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'invapi', email: 'owner@invapi.test', password: 'correct horse battery staple' },
    });
    token = login.json().accessToken;

    await withTenant(db, t.tenantId, async (tx) => {
      const p = await tx.query<{ id: string }>(
        `insert into billing_periods (tenant_id, starts_at, ends_at, plan_code)
         values ($1, now() - interval '30 days', now(), 'growth') returning id`, [t.tenantId]);
      await issueInvoiceForPeriod(tx, t.tenantId, { billingPeriodId: p[0]!.id, lines: [line()] });
    });
  });
  afterEach(async () => { await app.close(); await db.close(); });

  it('lists invoices with what is still owed', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/invoices', headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().invoices).toHaveLength(1);
    expect(res.json().outstandingIdr).toBe(Math.round(3_900_000 * 1.11));
  });

  it('keeps invoices away from anyone but the owner', async () => {
    await app.inject({
      method: 'POST', url: '/v1/members', headers: { authorization: `Bearer ${token}` },
      payload: { email: 'admin@invapi.test', name: 'Admin', password: 'another long password', role: 'admin' },
    });
    const admin = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'invapi', email: 'admin@invapi.test', password: 'another long password' },
    });
    const res = await app.inject({
      method: 'GET', url: '/v1/invoices',
      headers: { authorization: `Bearer ${admin.json().accessToken}` },
    });
    // billing:manage is the owner's alone.
    expect(res.statusCode).toBe(403);
  });

  it('requires a bank reference before marking anything paid', async () => {
    const list = await app.inject({
      method: 'GET', url: '/v1/invoices', headers: { authorization: `Bearer ${token}` },
    });
    const id = list.json().invoices[0].id;

    const noRef = await app.inject({
      method: 'POST', url: `/v1/invoices/${id}/paid`,
      headers: { authorization: `Bearer ${token}` }, payload: {},
    });
    expect(noRef.statusCode).toBe(422);

    const paid = await app.inject({
      method: 'POST', url: `/v1/invoices/${id}/paid`,
      headers: { authorization: `Bearer ${token}` }, payload: { reference: 'BCA/8891' },
    });
    expect(paid.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET', url: '/v1/invoices', headers: { authorization: `Bearer ${token}` },
    });
    expect(after.json().invoices[0].status).toBe('paid');
    expect(after.json().outstandingIdr).toBe(0);
  });
});
