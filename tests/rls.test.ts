import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, withoutTenant, ingestInboundMessage, type Database } from '@kirana/db';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * These are the tests that matter most. Everything else in the product is a
 * feature; cross-tenant leakage is the company.
 */
describe('tenant isolation is enforced by the database', () => {
  let db: Database;
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    db = await freshDb();
    a = await makeTenant(db, 'alpha');
    b = await makeTenant(db, 'bravo');

    for (const [t, phone, body] of [[a, '08111111111', 'pesanan alpha'], [b, '08222222222', 'pesanan bravo']] as const) {
      await withTenant(db, t.tenantId, (tx) =>
        ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          channelId: t.channelId, from: phone, body, providerMessageId: `wamid.${t.slug}.1`,
        }));
    }
  });

  afterAll(async () => { await db.close(); });

  it('shows a tenant only its own contacts, conversations and messages', async () => {
    const seen = await withTenant(db, a.tenantId, async (tx) => ({
      contacts: await tx.query('select id from contacts'),
      conversations: await tx.query('select id from conversations'),
      messages: await tx.query('select id from messages'),
    }));
    expect(seen.contacts).toHaveLength(1);
    expect(seen.conversations).toHaveLength(1);
    expect(seen.messages).toHaveLength(1);
  });

  it('returns nothing for another tenant even when its row id is known', async () => {
    const bContactId = await withTenant(db, b.tenantId, async (tx) => {
      const rows = await tx.query<{ id: string }>('select id from contacts limit 1');
      return rows[0]!.id;
    });

    const stolen = await withTenant(db, a.tenantId, (tx) =>
      tx.query('select id from contacts where id = $1', [bContactId]));

    expect(stolen).toHaveLength(0);
  });

  it('refuses a write that would plant a row in another tenant', async () => {
    await expect(
      withTenant(db, a.tenantId, (tx) =>
        tx.query(
          `insert into contacts (tenant_id, display_name, phone_bidx) values ($1, 'smuggled', 'x')`,
          [b.tenantId],
        )),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses an update that would move a row into another tenant', async () => {
    await expect(
      withTenant(db, a.tenantId, (tx) =>
        tx.query('update contacts set tenant_id = $1', [b.tenantId])),
    ).rejects.toThrow(/row-level security/i);
  });

  it('sees nothing at all when the tenant context is missing', async () => {
    const rows = await withoutTenant(db, 'test: unset context must fail closed', async (tx) => {
      await tx.exec('set local role kirana_app');
      return tx.query('select id from contacts');
    });
    expect(rows).toHaveLength(0);
  });

  it('keeps the raw webhook spool out of reach of a tenant session', async () => {
    await expect(
      withTenant(db, a.tenantId, (tx) => tx.query('select * from webhook_events')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does not let the application rewrite its own audit trail', async () => {
    await expect(
      withTenant(db, a.tenantId, (tx) => tx.query(`update audit_events set action = 'nothing.happened'`)),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenant(db, a.tenantId, (tx) => tx.query('delete from audit_events')),
    ).rejects.toThrow(/permission denied/i);
  });
});
