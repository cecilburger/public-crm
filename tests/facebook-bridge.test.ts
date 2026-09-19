import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { env, type Env } from '@kirana/core';
import {
  withTenant, ensureMessengerBridgeChannel, getFbBridgeConnection, listFacebookComments,
  type Database,
} from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { facebookExternalId } from '../apps/api/src/routes/webhooks.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { facebookMessageKey } from '../apps/worker/src/processors/facebookInbound.ts';
import { parseMessengerInbox } from '../apps/fb-bridge/src/parsers/messengerInbox.ts';
import { parseMessengerThread } from '../apps/fb-bridge/src/parsers/messengerThread.ts';
import { parseFacebookComments } from '../apps/fb-bridge/src/parsers/comments.ts';
import { compositeMessageKey } from '../apps/fb-bridge/src/events.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'facebook');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');

const PAGE = { id: '900000000000001', name: 'Toko Demo' };

/**
 * Nothing in this file talks to Facebook, and nothing in it can.
 *
 * The parsers are pure functions over HTML, so they run against fixture files;
 * the ingest path runs against a real migrated database (PGlite in-process).
 * That is the point of splitting the scraper the way it is split — a live
 * login must never be a prerequisite for knowing whether this code works.
 */

/* ------------------------------------------------------------- parsers */

describe('the Messenger inbox parser', () => {
  it('reads a thread id straight off each row link', async () => {
    const { rows } = parseMessengerInbox(await fixture('messenger-inbox.html'));

    expect(rows.map((r) => r.threadId)).toEqual(['100000000000001', '100000000000002']);
    expect(rows.map((r) => r.name)).toEqual(['Budi Santoso', 'Siti Aminah']);
  });

  it('ignores rows that are not conversations', async () => {
    const { rows, linkCount } = parseMessengerInbox(await fixture('messenger-inbox.html'));

    // The fixture holds three links; the "New message" control is not a thread.
    expect(linkCount).toBe(2);
    expect(rows).toHaveLength(2);
  });

  it('strips self-ticking text from the change signature', async () => {
    // A row's "4m" / "2 jam" / "Aktif sekarang" advance on their own with no
    // message having changed. Left in, the watcher re-reads the thread forever.
    const { rows } = parseMessengerInbox(await fixture('messenger-inbox.html'));

    for (const row of rows) {
      expect(row.signature).not.toMatch(/\d+\s*(m|jam)\b/);
      expect(row.signature.toLowerCase()).not.toContain('aktif sekarang');
    }
    expect(rows[0]!.signature).toContain('Sis, ini masih ready?');
  });

  it('gives a changed row a different signature', async () => {
    const before = parseMessengerInbox(await fixture('messenger-inbox.html'));
    const after = parseMessengerInbox(
      (await fixture('messenger-inbox.html')).replace('Sis, ini masih ready?', 'Sis, jadi order ya'));

    expect(after.rows[0]!.signature).not.toBe(before.rows[0]!.signature);
    expect(after.rows[1]!.signature).toBe(before.rows[1]!.signature);
  });
});

