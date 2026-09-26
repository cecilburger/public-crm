import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  migrate, withTenant, provisionTenant, getFbBridgeConnection, listDivisions, type Database,
} from '@kirana/db';
import { freshDb, TEST_KEK } from './helpers/db.ts';

/**
 * Migration 0059 against a database that already holds a working tenant.
 *
 * The product rule is that everything that existed before divisions is
 * Marketing, and AI starts empty — so this builds a tenant the way the schema
 * looked at 0058, with a row in every table that becomes division-scoped, then
 * migrates forward and checks where each row landed.
 */

const SCOPED = [
  'channels', 'contacts', 'conversations', 'messages',
  'brands', 'deals', 'tasks', 'orders', 'broadcasts',
  'facebook_comments', 'ig_comments',
  'fb_bridge_connections', 'ig_bridge_connections', 'ig_meta_connections',
  'google_calendar_connections',
] as const;

/** No division column of their own; guarded through their parent (0060). */
const DERIVED = [
  'message_drafts', 'message_outbox', 'timeline_events', 'order_items', 'payment_links',
  'broadcast_recipients', 'bd_conversation_state', 'wa_bridge_sessions',
] as const;

/** The trained-cb chatbot's tables (0061): settings keyed by division, runs following their conversation. */
const CHATBOT = ['chatbot_settings', 'chatbot_runs'] as const;

/** What each legacy tenant was seeded with for 0061's backfills. */
interface LegacyChatbot {
  channels: Record<'whatsapp' | 'whatsapp_web' | 'instagram_bridge' | 'messenger_bridge', string>;
  conversations: Record<
    'plain' | 'handover' | 'meetingDone' | 'optOut' | 'stoppedSilent' | 'stoppedOther' | 'qna', string>;
}

const BEFORE_DIVISIONS = '0058_tasks_meeting_booking_key';

