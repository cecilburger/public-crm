import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { withTenant, withoutTenant, ingestInboundMessage, type Database } from '@kirana/db';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

/**
 * Whether the tenancy model survives a connection pooler.
 *
 * ADR-0001 names this as a consequence — "every connection must set context, so
 * pooling in transaction mode needs care" — and nothing ever checked it. Under
 * transaction pooling a different server connection serves each transaction, so
 * anything set at *session* level would be handed to whoever gets that
 * connection next. That is a cross-tenant leak with no bug in any query.
 *
 * PGlite is a single connection reused for every transaction, which makes it an
 * unusually good place to test this: if context survived a COMMIT, the next
 * transaction would see it.
 */
describe('tenant context does not outlive its transaction', () => {
  let db: Database;
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    db = await freshDb();
    a = await makeTenant(db, 'pool-a');
    b = await makeTenant(db, 'pool-b');
    for (const [t, phone] of [[a, '08111111111'], [b, '08222222222']] as const) {
      await withTenant(db, t.tenantId, (tx) =>
        ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          channelId: t.channelId, from: phone, body: `halo dari ${t.slug}`,
          providerMessageId: `wamid.${t.slug}`,
        }));
    }
  });
  afterAll(async () => { await db.close(); });

  it('leaves no tenant setting behind after the transaction commits', async () => {
    await withTenant(db, a.tenantId, (tx) => tx.query('select 1'));

    const after = await withoutTenant(db, 'test: reading the setting after a commit', (tx) =>
      tx.query<{ value: string | null }>(
        `select nullif(current_setting('app.tenant_id', true), '') as value`));

    expect(after[0]!.value).toBeNull();
  });

  it('does not hand one tenant a connection still pinned to another', async () => {
    // The scenario that matters: A works, commits, and the same physical
    // connection is then used for B.
    const seenByA = await withTenant(db, a.tenantId, (tx) =>
      tx.query<{ id: string }>('select id from contacts'));
    const seenByB = await withTenant(db, b.tenantId, (tx) =>
      tx.query<{ id: string }>('select id from contacts'));

    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);
    expect(seenByA[0]!.id).not.toBe(seenByB[0]!.id);
  });

  it('returns the role to what it was, so the next transaction is not stuck as kirana_app', async () => {
    await withTenant(db, a.tenantId, (tx) => tx.query('select 1'));

    // `kirana_app` cannot read the webhook spool. If the role had persisted past
    // COMMIT, this would fail with permission denied.
    const spool = await withoutTenant(db, 'test: the spool is reachable again after a commit', (tx) =>
      tx.query('select count(*) from webhook_events'));
    expect(spool).toHaveLength(1);
  });

  it('fails closed when a transaction forgets to set context', async () => {
    const rows = await withoutTenant(db, 'test: no context at all', async (tx) => {
      await tx.exec('set local role kirana_app');
      return tx.query('select id from contacts');
    });
    expect(rows).toHaveLength(0);
  });
});

describe('the settings that make transaction pooling safe', () => {
  it('sets tenant context only with transaction-scoped mechanisms', async () => {
    const source = await readFile(new URL('../packages/db/src/tenant.ts', import.meta.url), 'utf8');

    // `set_config(name, value, true)` — the third argument is is_local — and
    // `SET LOCAL`. A bare `SET` or `set_config(…, false)` would survive COMMIT
    // and be inherited by whoever gets the connection next.
    expect(source).toContain("set_config($1, $2, true)");
    expect(source).toContain('set local role');
    expect(source).not.toMatch(/set_config\([^)]*,\s*false\s*\)/);
    expect(source).not.toMatch(/\bexec\('set (?!local)/i);
  });

  it('turns off named prepared statements when pooling in transaction mode', async () => {
    const source = await readFile(new URL('../packages/db/src/sql.ts', import.meta.url), 'utf8');
    // Named statements live on one server connection; a transaction-mode pooler
    // moves between them. This is the setting that decides whether the system
    // works under load or fails with "prepared statement does not exist".
    expect(source).toContain('prepare: !transactionPooled');
  });
});