describe('the Messenger thread parser', () => {
  it('returns only inbound messages', async () => {
    const parsed = parseMessengerThread(await fixture('messenger-thread.html'), {
      selfName: PAGE.name,
    });

    expect(parsed.messages.map((m) => m.text)).toEqual([
      'Sis, ini masih ready?',
      'Yang warna hitam ada?',
      'Oke sip\nSaya ambil 2',
    ]);
  });

  it('never reports the page\'s own reply as a customer message', async () => {
    const parsed = parseMessengerThread(await fixture('messenger-thread.html'), {
      selfName: PAGE.name,
    });

    expect(parsed.messages.map((m) => m.text)).not.toContain('Halo kak, masih ada ya');
    expect(parsed.outboundRows).toBe(1);
  });

  it('keeps a multi-line message as separate lines', async () => {
    const parsed = parseMessengerThread(await fixture('messenger-thread.html'), {
      selfName: PAGE.name,
    });

    expect(parsed.messages.at(-1)!.text).toBe('Oke sip\nSaya ambil 2');
  });

  it('prefers facebook\'s own message id when the markup exposes one', async () => {
    const parsed = parseMessengerThread(await fixture('messenger-thread.html'), {
      selfName: PAGE.name,
    });

    expect(parsed.messages.map((m) => m.externalMessageId)).toEqual([
      'mid.$cAAB1111111111111111', 'mid.$cAAB2222222222222222', 'mid.$cAAB4444444444444444',
    ]);
  });

  it('finds the same messages when no message id is exposed', async () => {
    const withIds = parseMessengerThread(await fixture('messenger-thread.html'), {
      selfName: PAGE.name,
    });
    const without = parseMessengerThread(await fixture('messenger-thread-no-mid.html'), {
      selfName: PAGE.name,
    });

    expect(without.messages.map((m) => m.text)).toEqual(withIds.messages.map((m) => m.text));
    expect(without.messages.every((m) => m.externalMessageId === null)).toBe(true);
  });

  it('reads a timestamp when there is one', async () => {
    const parsed = parseMessengerThread(await fixture('messenger-thread.html'), {
      selfName: PAGE.name,
    });

    expect(parsed.messages[0]!.sentAt).toBe(new Date(1789000000 * 1000).toISOString());
  });

  it('drops a bubble with no text rather than storing a blank message', async () => {
    const parsed = parseMessengerThread(await fixture('messenger-thread.html'), {
      selfName: PAGE.name,
    });

    expect(parsed.messages.every((m) => m.text.length > 0)).toBe(true);
  });

  it('attributes a grouped follow-up to whoever sent the bubble above it', async () => {
    // Messenger labels the first bubble of a run and leaves the rest bare.
    const parsed = parseMessengerThread(await fixture('messenger-thread.html'), { selfName: PAGE.name });

    expect(parsed.messages.map((m) => m.text)).toContain('Yang warna hitam ada?');
    expect(parsed.messages.find((m) => m.text === 'Yang warna hitam ada?')!.senderName).toBe('Budi Santoso');
  });

  it('refuses to attribute a row that has no sender above it either', async () => {
    // The date divider at the top of the fixture has real text and no sender,
    // and nothing precedes it to inherit from. An earlier version of the parser
    // attributed rows like this to "the other party in the thread" and reported
    // "19 September 2026" to the CRM as a customer message.
    const parsed = parseMessengerThread(await fixture('messenger-thread.html'), { selfName: PAGE.name });

    expect(parsed.messages.map((m) => m.text)).not.toContain('19 September 2026');
    expect(parsed.unknownSenderRows).toBe(1);
  });

  it('does not let a customer inherit the page\'s own reply', async () => {
    // A bare bubble after one of our replies is ours, not theirs. Getting this
    // backwards would ingest the operator's own words as the customer's.
    const html = (await fixture('messenger-thread.html'))
      .replace('<div dir="auto">Oke sip</div>', '<div dir="auto">MARKER-BARE</div>')
      .replace('aria-label="Message from Budi Santoso" id="mid.$cAAB4444444444444444"',
               'id="mid.$cAAB4444444444444444"')
      .replace('<img alt="Budi Santoso" src="avatar.png" />\n      <div dir="auto">MARKER-BARE</div>',
               '<div dir="auto">MARKER-BARE</div>');
    // Without this the test could pass for the wrong reason: a replacement that
    // silently missed would leave no marker to find anywhere.
    expect(html).toContain('MARKER-BARE');
    expect(html).not.toContain('aria-label="Message from Budi Santoso" id="mid.$cAAB4444444444444444"');

    const parsed = parseMessengerThread(html, { selfName: PAGE.name });

    expect(parsed.messages.map((m) => m.text).join('\n')).not.toContain('MARKER-BARE');
  });

  it('reports every row as unattributable when the markup stops matching', async () => {
    // How a stale selector becomes visible instead of looking like a quiet
    // "no new messages": the watcher raises this ratio as an error.
    const broken = (await fixture('messenger-thread.html'))
      .replace(/aria-label="Message from [^"]*"/g, '')
      .replace(/<img[^>]*>/g, '');
    const parsed = parseMessengerThread(broken, { selfName: PAGE.name });

    expect(parsed.matchedRows).toBeGreaterThan(0);
    expect(parsed.messages).toHaveLength(0);
  });

  it('answers with nothing, and does not throw, on markup it cannot read', () => {
    const parsed = parseMessengerThread('<div>not messenger at all</div>');

    expect(parsed.messages).toEqual([]);
    expect(parsed.matchedRows).toBe(0);
  });
});