describe('migrating an existing workspace into divisions', () => {
  let db: Database;
  let tenantId: string;
  let otherTenantId: string;
  /** Row counts per scoped table before 0059 ran — nothing may be lost or added. */
  const before: Record<string, number> = {};
  const legacy: Record<string, LegacyChatbot> = {};
  /** Every message's sender before 0061 widened the check — history must not be relabelled. */
  let sendersBefore: { id: string; sender_type: string }[] = [];

  const countRows = async (table: string) =>
    (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0]!.n;

  const id = async (sql: string, params: unknown[]) =>
    (await db.query<{ id: string }>(sql, params))[0]!.id;

  /** A tenant as it looked before 0059 — every scoped table has a row. */
  const seedLegacyTenant = async (slug: string) => {
    const t = await id(`insert into tenants (slug, name) values ($1, $2) returning id`, [slug, `Tenant ${slug}`]);
    const user = await id(
      `insert into users (tenant_id, email, name, role) values ($1, $2, 'Owner', 'owner') returning id`,
      [t, `owner@${slug}.test`]);

    const wa = await id(
      `insert into channels (tenant_id, kind, display_name, external_id) values ($1, 'whatsapp', 'WA', $2) returning id`,
      [t, `wa-${slug}`]);
    const messenger = await id(
      `insert into channels (tenant_id, kind, display_name, external_id) values ($1, 'messenger_bridge', 'Page', $2) returning id`,
      [t, `page-${slug}`]);
    const igBridge = await id(
      `insert into channels (tenant_id, kind, display_name) values ($1, 'instagram_bridge', 'IG') returning id`, [t]);
    const waWeb = await id(
      `insert into channels (tenant_id, kind, display_name) values ($1, 'whatsapp_web', 'WA Web') returning id`, [t]);
    await db.query(`insert into wa_bridge_sessions (channel_id, tenant_id) values ($1, $2)`, [waWeb, t]);

    const contact = await id(
      `insert into contacts (tenant_id, display_name, phone_bidx, fb_user_id_bidx)
       values ($1, 'Gabe', $2, $3) returning id`, [t, `phone-${slug}`, `fb-${slug}`]);
    const conversation = await id(
      `insert into conversations (tenant_id, contact_id, channel_id) values ($1, $2, $3) returning id`,
      [t, contact, wa]);
    await db.query(
      `insert into messages (tenant_id, conversation_id, channel_id, direction, sender_type)
       values ($1, $2, $3, 'inbound', 'contact')`, [t, conversation, wa]);

    // trained-cb's state as it stood before 0061, one conversation per case the
    // handling backfill distinguishes. Resolved threads let one contact hold
    // several on the same channel. The old worker stored each bot reply under
    // its template key; the engine itself never wrote an opt-out reason.
    const botThread = async (
      channel: string, status: string, node: string | null, stoppedReason = '', replyKey: string | null = 'REPLY',
    ) => {
      const c = await id(
        `insert into conversations (tenant_id, contact_id, channel_id, status) values ($1, $2, $3, $4) returning id`,
        [t, contact, channel, status]);
      await db.query(
        `insert into messages (tenant_id, conversation_id, channel_id, direction, sender_type, template_name)
         values ($1, $2, $3, 'inbound', 'contact', null), ($1, $2, $3, 'outbound', 'autopilot', $4)`,
        [t, c, channel, replyKey]);
      if (node) {
        await db.query(
          `insert into bd_conversation_state (tenant_id, conversation_id, node, stopped_reason) values ($1, $2, $3, $4)`,
          [t, c, node, stoppedReason]);
      }
      return c;
    };
    legacy[slug] = {
      channels: { whatsapp: wa, whatsapp_web: waWeb, instagram_bridge: igBridge, messenger_bridge: messenger },
      conversations: {
        plain: conversation,
        handover: await botThread(waWeb, 'open', 'handover'),
        optOut: await botThread(igBridge, 'open', 'stopped', '', 'REPLY_OPT_OUT'),
        stoppedSilent: await botThread(waWeb, 'resolved', 'stopped'),
        meetingDone: await botThread(messenger, 'open', 'meeting_done'),
        stoppedOther: await botThread(waWeb, 'resolved', 'stopped', 'rejection'),
        qna: await botThread(waWeb, 'resolved', 'qna'),
      },
    };

    const pipeline = await id(
      `insert into pipelines (tenant_id, name, is_default) values ($1, 'Penjualan', true) returning id`, [t]);
    const stage = await id(
      `insert into pipeline_stages (tenant_id, pipeline_id, name, position) values ($1, $2, 'Baru', 1) returning id`,
      [t, pipeline]);
    const brand = await id(
      `insert into brands (tenant_id, name, contact_id) values ($1, 'Client ABC', $2) returning id`, [t, contact]);
    const deal = await id(
      `insert into deals (tenant_id, contact_id, pipeline_id, stage_id, title, brand_id, source_conversation_id)
       values ($1, $2, $3, $4, 'Paket reseller', $5, $6) returning id`,
      [t, contact, pipeline, stage, brand, conversation]);
    await db.query(
      `insert into tasks (tenant_id, contact_id, brand_id, deal_id, conversation_id, title, due_at)
       values ($1, $2, $3, $4, $5, 'Meeting', now())`, [t, contact, brand, deal, conversation]);
    await db.query(
      `insert into orders (tenant_id, contact_id, conversation_id, deal_id, code)
       values ($1, $2, $3, $4, $5)`, [t, contact, conversation, deal, `INV-${slug}`]);
    const template = await id(
      `insert into message_templates (tenant_id, name, category, body)
       values ($1, 'Promo', 'marketing', 'Halo') returning id`, [t]);
    await db.query(
      `insert into broadcasts (tenant_id, name, template_id, channel_id) values ($1, 'Blast', $2, $3)`,
      [t, template, waWeb]);

    await db.query(
      `insert into facebook_comments (tenant_id, page_id, post_id, comment_id) values ($1, $2, 'post-1', 'c-1')`,
      [t, `page-${slug}`]);
    await db.query(
      `insert into ig_comments (tenant_id, post_ref, comment_ref, commenter_enc, text_enc, contact_id, conversation_id)
       values ($1, 'p-1', 'c-1', 'x', 'y', $2, $3)`, [t, contact, conversation]);

    await db.query(
      `insert into fb_bridge_connections (tenant_id, page_id, page_name, status) values ($1, $2, 'Page', 'ready')`,
      [t, `page-${slug}`]);
    await db.query(`insert into ig_bridge_connections (tenant_id, status) values ($1, 'ready')`, [t]);
    await db.query(`insert into ig_meta_connections (tenant_id, status) values ($1, 'connected')`, [t]);
    await db.query(
      `insert into google_calendar_connections
         (tenant_id, user_id, access_token_enc, refresh_token_enc, token_expires_at)
       values ($1, $2, 'a', 'r', now())`, [t, user]);

    return t;
  };

  beforeAll(async () => {
    db = await freshDb({ upTo: BEFORE_DIVISIONS });
    tenantId = await seedLegacyTenant('lama');
    otherTenantId = await seedLegacyTenant('lain');
    for (const table of SCOPED) before[table] = await countRows(table);
    sendersBefore = await db.query<{ id: string; sender_type: string }>('select id, sender_type from messages order by id');

    const result = await migrate(db);
    expect(result.applied).toBeGreaterThanOrEqual(1);
  });

  afterAll(async () => { await db.close(); });

  const divisionIds = async (t: string) =>
    Object.fromEntries((await db.query<{ key: string; id: string }>(
      'select key, id from divisions where tenant_id = $1', [t])).map((r) => [r.key, r.id]));

  it('gives every existing tenant exactly one Marketing and one AI division', async () => {
    for (const t of [tenantId, otherTenantId]) {
      const rows = await db.query<{ key: string; name: string }>(
        'select key, name from divisions where tenant_id = $1 order by key', [t]);
      expect(rows).toEqual([{ key: 'ai', name: 'AI' }, { key: 'marketing', name: 'Marketing' }]);
    }
  });

  it('files every existing row under its own tenant\'s Marketing division', async () => {
    for (const table of SCOPED) {
      const [counts] = await db.query<{ total: number; marketing: number }>(
        `select count(*)::int as total,
                count(*) filter (where d.key = 'marketing' and d.tenant_id = x.tenant_id)::int as marketing
           from ${table} x join divisions d on d.id = x.division_id`);
      expect(counts!.total, `${table} lost rows`).toBe(before[table]);
      expect(counts!.total, `${table} was not seeded`).toBeGreaterThan(0);
      expect(counts!.marketing, `${table} has rows outside Marketing`).toBe(before[table]);
    }
  });

  it('leaves AI completely empty', async () => {
    for (const table of SCOPED) {
      const [row] = await db.query<{ n: number }>(
        `select count(*)::int as n from ${table} x join divisions d on d.id = x.division_id where d.key = 'ai'`);
      expect(row!.n, `${table} has AI rows`).toBe(0);
    }
  });

  it('keeps the existing bridge sessions addressable by the tenant id', async () => {
    for (const table of ['fb_bridge_connections', 'ig_bridge_connections']) {
      const rows = await db.query<{ tenant_id: string; session_key: string }>(
        `select tenant_id, session_key from ${table}`);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.session_key).toBe(row.tenant_id);
    }

    const fb = await withTenant(db, tenantId, (tx) => getFbBridgeConnection({ tx, tenantId, kek: TEST_KEK }));
    expect(fb.status).toBe('ready');
    expect(fb.sessionKey).toBe(tenantId);
  });

  it('makes the division mandatory, with Marketing as the default', async () => {
    for (const table of SCOPED) {
      const [col] = await db.query<{ is_nullable: string; column_default: string | null }>(
        `select is_nullable, column_default from information_schema.columns
          where table_name = $1 and column_name = 'division_id'`, [table]);
      expect(col?.is_nullable, table).toBe('NO');
      expect(col?.column_default ?? '', table).toContain('app_default_division');
    }
  });

  it('guards every division-scoped table, and every table hanging off one, with a restrictive policy', async () => {
    const rows = await db.query<{ tablename: string; permissive: string }>(
      `select tablename, permissive from pg_policies where policyname = 'division_isolation' order by tablename`);
    expect(rows.map((r) => r.tablename).sort()).toEqual([...SCOPED, ...DERIVED, ...CHATBOT].sort());
    for (const row of rows) expect(row.permissive, row.tablename).toBe('RESTRICTIVE');
  });

  it('reads the same data through a tenant session as before, and nothing through AI', async () => {
    const { marketing, ai } = await divisionIds(tenantId);
    const count = (divisionId?: string) => withTenant(db, tenantId, async (tx) =>
      (await tx.query<{ n: number }>('select count(*)::int as n from contacts'))[0]!.n, { divisionId });

    expect(await count()).toBe(1);
    expect(await count(marketing)).toBe(1);
    expect(await count(ai)).toBe(0);
  });

  it('keeps one calendar connection per user per division', async () => {
    const pk = await db.query<{ column_name: string }>(
      `select a.attname as column_name
         from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'google_calendar_connections'::regclass and i.indisprimary`);
    expect(pk.map((r) => r.column_name).sort()).toEqual(['division_id', 'tenant_id', 'user_id']);
  });

  /* ------------------------------------------------------------------ 0061 */

  it('switches the chatbot on for Marketing and off for AI in every existing tenant', async () => {
    for (const t of [tenantId, otherTenantId]) {
      const rows = await db.query<{ key: string; enabled: boolean; updated_by: string | null }>(
        `select d.key, s.enabled, s.updated_by from chatbot_settings s join divisions d on d.id = s.division_id
          where s.tenant_id = $1 order by d.key`, [t]);
      expect(rows).toEqual([
        { key: 'ai', enabled: false, updated_by: null },
        { key: 'marketing', enabled: true, updated_by: null },
      ]);
    }
  });

  it('keeps the bot on exactly the accounts trained-cb already answered on', async () => {
    for (const slug of ['lama', 'lain']) {
      const { channels } = legacy[slug]!;
      const rows = await db.query<{ id: string; chatbot_enabled: boolean }>(
        'select id, chatbot_enabled from channels where id = any($1::uuid[])', [Object.values(channels)]);
      const enabled = Object.fromEntries(rows.map((r) => [r.id, r.chatbot_enabled]));
      expect(enabled).toEqual({
        [channels.whatsapp]: false,
        [channels.whatsapp_web]: true,
        [channels.instagram_bridge]: true,
        [channels.messenger_bridge]: false,
      });
    }
  });

  it('takes each conversation\'s handling from where the engine left it', async () => {
    for (const slug of ['lama', 'lain']) {
      const { conversations } = legacy[slug]!;
      const rows = await db.query<{ id: string; handling: string }>(
        'select id, handling from conversations where id = any($1::uuid[])', [Object.values(conversations)]);
      const handling = Object.fromEntries(rows.map((r) => [r.id, r.handling]));
      expect(handling).toEqual({
        [conversations.plain]: 'bot',
        [conversations.handover]: 'needs_human',
        [conversations.meetingDone]: 'needs_human',
        [conversations.optOut]: 'human',
        [conversations.stoppedSilent]: 'bot',
        [conversations.stoppedOther]: 'bot',
        [conversations.qna]: 'bot',
      });

      // The opt-out is written where the chatbot looks for it from now on.
      const reasons = await db.query<{ conversation_id: string; stopped_reason: string }>(
        `select conversation_id, stopped_reason from bd_conversation_state where conversation_id = any($1::uuid[])`,
        [[conversations.optOut, conversations.stoppedSilent, conversations.stoppedOther]]);
      expect(Object.fromEntries(reasons.map((r) => [r.conversation_id, r.stopped_reason]))).toEqual({
        [conversations.optOut]: 'opt_out',
        [conversations.stoppedSilent]: '',
        [conversations.stoppedOther]: 'rejection',
      });
    }
  });

  it('accepts bot as a sender for new messages and relabels none of the old ones', async () => {
    const after = await db.query<{ id: string; sender_type: string }>('select id, sender_type from messages order by id');
    expect(after).toEqual(sendersBefore);
    expect(after.some((m) => m.sender_type === 'autopilot')).toBe(true);

    const { channels, conversations } = legacy.lain!;
    const [bot] = await db.query<{ id: string }>(
      `insert into messages (tenant_id, conversation_id, channel_id, direction, sender_type, status)
       values ($1, $2, $3, 'outbound', 'bot', 'queued') returning id`,
      [otherTenantId, conversations.handover, channels.whatsapp_web]);
    expect(bot!.id).toBeTruthy();
    await db.query('delete from messages where id = $1', [bot!.id]);
    await expect(db.query(
      `insert into messages (tenant_id, conversation_id, channel_id, direction, sender_type)
       values ($1, $2, $3, 'outbound', 'robot')`, [otherTenantId, conversations.handover, channels.whatsapp_web]),
    ).rejects.toThrow(/messages_sender_type_check/);
    const [check] = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint
        where conrelid = 'messages'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%sender_type%'`);
    expect(check!.n).toBe(1);
  });

  it('is safe to run a second time', async () => {
    // Switches someone flipped after the first run must survive a second one.
    const { channels, conversations } = legacy.lama!;
    const { marketing } = await divisionIds(tenantId);
    await db.query('update channels set chatbot_enabled = false where id = $1', [channels.whatsapp_web]);
    await db.query('update chatbot_settings set enabled = false where division_id = $1', [marketing]);
    await db.query(`update conversations set handling = 'bot' where id = $1`, [conversations.handover]);

    for (const file of ['0059_divisions.sql', '0060_division_derived_tables.sql', '0061_trained_cb_chatbot.sql']) {
      await db.exec(await readFile(join(import.meta.dirname, '..', 'packages/db/migrations', file), 'utf8'));
    }

    const [divisions] = await db.query<{ n: number }>('select count(*)::int as n from divisions');
    expect(divisions!.n).toBe(4);
    for (const table of SCOPED) expect(await countRows(table), table).toBe(before[table]);
    const [settings] = await db.query<{ n: number }>('select count(*)::int as n from chatbot_settings');
    expect(settings!.n).toBe(4);

    const [channel] = await db.query<{ chatbot_enabled: boolean }>(
      'select chatbot_enabled from channels where id = $1', [channels.whatsapp_web]);
    expect(channel!.chatbot_enabled).toBe(false);
    const [setting] = await db.query<{ enabled: boolean }>(
      'select enabled from chatbot_settings where division_id = $1', [marketing]);
    expect(setting!.enabled).toBe(false);
    const [conversation] = await db.query<{ handling: string }>(
      'select handling from conversations where id = $1', [conversations.handover]);
    expect(conversation!.handling).toBe('bot');

    expect((await migrate(db)).applied).toBe(0);
  });

  it('creates both divisions for a tenant provisioned afterwards', async () => {
    const { tenantId: fresh, divisions } = await provisionTenant(db, TEST_KEK, {
      slug: 'baru', name: 'Tenant Baru', ownerEmail: 'owner@baru.test', ownerName: 'Owner',
      ownerPassword: 'correct horse battery staple',
    });
    const listed = await withTenant(db, fresh, (tx) => listDivisions(tx, fresh));
    expect(listed.map((d) => d.key)).toEqual(['marketing', 'ai']);
    expect(divisions.marketing).toBe(listed[0]!.id);
    expect(divisions.ai).toBe(listed[1]!.id);
  });
});
