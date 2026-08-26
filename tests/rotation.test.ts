import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  withTenant, ingestInboundMessage, upsertContactByPhone, tenantKeys, openField,
  beginDekRotation, rotateBatch, finishDekRotation, rotateTenantDek, rewrapUnderNewKek,
  ENCRYPTED_COLUMNS, type Database,
} from '@kirana/db';
import { loadKek } from '@kirana/core';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

describe('rotating a tenant data key', () => {
  let db: Database;
  let t: TestTenant;

  const seed = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      await withTenant(db, t.tenantId, (tx) =>
        ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          channelId: t.channelId, from: `0812345${String(i).padStart(4, '0')}`,
          body: `pesan nomor ${i}`, providerMessageId: `wamid.rot.${i}`, displayName: `Pelanggan ${i}`,
        }));
    }
  };

  const readAll = () => withTenant(db, t.tenantId, async (tx) => {
    const keys = await tenantKeys(tx, TEST_KEK, t.tenantId);
    const rows = await tx.query<{ body_enc: string }>(
      'select body_enc from messages where body_enc is not null order by created_at');
    return rows.map((r) => openField(keys, t.tenantId, r.body_enc));
  });

  const ciphertexts = () => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ id: string; body_enc: string }>(
      'select id, body_enc from messages where body_enc is not null order by id'));

  beforeEach(async () => { db = await freshDb(); t = await makeTenant(db, 'rot'); });
  afterEach(async () => { await db.close(); });

  it('leaves every message readable, and changes every ciphertext', async () => {
    await seed(5);
    const before = await readAll();
    const beforeCt = await ciphertexts();

    const result = await rotateTenantDek(db, TEST_KEK, t.tenantId, { batchSize: 2 });
    expect(result.started).toBe(true);
    expect(result.finished).toBe(true);

    expect(await readAll()).toEqual(before);
    const afterCt = await ciphertexts();
    for (const row of afterCt) {
      const old = beforeCt.find((b) => b.id === row.id)!;
      expect(row.body_enc).not.toBe(old.body_enc);
    }
  });

  it('keeps everything readable *during* the rotation, not just after', async () => {
    await seed(6);
    const before = await readAll();

    expect(await beginDekRotation(db, TEST_KEK, t.tenantId)).toBe(true);
    // Nothing re-encrypted yet: every row is still under the previous key.
    expect(await readAll()).toEqual(before);

    await rotateBatch(db, TEST_KEK, t.tenantId, 2);
    // Now it is a mixture, which is the case that actually has to work.
    expect(await readAll()).toEqual(before);
  });

  it('resumes from where it stopped instead of starting over', async () => {
    await seed(7);
    await beginDekRotation(db, TEST_KEK, t.tenantId);

    const first = await rotateBatch(db, TEST_KEK, t.tenantId, 3);
    const contacts = first.find((p) => p.table === 'contacts')!;
    expect(contacts.rowsDone).toBe(3);
    expect(contacts.completed).toBe(false);

    const second = await rotateBatch(db, TEST_KEK, t.tenantId, 3);
    expect(second.find((p) => p.table === 'contacts')!.rowsDone).toBe(6);
  });

  it('refuses to drop the old key until every table is done', async () => {
    await seed(4);
    await beginDekRotation(db, TEST_KEK, t.tenantId);
    await rotateBatch(db, TEST_KEK, t.tenantId, 1);

    expect(await finishDekRotation(db, t.tenantId)).toBe(false);
    const keys = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ previous_wrapped_dek: string | null }>('select previous_wrapped_dek from tenant_keys'));
    expect(keys[0]!.previous_wrapped_dek).not.toBeNull();
  });

  it('will not start a second rotation on top of an unfinished one', async () => {
    await seed(2);
    expect(await beginDekRotation(db, TEST_KEK, t.tenantId)).toBe(true);
    // Starting again would make the key two generations back unreachable.
    expect(await beginDekRotation(db, TEST_KEK, t.tenantId)).toBe(false);
  });

  it('bumps the key version and clears the old key when it finishes', async () => {
    await seed(3);
    await rotateTenantDek(db, TEST_KEK, t.tenantId, { batchSize: 10 });

    const keys = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ key_version: number; previous_wrapped_dek: string | null; rotated_at: Date | null }>(
        'select key_version, previous_wrapped_dek, rotated_at from tenant_keys'));
    expect(keys[0]!.key_version).toBe(2);
    expect(keys[0]!.previous_wrapped_dek).toBeNull();
    expect(keys[0]!.rotated_at).not.toBeNull();
  });

  it('does not break contact lookup, because the index key is left alone', async () => {
    // The failure this guards against: rotating the blind-index key mid-flight
    // would leave half the contacts unfindable and create duplicate customers.
    await seed(3);
    await rotateTenantDek(db, TEST_KEK, t.tenantId, { batchSize: 1 });

    const again = await withTenant(db, t.tenantId, (tx) =>
      upsertContactByPhone({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { phone: '08123450000' }));
    expect(again.created).toBe(false);   // found the existing customer, did not duplicate

    const count = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>('select count(*)::int as n from contacts'));
    expect(count[0]!.n).toBe(3);
  });

  it('writes both the start and the finish into the audit trail', async () => {
    await seed(2);
    await rotateTenantDek(db, TEST_KEK, t.tenantId, { batchSize: 10 });

    const actions = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ action: string }>(`select action from audit_events where action like 'keys.%'`));
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['keys.rotation_started', 'keys.rotation_completed']));
  });
});

