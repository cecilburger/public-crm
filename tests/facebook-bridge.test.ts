import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { env, type Env } from '@kirana/core';
import {
  withTenant, ensureMessengerBridgeChannel, getFbBridgeConnection, listFacebookComments,
  queueOutboundMessage, recordFacebookComment, listPendingComments, knownMessengerMessageIds,
  claimCommentForPublicReply, markCommentPublicReplied, markCommentPublicReplyFailed,
  claimCommentForDm, markCommentDmSent, markCommentDmFailed,
  type Database,
} from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { facebookExternalId } from '../apps/api/src/routes/webhooks.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { processOutbound } from '../apps/worker/src/processors/outboundSend.ts';
import { facebookMessageKey } from '../apps/worker/src/processors/facebookInbound.ts';
import { parseMessengerInbox } from '../apps/fb-bridge/src/parsers/messengerInbox.ts';
import {
  parseMessengerThread, parseMessengerTranscript, countOwnMessages, selectBackfill,
} from '../apps/fb-bridge/src/parsers/messengerThread.ts';
import { parseFacebookComments, countOwnCommentReplies } from '../apps/fb-bridge/src/parsers/comments.ts';
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

describe('the Messenger thread parser, on the shape the real site renders', () => {
  // `messenger-thread.html` covers the older shape the parser still falls back
  // to. This block covers what Facebook actually serves today, captured from a
  // live session: a `role="log"` transcript whose messages carry their sender
  // and body inside one aria-label.

  it('reads sender and body out of the message label', async () => {
    const parsed = parseMessengerThread(await fixture('messenger-thread-live.html'), { selfName: 'Red Panda Test' });

    expect(parsed.messages.map((m) => ({ sender: m.senderName, text: m.text }))).toEqual([
      { sender: 'Budi Santoso', text: 'Sis, ini masih ready?' },
      { sender: 'Budi Santoso', text: 'Yang warna hitam ada?' },
      { sender: 'Budi Santoso', text: 'oke sip' },
    ]);
  });

  it('treats a reply written as "Anda" as ours, not the customer\'s', async () => {
    // Facebook writes the first person for our own messages, never the Page
    // name — so matching on the configured Page name alone would report the
    // operator's own words back as an inbound customer message.
    const parsed = parseMessengerThread(await fixture('messenger-thread-live.html'), { selfName: 'Red Panda Test' });

    expect(parsed.messages.map((m) => m.text)).not.toContain('Halo kak, masih ada ya');
    expect(parsed.outboundRows).toBe(1);
  });

  it('does not mistake the thread header for a message', async () => {
    // The header is marked `data-scope="messages_table"` like every message but
    // carries no message label. Guessing a sender from its avatar and a body
    // from its visible text reported the date stamp "19/09/26 14.26" as a
    // customer message — confirmed against the real site.
    const parsed = parseMessengerThread(await fixture('messenger-thread-live.html'), { selfName: 'Red Panda Test' });

    expect(parsed.messages.map((m) => m.text)).not.toContain('19/09/26 14.26');
    expect(parsed.unknownSenderRows).toBe(0);
  });

  it('keeps the transcript chrome out of the messages', async () => {
    const parsed = parseMessengerThread(await fixture('messenger-thread-live.html'), { selfName: 'Red Panda Test' });

    const joined = parsed.messages.map((m) => m.text).join(' | ');
    expect(joined).not.toContain('Detail percakapan');
    expect(joined).not.toContain('Tindakan pesan');
    expect(joined).not.toContain('Terkirim');
  });

  it('reports one message per bubble, not one per labelled element', async () => {
    // Each message renders as a labelled container wrapping a labelled button.
    // Counting both would double every message, and each copy would take its
    // own sequence number, so nothing downstream could collapse them again.
    const parsed = parseMessengerThread(await fixture('messenger-thread-live.html'), { selfName: 'Red Panda Test' });

    expect(parsed.messages).toHaveLength(3);
  });

  it('falls back to the older shape when no message labels are present', async () => {
    // The two fixtures describe different Facebook builds; the parser has to
    // keep reading both rather than swapping one guess for another.
    const legacy = parseMessengerThread(await fixture('messenger-thread.html'), { selfName: PAGE.name });

    expect(legacy.messages.length).toBeGreaterThan(0);
  });
});

