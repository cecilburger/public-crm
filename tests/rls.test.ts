import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  withTenant, withoutTenant, ingestInboundMessage, queueOutboundMessage, addChannel, type Database,
} from '@kirana/db';
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

/**
 * Marketing and AI inside one tenant. The same guarantees as above, one level
 * down: a division set on the session narrows every read and write to it, and
 * the schema refuses rows that would point across the line.
 */
describe('division isolation is enforced by the database', () => {
  let db: Database;
  let t: TestTenant;
  let aiChannelId: string;
  const PHONE = '08133333333';

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'divrls');
    aiChannelId = (await addChannel(db, t.tenantId, {
      kind: 'whatsapp', displayName: 'AI WA', externalId: 'wa-divrls-ai', phoneE164: '+628110000002',
    }, { divisionId: t.divisions.ai })).id;

    // One person writing to both numbers.
    await withTenant(db, t.tenantId, (tx) =>
      ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: t.channelId, from: PHONE, body: 'halo marketing', providerMessageId: 'wamid.divrls.m',
      }), { divisionId: t.divisions.marketing });
    await withTenant(db, t.tenantId, (tx) =>
      ingestInboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: aiChannelId, from: PHONE, body: 'halo ai', providerMessageId: 'wamid.divrls.a',
      }), { divisionId: t.divisions.ai });
  });

  afterAll(async () => { await db.close(); });

  const seen = (divisionId?: string) => withTenant(db, t.tenantId, async (tx) => ({
    channels: (await tx.query('select id from channels')).length,
    contacts: (await tx.query('select id from contacts')).length,
    conversations: (await tx.query('select id from conversations')).length,
    messages: (await tx.query('select id from messages')).length,
  }), { divisionId });

  const idIn = (divisionId: string, table: string) => withTenant(db, t.tenantId, async (tx) =>
    (await tx.query<{ id: string }>(`select id from ${table} limit 1`))[0]!.id, { divisionId });

  it('keeps the same phone number as one contact per division', async () => {
    const one = { channels: 1, contacts: 1, conversations: 1, messages: 1 };
    expect(await seen(t.divisions.marketing)).toEqual(one);
    expect(await seen(t.divisions.ai)).toEqual(one);
    // Tenant-wide work (billing, retention, rotation) still sees both.
    expect(await seen()).toEqual({ channels: 2, contacts: 2, conversations: 2, messages: 2 });
  });

  it('returns nothing from the other division even when its row id is known', async () => {
    for (const table of ['contacts', 'conversations', 'messages', 'channels']) {
      const aiRow = await idIn(t.divisions.ai, table);
      const stolen = await withTenant(db, t.tenantId, (tx) =>
        tx.query(`select id from ${table} where id = $1`, [aiRow]), { divisionId: t.divisions.marketing });
      expect(stolen, table).toHaveLength(0);
    }
  });

  it('refuses a write that would plant a row in the other division', async () => {
    await expect(
      withTenant(db, t.tenantId, (tx) =>
        tx.query(
          `insert into contacts (tenant_id, division_id, display_name) values ($1, $2, 'smuggled')`,
          [t.tenantId, t.divisions.ai],
        ), { divisionId: t.divisions.marketing }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses an update that would move a row into the other division', async () => {
    await expect(
      withTenant(db, t.tenantId, (tx) =>
        tx.query('update contacts set division_id = $1', [t.divisions.ai]), { divisionId: t.divisions.marketing }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('will not let a conversation join a contact and a channel from different divisions', async () => {
    const marketingContact = await idIn(t.divisions.marketing, 'contacts');
    // No division on the session at all — the schema alone has to refuse it.
    await expect(
      withTenant(db, t.tenantId, (tx) =>
        tx.query(
          `insert into conversations (tenant_id, contact_id, channel_id) values ($1, $2, $3)`,
          [t.tenantId, marketingContact, aiChannelId],
        )),
    ).rejects.toThrow(/foreign key/i);
  });

  it('files a reply under its conversation\'s division even when the writer never chose one', async () => {
    const aiConversation = await idIn(t.divisions.ai, 'conversations');
    // Tenant only, the way the Autopilot and BD processors run.
    const { messageId } = await withTenant(db, t.tenantId, (tx) =>
      queueOutboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        conversationId: aiConversation, body: 'Baik kak, kami bantu', senderType: 'autopilot',
      }));

    const [row] = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ division_id: string }>('select division_id from messages where id = $1', [messageId]));
    expect(row!.division_id).toBe(t.divisions.ai);
  });
});