describe('the list of encrypted columns', () => {
  it('matches what the schema actually has, so nothing is left behind', async () => {
    const db = await freshDb();
    try {
      const columns = await db.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
          where table_schema = 'public' and column_name like '%\\_enc'
          order by table_name, column_name`,
      );

      const registered = new Set(
        ENCRYPTED_COLUMNS.flatMap((t) => t.columns.map((c) => `${t.table}.${c}`)));
      const actual = columns.map((c) => `${c.table_name}.${c.column_name}`);

      // A new encrypted column that nobody registered would survive a rotation
      // readable only by the key we are about to destroy.
      for (const column of actual) expect(registered).toContain(column);
      expect(actual.length).toBe(registered.size);
    } finally {
      await db.close();
    }
  });
});

describe('rotating the key-encrypting key', () => {
  it('re-wraps every tenant without touching a single ciphertext', async () => {
    const db = await freshDb();
    try {
      const a = await makeTenant(db, 'kek-a');
      const b = await makeTenant(db, 'kek-b');
      for (const t of [a, b]) {
        await withTenant(db, t.tenantId, (tx) =>
          ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
            channelId: t.channelId, from: '08123456789', body: `halo dari ${t.slug}`,
            providerMessageId: `wamid.${t.slug}`, displayName: 'Bu Sari',
          }));
      }

      const before = await withTenant(db, a.tenantId, (tx) =>
        tx.query<{ body_enc: string }>('select body_enc from messages where body_enc is not null'));

      const newKekB64 = Buffer.alloc(32, 9).toString('base64');
      const result = await rewrapUnderNewKek(db, db,
        Buffer.alloc(32, 3).toString('base64'), newKekB64);
      expect(result.rewrapped).toBe(2);

      // Ciphertexts untouched — that is the point of envelope encryption.
      const after = await withTenant(db, a.tenantId, (tx) =>
        tx.query<{ body_enc: string }>('select body_enc from messages where body_enc is not null'));
      expect(after[0]!.body_enc).toBe(before[0]!.body_enc);

      // And they open under the new KEK.
      const newKek = loadKek(newKekB64);
      const readable = await withTenant(db, a.tenantId, async (tx) => {
        const keys = await tenantKeys(tx, newKek, a.tenantId);
        return openField(keys, a.tenantId, after[0]!.body_enc);
      });
      expect(readable).toBe('halo dari kek-a');
    } finally {
      await db.close();
    }
  });
});