describe('confirming a message really was sent', () => {
  // An emptied composer proves nothing: Facebook clears it optimistically, so a
  // message the server rejected looks identical to one it accepted. The only
  // evidence is a new bubble from us in the transcript.

  it('counts a message we sent', async () => {
    const html = await fixture('messenger-thread-live.html');

    expect(countOwnMessages(html, { text: 'Halo kak, masih ada ya' })).toBe(1);
  });

  it('does not count the customer\'s messages as ours', async () => {
    const html = await fixture('messenger-thread-live.html');

    expect(countOwnMessages(html, { text: 'Sis, ini masih ready?' })).toBe(0);
  });

  it('counts a repeated reply twice, so before and after can be compared', async () => {
    // This is why the caller compares counts instead of asking "is it there?".
    // Customer-service replies repeat constantly — "baik kak", "siap" — and a
    // presence check would report success off a message from last week, or off
    // nothing having been sent at all.
    const once = await fixture('messenger-thread-live.html');
    const secondBubble = `
  <div data-scope="messages_table" aria-label="Pukul 19 September 2026 14.30, Anda: Halo kak, masih ada ya">
    <div role="button" aria-label="Masukkan, Pesan dikirim pukul 19 September 2026 14.30 oleh Anda: Halo kak, masih ada ya">
      <span dir="auto">Halo kak, masih ada ya</span>
    </div>
  </div>
`;
    // Inserted before the transcript's own closing tag, so every existing row
    // stays closed — consuming one would nest the new bubble inside the last
    // message, and a nested row is deliberately dropped as a duplicate.
    const closeAt = once.lastIndexOf('</div>');
    const twice = once.slice(0, closeAt) + secondBubble + once.slice(closeAt);

    expect(twice).not.toBe(once);
    expect(countOwnMessages(once, { text: 'Halo kak, masih ada ya' })).toBe(1);
    expect(countOwnMessages(twice, { text: 'Halo kak, masih ada ya' })).toBe(2);
  });

  it('reports no increase when the message never arrived', async () => {
    // The composer-cleared-but-nothing-sent case: the transcript is unchanged,
    // so the count is unchanged, so the send is not confirmed.
    const html = await fixture('messenger-thread-live.html');
    const before = countOwnMessages(html, { text: 'pesan yang tidak pernah terkirim' });
    const after = countOwnMessages(html, { text: 'pesan yang tidak pernah terkirim' });

    expect(before).toBe(0);
    expect(after).toBe(before);
  });

  it('recognises our own message when the Page name is used instead of "Anda"', async () => {
    const html = (await fixture('messenger-thread-live.html'))
      .replaceAll('oleh Anda:', 'oleh Red Panda Test:')
      .replaceAll(', Anda:', ', Red Panda Test:');

    expect(countOwnMessages(html, { text: 'Halo kak, masih ada ya', selfName: 'Red Panda Test' })).toBe(1);
  });

  it('answers zero, and does not throw, on markup it cannot read', () => {
    expect(countOwnMessages('<div>not messenger at all</div>', { text: 'apa pun' })).toBe(0);
  });
});

describe('choosing what history still needs importing', () => {
  const msg = (n: number, direction: 'inbound' | 'outbound' = 'inbound') => ({
    externalMessageId: `mid.$m${n}`, senderName: direction === 'inbound' ? 'Budi' : 'Anda',
    text: `pesan ${n}`, sentAt: null, direction,
  });
  const transcript = [msg(1), msg(2, 'outbound'), msg(3), msg(4), msg(5)];

  it('stops at the first message the CRM already has', async () => {
    // Everything behind a known message is necessarily older and therefore
    // already stored; reading further is wasted work.
    const picked = selectBackfill(transcript, {
      isKnown: (id) => id === 'mid.$m3', maxMessages: 50,
    });

    expect(picked.map((m) => m.externalMessageId)).toEqual(['mid.$m4', 'mid.$m5']);
  });

  it('returns them oldest first, however it discovered them', async () => {
    // Discovery runs backwards; a conversation has to arrive forwards.
    const picked = selectBackfill(transcript, { isKnown: () => false, maxMessages: 50 });

    expect(picked.map((m) => m.text)).toEqual(['pesan 1', 'pesan 2', 'pesan 3', 'pesan 4', 'pesan 5']);
  });

  it('respects the backfill limit when nothing is known yet', async () => {
    // The backstop for a thread whose known anchor scrolled out of view: without
    // it, a years-long conversation would be re-imported wholesale.
    const picked = selectBackfill(transcript, { isKnown: () => false, maxMessages: 2 });

    expect(picked.map((m) => m.externalMessageId)).toEqual(['mid.$m4', 'mid.$m5']);
  });

  it('imports nothing when the CRM already has the newest message', async () => {
    const picked = selectBackfill(transcript, { isKnown: (id) => id === 'mid.$m5', maxMessages: 50 });

    expect(picked).toEqual([]);
  });

  it('keeps both directions, so a thread does not read as one-sided', async () => {
    const picked = selectBackfill(transcript, { isKnown: () => false, maxMessages: 50 });

    expect(picked.map((m) => m.direction)).toEqual(['inbound', 'outbound', 'inbound', 'inbound', 'inbound']);
  });

  it('leaves messages with no Facebook id to the live watcher', async () => {
    // The fallback key contains a sequence number the bridge hands out when it
    // first sees a message. It cannot be reconstructed after a restart, so
    // backfilling on it would not deduplicate — it would manufacture a second
    // copy of every message on every reconciliation.
    const mixed = [{ ...msg(1), externalMessageId: null }, msg(2), { ...msg(3), externalMessageId: null }];
    const picked = selectBackfill(mixed, { isKnown: () => false, maxMessages: 50 });

    expect(picked.map((m) => m.externalMessageId)).toEqual(['mid.$m2']);
  });

  it('reads a real transcript into something it can select from', async () => {
    // The two halves join up: what the parser produces is what the selector
    // consumes, on the markup the live site actually serves.
    const parsed = parseMessengerTranscript(await fixture('messenger-thread-live.html'), {
      selfName: 'Red Panda Test',
    });

    expect(parsed.messages.map((m) => m.direction))
      .toEqual(['inbound', 'inbound', 'inbound', 'outbound']);

    // Three of the four carry a Facebook id, so backfill can reconcile them.
    // The fourth has none and is left to the live watcher, which holds the
    // sequence its fallback key needs.
    const eligible = selectBackfill(parsed.messages, { isKnown: () => false, maxMessages: 50 });
    expect(eligible.map((m) => m.externalMessageId)).toEqual([
      'mid.$cAAABsynthetic001', 'mid.$cAAABsynthetic002', 'mid.$cAAABsynthetic003',
    ]);
  });
});