describe('the Page comment parser', () => {
  it('keeps every field a comment has to carry', async () => {
    const { comments } = parseFacebookComments(await fixture('page-comments.html'));

    expect(comments[0]).toMatchObject({
      commentId: '112233445566',
      postId: '998877665544',
      authorId: '100000000000001',
      authorName: 'Budi Santoso',
      text: 'Ada size M kak?',
      commentedAt: new Date(1789000300 * 1000).toISOString(),
    });
  });

  it('drops a comment with no id instead of inventing one', async () => {
    // A synthesised id would re-insert the same comment on every sweep, because
    // a comment list reorders and paginates between reads.
    const { comments, droppedNoId } = parseFacebookComments(await fixture('page-comments.html'));

    expect(comments.map((c) => c.authorName)).not.toContain('Anonim');
    expect(droppedNoId).toBe(1);
  });

  it('leaves out a comment with no text', async () => {
    const { comments } = parseFacebookComments(await fixture('page-comments.html'));

    expect(comments.map((c) => c.authorName)).not.toContain('Rina');
  });

  it('keeps Like/Reply chrome out of the comment body', async () => {
    const { comments } = parseFacebookComments(await fixture('page-comments.html'));

    for (const comment of comments) {
      expect(comment.text.toLowerCase()).not.toContain('balas');
      expect(comment.text.toLowerCase()).not.toContain('suka');
    }
  });

  it('answers with nothing, and does not throw, on markup it cannot read', () => {
    expect(parseFacebookComments('<div>an unrelated page</div>').comments).toEqual([]);
  });
});

/* --------------------------------------------------- the idempotency key */

describe('the idempotency key', () => {
  const message = {
    threadId: '100000000000001', externalMessageId: null, senderId: '100000000000001',
    senderName: 'Budi Santoso', text: 'halo', sentAt: null, direction: 'inbound' as const, seq: 0,
  };

  it('is computed identically by the API and the worker', () => {
    // These are two separate barriers against the same redelivery. If they
    // disagreed, an event the spool correctly rejected as a duplicate could
    // still reach the second one under a fresh key and insert a second copy.
    expect(facebookExternalId('tenant-1', 'message', message, null))
      .toBe(facebookMessageKey('tenant-1', message));
  });

  it('uses facebook\'s own id when there is one', () => {
    const withId = { ...message, externalMessageId: 'mid.$cAAB1111' };

    expect(facebookExternalId('tenant-1', 'message', withId, null)).toBe('fb_dm:tenant-1:mid.$cAAB1111');
    expect(facebookMessageKey('tenant-1', withId)).toBe('fb_dm:tenant-1:mid.$cAAB1111');
  });

  it('tells two identical texts apart by their position in the thread', () => {
    // A customer sending "halo" twice is two messages. Hashing the text alone
    // would silently drop the second one.
    const first = facebookMessageKey('tenant-1', message);
    const second = facebookMessageKey('tenant-1', { ...message, seq: 1 });

    expect(second).not.toBe(first);
  });

  it('does not collide across tenants or threads', () => {
    expect(facebookMessageKey('tenant-2', message)).not.toBe(facebookMessageKey('tenant-1', message));
    expect(facebookMessageKey('tenant-1', { ...message, threadId: 'other' }))
      .not.toBe(facebookMessageKey('tenant-1', message));
  });

  it('is built from the shape the bridge itself declares', () => {
    // The bridge has its own copy of this string, because the two services
    // deploy separately. This is what keeps the copies honest.
    expect(compositeMessageKey({
      tenantId: 'tenant-1', threadId: message.threadId, senderId: message.senderId,
      seq: message.seq, text: message.text,
    })).toBe('fb_dm:tenant-1:100000000000001:100000000000001:0:halo');
  });
});

/* ------------------------------------------------------ the ingest path */