describe('reading a message\'s Facebook id', () => {
  // The id is the dedup key. Borrowing a neighbouring message's would collapse
  // two different messages into one CRM row and lose a customer's words, so
  // every lookup is scoped to the row that owns it.

  it('prefers data-message-id', async () => {
    const parsed = parseMessengerTranscript(await fixture('messenger-thread-live.html'), {
      selfName: 'Red Panda Test',
    });

    expect(parsed.messages[0]!.externalMessageId).toBe('mid.$cAAABsynthetic001');
  });

  it('falls back to the row\'s id attribute when data-message-id is absent', async () => {
    // The second row in the fixture carries only `id`, as some rows do live.
    const parsed = parseMessengerTranscript(await fixture('messenger-thread-live.html'), {
      selfName: 'Red Panda Test',
    });

    expect(parsed.messages[1]!.externalMessageId).toBe('mid.$cAAABsynthetic002');
  });

  it('reports no id for a row that carries none', async () => {
    const parsed = parseMessengerTranscript(await fixture('messenger-thread-live.html'), {
      selfName: 'Red Panda Test',
    });

    expect(parsed.messages[2]!.externalMessageId).toBeNull();
  });

  it('never borrows the id of a neighbouring message', async () => {
    // The failure this guards against is silent: an id taken from the row next
    // door makes two distinct messages share a dedup key, so the second one is
    // dropped as a duplicate and the customer's words disappear.
    const html = `
      <div role="log">
        <div data-scope="messages_table" aria-label="Pukul 19 September 2026 10.00, Budi: pesan tanpa id">
          <span dir="auto">pesan tanpa id</span>
        </div>
        <div data-scope="messages_table" data-message-id="mid.$cAAABtetangga"
             aria-label="Pukul 19 September 2026 10.01, Budi: pesan bertetangga">
          <span dir="auto">pesan bertetangga</span>
        </div>
      </div>`;
    const parsed = parseMessengerTranscript(html, { selfName: 'Red Panda Test' });

    expect(parsed.messages.map((m) => m.text)).toEqual(['pesan tanpa id', 'pesan bertetangga']);
    expect(parsed.messages[0]!.externalMessageId).toBeNull();
    expect(parsed.messages[1]!.externalMessageId).toBe('mid.$cAAABtetangga');
  });

  it('keeps reconciliation idempotent on a realistic transcript', async () => {
    // Two passes over the same rendered transcript: the second finds the same
    // ids, so with the CRM already holding them nothing is selected again.
    const html = await fixture('messenger-thread-live.html');
    const first = selectBackfill(
      parseMessengerTranscript(html, { selfName: 'Red Panda Test' }).messages,
      { isKnown: () => false, maxMessages: 50 });
    const stored = new Set(first.map((m) => m.externalMessageId!));
    const second = selectBackfill(
      parseMessengerTranscript(html, { selfName: 'Red Panda Test' }).messages,
      { isKnown: (id) => stored.has(id), maxMessages: 50 });

    expect(first).toHaveLength(3);
    expect(second).toEqual([]);
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
    // The bridge keys on its session, which for Marketing is the tenant id —
    // so the string is unchanged from before divisions existed.
    expect(compositeMessageKey({
      sessionKey: 'tenant-1', threadId: message.threadId, senderId: message.senderId,
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
      messageEvent({ direction: 'sideways' }),
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

  it('fails a reply instead of leaving it queued forever', async () => {
    // The bridge cannot send, so a reply has nothing to deliver it. Falling
    // through reached the Meta Graph sender — the one thing this channel exists
    // to avoid — and the message simply stayed at 'queued'. Confirmed live: an
    // agent typed a reply to a real customer, saw it sitting in the thread, and
    // it had never left the CRM. A queued message reads as sent; a failed one
    // with a reason does not.
    const conv = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ id: string }>(
        `select c.id from conversations c
           join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
          where c.tenant_id = $1 and ch.kind = 'messenger_bridge' limit 1`,
        [t.tenantId]));
    expect(conv[0]).toBeDefined();

    const queued = await withTenant(db, t.tenantId, (tx) =>
      queueOutboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        conversationId: conv[0]!.id, body: 'berapa mas?', senderType: 'agent',
      }));

    // Every other provider client throws: a Facebook reply reaching one of them
    // would itself be the bug, so the test fails loudly rather than quietly
    // sending down the wrong channel.
    const never = () => { throw new Error('a Facebook reply must never reach another provider client'); };
    // The Facebook client stands in for a bridge that has no sender yet, which
    // is what it really answers today (501 → permanent).
    let sentThreadId: string | null = null;
    const fbBridge = {
      send: async (args: { threadId: string }) => {
        sentThreadId = args.threadId;
        const err = new Error(
          'fb-bridge send failed: Balasan Facebook belum tersedia — selector composer belum diverifikasi',
        ) as Error & { permanent?: boolean };
        err.permanent = true;
        throw err;
      },
    };
    await processOutbound({
      db, kek: TEST_KEK,
      meta: { send: never } as never,
      waBridge: { send: never } as never,
      igBridge: { send: never } as never,
      fbBridge: fbBridge as never,
      accessTokenFor: never as never,
    }, { tenantId: t.tenantId, messageId: queued.messageId });

    // The real chain ran: the thread id was unsealed off the contact and handed
    // to the client. Only the delivery itself is missing.
    expect(sentThreadId).toBe('100000000000001');

    const after = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string; error: Record<string, unknown> | null }>(
        'select status, error from messages where tenant_id = $1 and id = $2',
        [t.tenantId, queued.messageId]));
    const outbox = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        'select count(*)::int as n from message_outbox where tenant_id = $1 and message_id = $2',
        [t.tenantId, queued.messageId]));

    expect(after[0]!.status).toBe('failed');
    expect(JSON.stringify(after[0]!.error)).toContain('belum tersedia');
    // Left in the outbox it would be retried forever against a sender that
    // cannot exist yet.
    expect(outbox[0]!.n).toBe(0);
  });

  it('marks a reply sent once the bridge confirms delivery', async () => {
    // The other half of the outbound contract: a confirmed send has to leave
    // the message as 'sent' and take it out of the outbox, or the relay would
    // deliver it a second time.
    const conv = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ id: string }>(
        `select c.id from conversations c
           join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
          where c.tenant_id = $1 and ch.kind = 'messenger_bridge' limit 1`,
        [t.tenantId]));
    const queued = await withTenant(db, t.tenantId, (tx) =>
      queueOutboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        conversationId: conv[0]!.id, body: 'baik kak, saya cek dulu', senderType: 'agent',
      }));

    const never = () => { throw new Error('a Facebook reply must never reach another provider client'); };
    await processOutbound({
      db, kek: TEST_KEK,
      meta: { send: never } as never,
      waBridge: { send: never } as never,
      igBridge: { send: never } as never,
      fbBridge: { send: async () => {} } as never,
      accessTokenFor: never as never,
    }, { tenantId: t.tenantId, messageId: queued.messageId });

    const after = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string }>('select status from messages where tenant_id = $1 and id = $2',
        [t.tenantId, queued.messageId]));
    const outbox = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        'select count(*)::int as n from message_outbox where tenant_id = $1 and message_id = $2',
        [t.tenantId, queued.messageId]));

    expect(after[0]!.status).toBe('sent');
    expect(outbox[0]!.n).toBe(0);
  });

  it('fails a reply to a thread that cannot accept one, without retrying', async () => {
    // A message request renders its transcript and offers no composer at all.
    // No retry will ever produce one, so the bridge answers 409 and the client
    // marks it permanent — the message fails with the reason rather than
    // cycling through the outbox forever.
    const conv = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ id: string }>(
        `select c.id from conversations c
           join channels ch on ch.id = c.channel_id and ch.tenant_id = c.tenant_id
          where c.tenant_id = $1 and ch.kind = 'messenger_bridge' limit 1`,
        [t.tenantId]));
    const queued = await withTenant(db, t.tenantId, (tx) =>
      queueOutboundMessage({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        conversationId: conv[0]!.id, body: 'halo kak', senderType: 'agent',
      }));

    const never = () => { throw new Error('a Facebook reply must never reach another provider client'); };
    await processOutbound({
      db, kek: TEST_KEK,
      meta: { send: never } as never,
      waBridge: { send: never } as never,
      igBridge: { send: never } as never,
      fbBridge: {
        send: async () => {
          const err = new Error(
            'fb-bridge send failed: Percakapan ini belum bisa dibalas — Facebook tidak menampilkan kotak pesan',
          ) as Error & { permanent?: boolean };
          err.permanent = true;
          throw err;
        },
      } as never,
      accessTokenFor: never as never,
    }, { tenantId: t.tenantId, messageId: queued.messageId });

    const after = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string; error: Record<string, unknown> | null }>(
        'select status, error from messages where tenant_id = $1 and id = $2',
        [t.tenantId, queued.messageId]));
    const outbox = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        'select count(*)::int as n from message_outbox where tenant_id = $1 and message_id = $2',
        [t.tenantId, queued.messageId]));

    expect(after[0]!.status).toBe('failed');
    expect(JSON.stringify(after[0]!.error)).toContain('kotak pesan');
    expect(outbox[0]!.n).toBe(0);
  });

  it('imports a thread\'s history with each message on the right side', async () => {
    // A conversation that predates the bridge is half ours. Importing only the
    // customer's side leaves the CRM showing somebody talking to nobody, and an
    // agent reading that cannot tell the question was already answered.
    const thread = '100000000000042';
    const history = [
      { seq: 0, direction: 'inbound', text: 'halo, masih buka?', externalMessageId: 'mid.$hist001' },
      { seq: 1, direction: 'outbound', text: 'halo kak, masih', externalMessageId: 'mid.$hist002' },
      { seq: 2, direction: 'inbound', text: 'oke saya mampir', externalMessageId: 'mid.$hist003' },
    ];
    for (const m of history) {
      const res = await post(messageEvent({ ...m, threadId: thread, senderId: thread }));
      expect(res.statusCode).toBe(200);
    }

    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ direction: string; sender_type: string; status: string }>(
        `select m.direction, m.sender_type, m.status from messages m
           join conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
           join contacts ct on ct.id = c.contact_id and ct.tenant_id = m.tenant_id
          where m.tenant_id = $1 and ct.fb_user_id_bidx is not null
            and m.provider_message_id like 'fb_dm:%hist%'
          order by m.provider_ts`, [t.tenantId]));

    expect(rows.map((r) => r.direction)).toEqual(['inbound', 'outbound', 'inbound']);
    // Our own historical reply is recorded as already sent by an agent.
    expect(rows[1]).toMatchObject({ sender_type: 'agent', status: 'sent' });
  });

  it('never queues a historical outbound message to be sent again', async () => {
    // These were sent on Facebook long ago. An outbox row would deliver them a
    // second time, to a real person.
    const outbox = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from message_outbox o
           join messages m on m.id = o.message_id and m.tenant_id = o.tenant_id
          where o.tenant_id = $1 and m.provider_message_id like 'fb_dm:%hist%'`, [t.tenantId]));

    expect(outbox[0]!.n).toBe(0);
  });

  it('inserts nothing on a second reconciliation of the same history', async () => {
    const count = () => withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from messages
          where tenant_id = $1 and provider_message_id like 'fb_dm:%hist%'`, [t.tenantId]));
    const before = (await count())[0]!.n;

    const thread = '100000000000042';
    for (const m of [
      { seq: 0, direction: 'inbound', text: 'halo, masih buka?', externalMessageId: 'mid.$hist001' },
      { seq: 1, direction: 'outbound', text: 'halo kak, masih', externalMessageId: 'mid.$hist002' },
      { seq: 2, direction: 'inbound', text: 'oke saya mampir', externalMessageId: 'mid.$hist003' },
    ]) {
      await post(messageEvent({ ...m, threadId: thread, senderId: thread }));
    }

    expect((await count())[0]!.n).toBe(before);
  });

  it('keeps history Facebook has stopped rendering', async () => {
    // A transcript only shows a window of a conversation. Reconciliation must
    // never take "Facebook no longer displays it" as "it did not happen".
    const before = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from messages
          where tenant_id = $1 and provider_message_id like 'fb_dm:%hist%'`, [t.tenantId]));

    // A later sweep sees only the newest message of that thread.
    await post(messageEvent({
      seq: 2, direction: 'inbound', text: 'oke saya mampir', externalMessageId: 'mid.$hist003',
      threadId: '100000000000042', senderId: '100000000000042',
    }));

    const after = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from messages
          where tenant_id = $1 and provider_message_id like 'fb_dm:%hist%'`, [t.tenantId]));

    expect(after[0]!.n).toBe(before[0]!.n);
    expect(after[0]!.n).toBe(3);
  });

  it('tells the bridge which message ids it already holds', async () => {
    // This is what makes Postgres the source of truth for reconciliation: a
    // backfill walks a thread newest-first and stops at the first id named here.
    const channel = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ id: string }>(
        `select id from channels where tenant_id = $1 and kind = 'messenger_bridge' limit 1`, [t.tenantId]));

    const known = await withTenant(db, t.tenantId, (tx) =>
      knownMessengerMessageIds({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        channelId: channel[0]!.id,
        providerMessageIds: [
          `fb_dm:${t.tenantId}:mid.$hist002`,
          `fb_dm:${t.tenantId}:mid.$neverSeen`,
        ],
      }));

    expect(known.has(`fb_dm:${t.tenantId}:mid.$hist002`)).toBe(true);
    expect(known.has(`fb_dm:${t.tenantId}:mid.$neverSeen`)).toBe(false);
  });

  it('keeps the fallback id stable across reconciliation', async () => {
    // A message with no Facebook id of its own still has to land on the same
    // row every time the thread is re-read, or each sweep would add a copy.
    const base = {
      threadId: '100000000000043', senderId: '100000000000043',
      externalMessageId: null, text: 'tanpa id', seq: 0, direction: 'inbound',
    };
    await post(messageEvent(base));
    await post(messageEvent(base));
    await post(messageEvent(base));

    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from messages m
           join conversations c on c.id = m.conversation_id and c.tenant_id = m.tenant_id
           join contacts ct on ct.id = c.contact_id and ct.tenant_id = m.tenant_id
          where m.tenant_id = $1 and ct.fb_user_id_bidx is not null`, [t.tenantId]));

    // Three identical reconciliations, one row.
    expect(rows[0]!.n).toBeGreaterThan(0);
    const again = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>(
        `select count(*)::int as n from messages where tenant_id = $1
           and provider_message_id = $2`,
        [t.tenantId, null]));
    expect(again[0]!.n).toBe(0);
  });

  it('tells the bridge which ids it holds, over the read endpoint', async () => {
    // The bridge reconciles against this rather than a file of its own, so a
    // restore or redeploy on either side cannot leave the two disagreeing.
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/fb-bridge/known',
      headers: { authorization: `Bearer ${e.FB_BRIDGE_SECRET}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        tenantId: t.tenantId,
        externalIds: [`fb_dm:${t.tenantId}:mid.$hist002`, `fb_dm:${t.tenantId}:mid.$neverSeen`],
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { known: string[] };
    expect(body.known).toContain(`fb_dm:${t.tenantId}:mid.$hist002`);
    expect(body.known).not.toContain(`fb_dm:${t.tenantId}:mid.$neverSeen`);
  });

  it('refuses the read endpoint without the shared secret', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/webhooks/fb-bridge/known',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      payload: JSON.stringify({ tenantId: t.tenantId, externalIds: [] }),
    });

    expect(res.statusCode).toBe(401);
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

/* ------------------------------------------- comment processing state machine */

describe('a comment being worked on', () => {
  let db: Database;
  let t: TestTenant;
  let seq = 0;

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbcomment');
  });
  afterAll(async () => { await db.close(); });

  /** A fresh comment, so each test starts from 'new' without touching another. */
  const given = async (over: Record<string, unknown> = {}) => {
    seq += 1;
    const commentId = `9000000000${seq}`;
    const row = await withTenant(db, t.tenantId, (tx) =>
      recordFacebookComment({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        pageId: PAGE.id, pageName: PAGE.name, postId: '998877665544', commentId,
        authorExternalId: `10000000000${seq}`, authorName: 'Budi Santoso',
        body: 'mau tau jasa ini gimana?', commentedAt: new Date(1789000000_000 + seq), ...over,
      }));
    return row.id;
  };

  const pending = (args: Record<string, unknown> = {}) => withTenant(db, t.tenantId, (tx) =>
    listPendingComments({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { limit: 100, ...args }));

  const statusOf = async (id: string) => {
    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ status: string; public_reply_error: string | null; dm_error: string | null; attempts: number }>(
        'select status, public_reply_error, dm_error, attempts from facebook_comments where tenant_id = $1 and id = $2',
        [t.tenantId, id]));
    return rows[0]!;
  };

  it('offers a newly stored comment as work', async () => {
    const id = await given();
    const work = await pending();

    expect(work.map((c) => c.id)).toContain(id);
    expect(work.find((c) => c.id === id)).toMatchObject({ status: 'new', attempts: 0 });
  });

  it('lets exactly one worker claim a comment for a public reply', async () => {
    // The whole point of the guard: a retry, a second sweep or a restarted
    // bridge must not reply twice on a real customer's post.
    const id = await given();

    const first = await withTenant(db, t.tenantId, (tx) =>
      claimCommentForPublicReply({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    const second = await withTenant(db, t.tenantId, (tx) =>
      claimCommentForPublicReply({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect((await statusOf(id)).attempts).toBe(1);
  });

  it('records a public reply and will not reply to it again', async () => {
    const id = await given();
    await withTenant(db, t.tenantId, (tx) =>
      claimCommentForPublicReply({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    await withTenant(db, t.tenantId, (tx) =>
      markCommentPublicReplied({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));

    expect((await statusOf(id)).status).toBe('public_replied');
    // Claiming for a reply only ever moves a comment out of 'new'.
    const again = await withTenant(db, t.tenantId, (tx) =>
      claimCommentForPublicReply({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    expect(again).toBe(false);
  });

  it('keeps the public reply when the private message is unavailable', async () => {
    // Facebook offers a private reply to a commenter once, inside a window.
    // "Not available" is an ordinary outcome, and it must not erase the fact
    // that the customer did get a public answer.
    const id = await given();
    for (const step of [claimCommentForPublicReply, markCommentPublicReplied, claimCommentForDm]) {
      await withTenant(db, t.tenantId, (tx) => step({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    }
    await withTenant(db, t.tenantId, (tx) =>
      markCommentDmFailed({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        id, reason: 'Facebook tidak menawarkan private reply untuk komentar ini',
      }));

    const after = await statusOf(id);
    expect(after.status).toBe('public_replied');
    expect(after.dm_error).toContain('private reply');
    // Terminal: a comment whose DM already failed is not offered again.
    expect((await pending()).map((c) => c.id)).not.toContain(id);
  });

  it('marks dm_sent only after a claim, never straight from public_replied', async () => {
    const id = await given();
    for (const step of [claimCommentForPublicReply, markCommentPublicReplied]) {
      await withTenant(db, t.tenantId, (tx) => step({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    }

    const tooEarly = await withTenant(db, t.tenantId, (tx) =>
      markCommentDmSent({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    expect(tooEarly).toBe(false);

    await withTenant(db, t.tenantId, (tx) =>
      claimCommentForDm({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    const sent = await withTenant(db, t.tenantId, (tx) =>
      markCommentDmSent({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));

    expect(sent).toBe(true);
    expect((await statusOf(id)).status).toBe('dm_sent');
    expect((await pending()).map((c) => c.id)).not.toContain(id);
  });

  it('lets exactly one worker claim a comment for the private message', async () => {
    const id = await given();
    for (const step of [claimCommentForPublicReply, markCommentPublicReplied]) {
      await withTenant(db, t.tenantId, (tx) => step({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    }

    const first = await withTenant(db, t.tenantId, (tx) =>
      claimCommentForDm({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    const second = await withTenant(db, t.tenantId, (tx) =>
      claimCommentForDm({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('a failed public reply is terminal', async () => {
    const id = await given();
    await withTenant(db, t.tenantId, (tx) =>
      claimCommentForPublicReply({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));
    await withTenant(db, t.tenantId, (tx) =>
      markCommentPublicReplyFailed({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        id, reason: 'tombol balas tidak ditemukan',
      }));

    const after = await statusOf(id);
    expect(after.status).toBe('failed');
    expect(after.public_reply_error).toContain('tombol balas');
    expect((await pending()).map((c) => c.id)).not.toContain(id);
  });

  it('holds a comment back until its cooldown has passed', async () => {
    // Pacing is read off the row, not an in-process timer, so a bridge that
    // restarts every few minutes cannot reset its own pacing and burst.
    const id = await given();
    await withTenant(db, t.tenantId, (tx) =>
      claimCommentForPublicReply({ tx, tenantId: t.tenantId, kek: TEST_KEK }, { id }));

    const held = await pending({ cooldownMs: 60_000 });
    expect(held.map((c) => c.id)).not.toContain(id);

    const released = await pending({ cooldownMs: 0 });
    expect(released.map((c) => c.id)).toContain(id);
  });

  it('gives up on a comment that keeps failing', async () => {
    const id = await given();
    for (let i = 0; i < 3; i += 1) {
      await withTenant(db, t.tenantId, (tx) =>
        tx.query('update facebook_comments set attempts = attempts + 1 where tenant_id = $1 and id = $2',
          [t.tenantId, id]));
    }

    expect((await pending({ maxAttempts: 3 })).map((c) => c.id)).not.toContain(id);
  });

  it('never offers the same comment twice, however often it is re-read', async () => {
    // A reconciliation sweep re-reads every comment still on the post. The
    // unique index absorbs the re-insert; this checks the work list does too.
    const id = await given();
    for (let i = 0; i < 3; i += 1) {
      await withTenant(db, t.tenantId, (tx) =>
        recordFacebookComment({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          pageId: PAGE.id, postId: '998877665544', commentId: `9000000000${seq}`,
          authorName: 'Budi Santoso', body: 'mau tau jasa ini gimana?',
        }));
    }

    const work = await pending();
    expect(work.filter((c) => c.id === id)).toHaveLength(1);
  });
});

/* --------------------------------------- a comment as the Page renders it */

describe('a comment on the Page timeline, on the shape the real site renders', () => {
  const OWN_REPLY = (name: string, text: string) =>
    `<div role="article" aria-label="Reply by ${name} 1m"><a href="/profile.php?id=900000000000001">${name}</a><div>${text}</div><div>Like</div></div>`;

  it('reads the stable comment id, the pfbid post slug, and the commenter', async () => {
    const { comments, droppedNoId, droppedNoPost } = parseFacebookComments(await fixture('page-comment-live.html'));

    expect(droppedNoId).toBe(0);
    expect(droppedNoPost).toBe(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      commentId: '900000000000031',
      // A `pfbid…` slug, not digits — a first guard accepted only digits and
      // dropped every comment on the Page as "no post".
      postId: expect.stringMatching(/^pfbid0SYNTHETIC/),
      authorId: '100000000000009',
      authorName: 'Sinta Dewi',
      text: 'mau tau jasa ini gimana?',
    });
  });

  it('names the commenter by the profile link, not by the label with the time glued on', async () => {
    // The label is "Comment by Sinta Dewi a few seconds ago" with nothing the
    // regex could stop at; the link says "Sinta Dewi".
    const { comments } = parseFacebookComments(await fixture('page-comment-live.html'));

    expect(comments[0]!.authorName).toBe('Sinta Dewi');
    expect(comments[0]!.authorName).not.toMatch(/ago|lalu/);
  });

  it('counts only the Page\'s own replies carrying exactly that text', async () => {
    const html = await fixture('page-comment-live.html');
    const withOwn = html.replace('</div>\n', OWN_REPLY('Toko Demo', 'Check DM ya kak!!!') + '</div>\n');

    expect(countOwnCommentReplies(html, { pageName: 'Toko Demo', text: 'Check DM ya kak!!!' })).toBe(0);
    expect(countOwnCommentReplies(withOwn, { pageName: 'Toko Demo', text: 'Check DM ya kak!!!' })).toBe(1);
    // Same words from the customer are not ours.
    expect(countOwnCommentReplies(html.replace('mau tau jasa ini gimana?', 'Check DM ya kak!!!'),
      { pageName: 'Toko Demo', text: 'Check DM ya kak!!!' })).toBe(0);
    // Ours, different words.
    expect(countOwnCommentReplies(withOwn, { pageName: 'Toko Demo', text: 'lain' })).toBe(0);
  });
});

/* ------------------------------------ a failure that can be tried again */

describe('an event that failed before the Page was connected', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let e: Env;

  const post = (body: unknown) => app.inject({
    method: 'POST', url: '/v1/webhooks/fb-bridge',
    headers: { authorization: `Bearer ${e.FB_BRIDGE_SECRET}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  const event = () => ({
    event: 'message', tenantId: t.tenantId, at: new Date().toISOString(),
    message: {
      threadId: '100000000000021', externalMessageId: 'mid.$cAAretry0001',
      senderId: '100000000000021', senderName: 'Rudi', text: 'halo, masih buka?',
      sentAt: null, direction: 'inbound', seq: 0,
    },
  });

  const stored = () => withTenant(db, t.tenantId, (tx) =>
    tx.query<{ id: string }>(
      `select m.id from messages m
         join channels ch on ch.id = m.channel_id and ch.tenant_id = m.tenant_id
        where m.tenant_id = $1 and ch.kind = 'messenger_bridge'`, [t.tenantId]));

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbretry');
    e = env();
    app = buildApp({
      db, control: db, kek: TEST_KEK, env: e,
      dispatch: async ({ queue, payload }) => {
        if (queue !== 'inbound.normalise') return;
        await processInboundWebhook(
          { db, control: db, kek: TEST_KEK, dispatch: async () => {} },
          (payload as { webhookEventId: string }).webhookEventId,
        ).catch(() => {});
      },
    });
    await app.ready();
    // Deliberately NO channel yet: this is a message arriving before the
    // operator has connected the Page, which is exactly what happened live.
  });

  afterAll(async () => { await app.close(); await db.close(); });

  it('is kept, not stored, while there is nowhere to put it', async () => {
    expect((await post(event())).statusCode).toBe(200);

    expect(await stored()).toHaveLength(0);
  });

  it('lands once the Page is connected and the bridge re-sends it', async () => {
    // The bridge re-emits on every reconciliation until the CRM holds it. A
    // failed spool row must therefore be re-processable — treated as a
    // duplicate it would be dropped forever, and the customer never answered.
    await withTenant(db, t.tenantId, (tx) =>
      ensureMessengerBridgeChannel({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
        pageId: PAGE.id, pageName: PAGE.name, status: 'connected',
      }));

    expect((await post(event())).statusCode).toBe(200);

    expect(await stored()).toHaveLength(1);
  });

  it('still refuses a third copy of a message it already holds', async () => {
    expect((await post(event())).statusCode).toBe(200);

    expect(await stored()).toHaveLength(1);
  });
});

/**
 * Replying to a Facebook conversation from the CRM, a day later.
 *
 * `guardOutbound` encodes Meta's rules for the WhatsApp Cloud API: reply
 * free-form within 24 hours of the customer's last message, or send an
 * approved template. A bridge has neither — it types into the same composer a
 * person would, and it cannot send a template at all.
 *
 * The worker's send path already knew that and skipped the guard for
 * `messenger_bridge`. The API did not, so a Facebook conversation that went
 * quiet for a day became unanswerable from the CRM: the reply was refused with
 * "send an approved template instead", naming a thing this channel has no way
 * to send. The two sides now read the same list.
 */
describe('replying to a Facebook conversation the day after', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let token: string;
  const jobs: { queue: string }[] = [];

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'fbwindow');
    const e = env();

    app = buildApp({
      db, control: db, kek: TEST_KEK, env: e,
      dispatch: async ({ queue, payload }) => {
        jobs.push({ queue });
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

    // Their message landed three days ago, so the service window is long shut.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    const sent = await app.inject({
      method: 'POST', url: '/v1/webhooks/fb-bridge',
      headers: { authorization: `Bearer ${e.FB_BRIDGE_SECRET}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        event: 'message', tenantId: t.tenantId, at: threeDaysAgo,
        message: {
          threadId: '100000000000077', externalMessageId: 'mid.$cAABwindow0000000001',
          senderId: '100000000000077', senderName: 'Gabe', text: 'masih buka kak?',
          sentAt: threeDaysAgo, direction: 'inbound', seq: 0,
        },
      }),
    });
    expect(sent.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { workspace: 'fbwindow', email: 'owner@fbwindow.test', password: 'correct horse battery staple' },
    });
    expect(login.statusCode).toBe(200);
    token = (login.json() as { accessToken: string }).accessToken;
  });

  afterAll(async () => { await app.close(); await db.close(); });

  it('queues the reply instead of demanding a template it cannot send', async () => {
    const list = await app.inject({
      method: 'GET', url: '/v1/conversations', headers: { authorization: `Bearer ${token}` },
    });
    const conv = (list.json() as { id: string; channel_kind: string }[])
      .find((row) => row.channel_kind === 'messenger_bridge');
    expect(conv).toBeDefined();

    jobs.length = 0;
    const res = await app.inject({
      method: 'POST', url: `/v1/conversations/${conv!.id}/messages`,
      headers: { authorization: `Bearer ${token}` },
      payload: { body: 'Halo kak, masih buka ya' },
    });

    expect(res.statusCode).toBe(202);
    expect(jobs.map((job) => job.queue)).toContain('outbound.send');
  });
});