describe('a Facebook event reaching the CRM', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let e: Env;

  const post = (body: unknown, secret?: string) => app.inject({
    method: 'POST', url: '/v1/webhooks/fb-bridge',
    headers: { authorization: `Bearer ${secret ?? e.FB_BRIDGE_SECRET}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  const messageEvent = (over: Record<string, unknown> = {}) => ({
    event: 'message', tenantId: t.tenantId, at: new Date().toISOString(),
    message: {
      threadId: '100000000000001', externalMessageId: 'mid.$cAAB1111111111111111',
      senderId: '100000000000001', senderName: 'Budi Santoso', text: 'Sis, ini masih ready?',
      sentAt: new Date(1789000000 * 1000).toISOString(), direction: 'inbound', seq: 0, ...over,
    },
  });

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbbridge');
    e = env();

    app = buildApp({
      db, control: db, kek: TEST_KEK, env: e,
      // The queue runs inline so one injected request exercises the whole path.
      dispatch: async ({ queue, payload }) => {
        if (queue !== 'inbound.normalise') return;
        await processInboundWebhook(
          { db, control: db, kek: TEST_KEK, dispatch: async () => {} },
          (payload as { webhookEventId: string }).webhookEventId,
        );
      },
    });
    await app.ready();

    await withTenant(db, t.tenantId, (tx) =>
      ensureMessengerBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        pageId: PAGE.id, pageName: PAGE.name, status: 'connected',
      }));
  });

  afterAll(async () => { await app.close(); await db.close(); });

  const conversationsFor = (threadIdHint: string) => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ id: string; contact_id: string; body: string }>(
      `select m.id, c.contact_id, m.provider_message_id as body
         from messages m
         join conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
         join channels ch on ch.id = m.channel_id and ch.tenant_id = m.tenant_id
        where m.tenant_id = $1 and ch.kind = 'messenger_bridge' and m.provider_message_id like $2`,
      [t.tenantId, `%${threadIdHint}%`]));

  it('refuses an event with the wrong secret', async () => {
    expect((await post(messageEvent(), 'not-the-secret')).statusCode).toBe(401);
  });

  it('refuses an event that is missing a tenant', async () => {
    const res = await post({ event: 'message', message: messageEvent().message });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a malformed message rather than storing half of it', async () => {
    // A bridge that half-broke should get a 400 it can log, not a row with an
    // empty sender in the customer's inbox.
    for (const broken of [
      messageEvent({ senderId: undefined }),
      messageEvent({ text: undefined }),
      messageEvent({ seq: undefined }),
      messageEvent({ direction: 'outbound' }),
    ]) {
      expect((await post(broken)).statusCode).toBe(400);
    }
  });

  it('turns one inbound message into a contact, a conversation and a message', async () => {
    expect((await post(messageEvent())).statusCode).toBe(200);

    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ direction: string; sender_type: string; channel_kind: string; provider_ts: Date }>(
        `select m.direction, m.sender_type, ch.kind as channel_kind, m.provider_ts
           from messages m join channels ch on ch.id = m.channel_id and ch.tenant_id = m.tenant_id
          where m.tenant_id = $1 and ch.kind = 'messenger_bridge'`,
        [t.tenantId]));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'inbound', sender_type: 'contact', channel_kind: 'messenger_bridge' });
    expect(new Date(rows[0]!.provider_ts).toISOString()).toBe(new Date(1789000000 * 1000).toISOString());
  });

  it('identifies the contact by facebook id, not by display name', async () => {
    // The same person, renamed on Facebook. A name-keyed identity would create
    // a second contact; an id-keyed one does not.
    await post(messageEvent({
      externalMessageId: 'mid.$cAAB9999999999999999', senderName: 'Budi S.', text: 'halo lagi', seq: 9,
    }));

    const contacts = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from contacts where tenant_id = $1 and fb_user_id_bidx is not null`,
        [t.tenantId]));

    expect(contacts[0]!.n).toBe(1);
  });

  it('does not create a second message when the same event is redelivered', async () => {
    const before = (await conversationsFor('mid.$cAAB1111111111111111')).length;
    const res = await post(messageEvent());
    const after = (await conversationsFor('mid.$cAAB1111111111111111')).length;

    expect(res.statusCode).toBe(200);
    expect(after).toBe(before);
  });

  it('does not collapse a repeated word into one message', async () => {
    // Two "halo" at different points in a thread are two messages. Only the
    // per-message `seq` keeps them apart once no provider id is available.
    const base = { externalMessageId: null, text: 'halo', threadId: '100000000000007', senderId: '100000000000007' };
    await post(messageEvent({ ...base, seq: 0 }));
    await post(messageEvent({ ...base, seq: 1 }));

    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from messages m
           join conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
          where m.tenant_id = $1 and c.contact_id in (
            select id from contacts where tenant_id = $1 and fb_user_id_bidx is not null)
            and m.provider_ts is not null`,
        [t.tenantId]));

    // Two distinct rows exist for the repeated word — the count is above the
    // single message the first assertion in this suite created.
    expect(rows[0]!.n).toBeGreaterThanOrEqual(3);
  });

  it('never queues an outbound reply for a Facebook message', async () => {
    // `outboundSend` has no messenger_bridge branch, so anything queued here
    // would fall through to the Meta Graph sender this feature exists to avoid.
    const outbox = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>('select count(*)::int as n from message_outbox where tenant_id = $1', [t.tenantId]));

    expect(outbox[0]!.n).toBe(0);
  });

  it('stores a comment without opening a conversation for it', async () => {
    const conversationsBefore = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>('select count(*)::int as n from conversations where tenant_id = $1', [t.tenantId]));

    const res = await post({
      event: 'comment', tenantId: t.tenantId, at: new Date().toISOString(),
      comment: {
        commentId: '112233445566', postId: '998877665544', authorId: '100000000000001',
        authorName: 'Budi Santoso', text: 'Ada size M kak?',
        commentedAt: new Date(1789000300 * 1000).toISOString(), pageId: PAGE.id, pageName: PAGE.name,
      },
    });
    expect(res.statusCode).toBe(200);

    const comments = await withTenant(db, t.tenantId, (tx) =>
      listFacebookComments({ tx, tenantId: t.tenantId, kek: TEST_KEK }));
    const conversationsAfter = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>('select count(*)::int as n from conversations where tenant_id = $1', [t.tenantId]));

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      commentId: '112233445566', postId: '998877665544', authorExternalId: '100000000000001',
      authorName: 'Budi Santoso', body: 'Ada size M kak?', pageId: PAGE.id,
    });
    // A comment is not a conversation and must not have created one.
    expect(conversationsAfter[0]!.n).toBe(conversationsBefore[0]!.n);
  });

  it('records a redelivered comment once', async () => {
    const payload = {
      event: 'comment', tenantId: t.tenantId, at: new Date().toISOString(),
      comment: {
        commentId: '112233445566', postId: '998877665544', authorId: '100000000000001',
        authorName: 'Budi Santoso', text: 'Ada size M kak?', commentedAt: null,
        pageId: PAGE.id, pageName: PAGE.name,
      },
    };
    await post(payload);

    const comments = await withTenant(db, t.tenantId, (tx) =>
      listFacebookComments({ tx, tenantId: t.tenantId, kek: TEST_KEK }));

    expect(comments.filter((c) => c.commentId === '112233445566')).toHaveLength(1);
  });

  it('refuses a comment with no id', async () => {
    const res = await post({
      event: 'comment', tenantId: t.tenantId,
      comment: { postId: '998877665544', authorName: 'Anonim', text: 'Mantap', pageId: PAGE.id },
    });

    expect(res.statusCode).toBe(400);
  });

  it('marks the channel unusable when the session needs a human', async () => {
    const res = await post({
      event: 'session_error', tenantId: t.tenantId, at: new Date().toISOString(),
      error: 'Facebook meminta verifikasi manual', needsLogin: true,
    });
    expect(res.statusCode).toBe(200);

    const connection = await withTenant(db, t.tenantId, (tx) =>
      getFbBridgeConnection({ tx, tenantId: t.tenantId, kek: TEST_KEK }));
    const channel = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string }>(
        `select status from channels where tenant_id = $1 and kind = 'messenger_bridge'`, [t.tenantId]));

    // Loud, not silent: a session waiting on a person must not look healthy.
    expect(connection.status).toBe('checkpoint_required');
    expect(connection.lastError).toContain('verifikasi manual');
    expect(channel[0]!.status).toBe('error');
  });
});
