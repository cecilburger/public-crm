import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Type-only: erased at runtime, so this file never opens a database. It ties
// the fixtures below to the row the API actually returns, so a column added to
// or renamed in `FacebookCommentRow` breaks this file at typecheck time.
import type { FacebookCommentRow } from '@kirana/db';
import {
  groupCommentsByPost, inboxHref, toInboxItems,
  type ConversationLike, type InboxItem,
} from '../apps/console/lib/inbox.ts';

/**
 * The console's grouped Facebook comment view, fed exactly what
 * GET /v1/inbox/comments hands it.
 *
 * Pure-function tests, like tests/inbox-unified.test.ts: no browser, no
 * database. The route returns `{ comments: FacebookCommentRow[] }` with no
 * response schema, so the wire shape is that row passed through
 * JSON.stringify — every Date becomes an ISO string and every null stays a
 * null, `parentCommentId` included. `overTheWire` below does precisely that.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A row as the console receives it: dates are ISO strings after JSON. */
type OverTheWire<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};
type ApiComment = OverTheWire<FacebookCommentRow>;

const overTheWire = (rows: FacebookCommentRow[]): ApiComment[] =>
  (JSON.parse(JSON.stringify({ comments: rows })) as { comments: ApiComment[] }).comments;

type Conversation = ConversationLike & { status: string };

// Real post ids: 'pfbid0' plus ~60 alphanumerics. The two posts below differ
// only in their last character, so a grouping that matched on a prefix, or on
// anything looser than the full id, would merge them.
const POST_A = 'pfbid02Kq7XbZ4mWc9sT1nLr8vYh3JdF6pQe5gUa0iOk2BzNxCw7MjRt4HsVl9EyPoA';
const POST_B = 'pfbid02Kq7XbZ4mWc9sT1nLr8vYh3JdF6pQe5gUa0iOk2BzNxCw7MjRt4HsVl9EyPoB';
const PAGE_ID = '100087654321098';

let seq = 0;
const row = (over: Partial<FacebookCommentRow> = {}): FacebookCommentRow => {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    id: `00000000-0000-4000-8000-00000000${n}`,
    divisionId: '11111111-1111-4111-8111-111111111111',
    pageId: PAGE_ID, pageName: 'Toko Demo',
    postId: POST_A,
    // Facebook comment ids are 15-17 digit strings.
    commentId: `12203456789${n}`,
    parentCommentId: null,
    authorExternalId: null, authorName: 'Rudi', body: 'mau tanya harga',
    commentedAt: new Date('2026-09-24T08:00:00.000Z'),
    createdAt: new Date('2026-09-24T08:01:00.000Z'),
    status: 'dm_sent',
    publicReplyAt: null, publicReplyError: null, dmAt: null, dmError: null, attempts: 0,
    ...over,
  };
};

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'conv-1', channel_kind: 'whatsapp', status: 'open',
  last_message_at: '2026-09-25T09:00:00.000Z', ...over,
});

type CommentItem = Extract<InboxItem<Conversation, ApiComment>, { kind: 'comment' }>;

/**
 * What the "Komentar Facebook" channel tab groups: ConversationList narrows
 * the merged list to that channel, keeps the comment items and hands their
 * rows to `groupCommentsByPost` (ConversationList.tsx, the `postGroups`
 * block). Reproduced here with the same pure functions it calls.
 */
const facebookCommentTab = (items: InboxItem<Conversation, ApiComment>[]) =>
  groupCommentsByPost(
    items
      .filter((i) => i.channel === 'facebook_comment')
      .filter((i): i is CommentItem => i.kind === 'comment')
      .map((i) => i.comment),
  );

describe('the fixtures are the real wire shape', () => {
  it('uses real-looking Facebook ids and carries parentCommentId through JSON', () => {
    expect(POST_A).toMatch(/^pfbid0[A-Za-z0-9]{50,70}$/);
    expect(POST_B).toMatch(/^pfbid0[A-Za-z0-9]{50,70}$/);

    const [wire] = overTheWire([row({ commentedAt: null })]);

    expect(wire!.commentId).toMatch(/^\d{15,17}$/);
    // Present and null for a top-level comment, not dropped from the payload.
    expect(wire).toHaveProperty('parentCommentId', null);
    expect(wire!.commentedAt).toBeNull();
    expect(wire!.createdAt).toBe('2026-09-24T08:01:00.000Z');
  });
});

describe('a brand-new Facebook comment in the inbox', () => {
  // Two older comments already handled on the post, one DM, and the new
  // comment the bridge just delivered: Facebook gave no time for it, so it
  // sorts on when it was stored.
  const handledEarly = row({
    authorName: 'Gabe', status: 'dm_sent',
    commentedAt: new Date('2026-09-24T08:00:00.000Z'), createdAt: new Date('2026-09-24T08:01:00.000Z'),
  });
  const handledLater = row({
    authorName: 'Sinta', status: 'public_replied',
    commentedAt: null, createdAt: new Date('2026-09-24T15:30:00.000Z'),
  });
  const brandNew = row({
    authorName: 'Rudi', body: 'kak, ready stok?', status: 'new',
    commentedAt: null, createdAt: new Date('2026-09-25T10:05:00.000Z'),
  });
  // The API's own order: newest first.
  const comments = overTheWire([brandNew, handledLater, handledEarly]);
  const dm = conversation({ id: 'wa-1', last_message_at: '2026-09-25T09:00:00.000Z' });

  it('appears at the top of the unified list, sorted on its createdAt', () => {
    const items = toInboxItems([dm], comments);

    expect(items.map((i) => i.id)).toEqual([brandNew.id, 'wa-1', handledLater.id, handledEarly.id]);
    expect(items[0]!.kind).toBe('comment');
    expect(items[0]!.channel).toBe('facebook_comment');
    expect(items[0]!.at).toBe('2026-09-25T10:05:00.000Z');
  });

  it('is filed under its own post on the Komentar Facebook tab, with the older comments on it', () => {
    const groups = facebookCommentTab(toInboxItems([dm], comments));

    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group!.postId).toBe(POST_A);
    // Chronological inside the post; the list row previews the last one,
    // which is therefore the brand-new comment.
    expect(group!.comments.map((c) => c.id)).toEqual([handledEarly.id, handledLater.id, brandNew.id]);
    expect(group!.comments[group!.comments.length - 1]!.body).toBe('kak, ready stok?');
    expect(group!.latestAt).toBe('2026-09-25T10:05:00.000Z');
    // One waiting comment is enough to mark the whole post as waiting.
    expect(group!.needsReply).toBe(true);
  });

  it('puts the post that just got a comment above a post with older activity', () => {
    const otherPost = row({
      postId: POST_B, status: 'new',
      commentedAt: new Date('2026-09-25T07:00:00.000Z'), createdAt: new Date('2026-09-25T07:02:00.000Z'),
    });
    const groups = facebookCommentTab(toInboxItems([dm], [...comments, ...overTheWire([otherPost])]));

    expect(groups.map((g) => g.postId)).toEqual([POST_A, POST_B]);
  });

  it('opens its post, by the full pfbid id', () => {
    const item = toInboxItems([], comments).find((i) => i.id === brandNew.id)!;

    expect(inboxHref(item)).toBe(`/obrolan/komentar/${POST_A}`);
  });
});

describe('two posts, two groups', () => {
  const onA1 = row({ postId: POST_A, commentedAt: new Date('2026-09-25T06:00:00.000Z') });
  const onB1 = row({ postId: POST_B, commentedAt: new Date('2026-09-25T06:30:00.000Z') });
  const onA2 = row({ postId: POST_A, status: 'new', commentedAt: null, createdAt: new Date('2026-09-25T07:00:00.000Z') });
  const onB2 = row({ postId: POST_B, status: 'new', commentedAt: new Date('2026-09-25T08:00:00.000Z') });
  const comments = overTheWire([onB2, onA2, onB1, onA1]);

  it('files each post on its own, newest activity first', () => {
    const groups = facebookCommentTab(toInboxItems([], comments));

    expect(groups.map((g) => g.postId)).toEqual([POST_B, POST_A]);
    expect(groups.find((g) => g.postId === POST_A)!.comments.map((c) => c.id)).toEqual([onA1.id, onA2.id]);
    expect(groups.find((g) => g.postId === POST_B)!.comments.map((c) => c.id)).toEqual([onB1.id, onB2.id]);
  });

  it('never places a comment under another post, and never drops or repeats one', () => {
    const groups = facebookCommentTab(toInboxItems([conversation()], comments));

    for (const group of groups) {
      for (const c of group.comments) expect(c.postId).toBe(group.postId);
    }
    const placed = groups.flatMap((g) => g.comments.map((c) => c.id));
    expect([...placed].sort()).toEqual(comments.map((c) => c.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('leaves DMs out of the comment tab entirely', () => {
    const groups = facebookCommentTab(
      toInboxItems([conversation({ id: 'fb-dm', channel_kind: 'messenger_bridge' })], comments),
    );

    expect(groups.flatMap((g) => g.comments.map((c) => c.id))).not.toContain('fb-dm');
  });
});

describe('the status tabs and a comment nobody has answered yet', () => {
  /**
   * ConversationList's own predicates (`itemNeedsReply`, `itemIsDone`) and
   * its tab filter are module-private inside a 'use client' component that
   * imports next/navigation, so they cannot be imported here. They are read
   * from the source instead — the same technique tests/inbox-unified.test.ts
   * uses for the route guards — and the grouped tab is exercised through
   * `groupCommentsByPost().needsReply`, the pure helper its filter reads.
   */
  const source = () => readFile(join(ROOT, 'apps/console/components/ConversationList.tsx'), 'utf8');

  /** The quoted statuses in the first array literal after `const <name>`. */
  const statusesIn = (src: string, name: string): string[] => {
    const at = src.indexOf(`const ${name}`);
    expect(at, `${name} not found in ConversationList.tsx`).toBeGreaterThan(-1);
    const literal = /\[([^\]]*)\]/.exec(src.slice(at));
    expect(literal).not.toBeNull();
    return [...literal![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  };

  const ALL_STATUSES = ['new', 'public_reply_pending', 'public_replied', 'dm_pending', 'dm_sent', 'failed'];

  it('opens on "Semua", and "Semua" filters nothing out', async () => {
    const src = await source();

    expect(src).toMatch(/const filter = params\.get\('f'\) \?\? 'semua';/);
    expect(src).toMatch(/key: 'semua'[^\n]*\n\s*\{ key: 'perlu'[^\n]*\n\s*\{ key: 'selesai'/);
    // Anything that is neither 'perlu' nor 'selesai' keeps every item, in the
    // flat list and in the grouped Komentar Facebook view alike.
    expect(src).toMatch(/filter === 'perlu' \? itemNeedsReply\(i\)\s*: filter === 'selesai' \? itemIsDone\(i\)\s*: true/);
    expect(src).toMatch(/filter === 'perlu' \? g\.needsReply\s*: filter === 'selesai' \? !g\.needsReply\s*: true/);
  });

  it('shows a new comment under "Semua" and "Perlu dibalas", hides it only under "Selesai"', async () => {
    const src = await source();
    const needsReply = statusesIn(src, 'itemNeedsReply');
    const done = statusesIn(src, 'itemIsDone');
    // The component's flat-list filter, rebuilt from its own status lists.
    const visibleUnder = (tab: string, status: string) =>
      tab === 'perlu' ? needsReply.includes(status) : tab === 'selesai' ? done.includes(status) : true;

    expect(visibleUnder('semua', 'new')).toBe(true);
    expect(visibleUnder('perlu', 'new')).toBe(true);
    expect(visibleUnder('selesai', 'new')).toBe(false);
  });

  it('keeps a post with a new comment on the grouped tab under "Semua" and "Perlu", not "Selesai"', () => {
    const [group] = groupCommentsByPost(overTheWire([
      row({ status: 'dm_sent' }),
      row({ status: 'new', commentedAt: null, createdAt: new Date('2026-09-25T10:05:00.000Z') }),
    ]));
    // The grouped tab's filter: perlu -> needsReply, selesai -> !needsReply.
    const visibleUnder = (tab: string) =>
      tab === 'perlu' ? group!.needsReply : tab === 'selesai' ? !group!.needsReply : true;

    expect(visibleUnder('semua')).toBe(true);
    expect(visibleUnder('perlu')).toBe(true);
    expect(visibleUnder('selesai')).toBe(false);
  });

  it('agrees between the flat list and the grouped view on which statuses are waiting', async () => {
    // Two copies of the same list (the component's and inbox.ts's) — if they
    // drift, a comment waits in one view and not in the other.
    const needsReply = statusesIn(await source(), 'itemNeedsReply');

    for (const status of ALL_STATUSES) {
      const [group] = groupCommentsByPost(overTheWire([row({ status: status as FacebookCommentRow['status'] })]));
      expect(group!.needsReply, status).toBe(needsReply.includes(status));
    }
  });
});

describe('a reply to a comment', () => {
  const parent = row({
    postId: POST_A, status: 'public_replied', authorName: 'Gabe',
    commentedAt: new Date('2026-09-25T06:00:00.000Z'),
  });
  const reply = row({
    postId: POST_A, status: 'new', authorName: 'Rudi', body: 'iya kak, saya juga mau',
    parentCommentId: parent.commentId,
    commentedAt: null, createdAt: new Date('2026-09-25T09:00:00.000Z'),
  });

  it('is shown under its post, beside the comment it answers', () => {
    const comments = overTheWire([reply, parent]);
    const groups = facebookCommentTab(toInboxItems([], comments));

    expect(groups).toHaveLength(1);
    expect(groups[0]!.postId).toBe(POST_A);
    expect(groups[0]!.comments.map((c) => c.id)).toEqual([parent.id, reply.id]);
    // Carried through untouched, not flattened away by the view-model.
    expect(groups[0]!.comments[1]!.parentCommentId).toBe(parent.commentId);
    expect(groups[0]!.needsReply).toBe(true);
  });

  it('is still shown under its post when the parent is not in the list', () => {
    // The parent can be missing: the bridge drops the Page's own comments
    // before they reach the CRM, and an old parent can fall outside the
    // list's window. The reply must not vanish with it.
    const orphan = row({
      postId: POST_B, status: 'new', parentCommentId: '1220999999999999',
      commentedAt: null, createdAt: new Date('2026-09-25T09:30:00.000Z'),
    });
    const items = toInboxItems([], overTheWire([orphan]));
    const groups = facebookCommentTab(items);

    expect(items.map((i) => i.id)).toEqual([orphan.id]);
    expect(groups.map((g) => g.postId)).toEqual([POST_B]);
    expect(groups[0]!.comments.map((c) => c.id)).toEqual([orphan.id]);
    expect(inboxHref(items[0]!)).toBe(`/obrolan/komentar/${POST_B}`);
  });

  it('is grouped by its own post, never by where its parent id points', () => {
    // Grouping is by postId alone. Even a parent id that happens to match a
    // comment on a different post does not pull the reply across.
    const elsewhere = row({
      postId: POST_B, status: 'new', parentCommentId: parent.commentId,
      commentedAt: null, createdAt: new Date('2026-09-25T09:45:00.000Z'),
    });
    const groups = facebookCommentTab(toInboxItems([], overTheWire([elsewhere, reply, parent])));

    expect(groups.find((g) => g.postId === POST_A)!.comments.map((c) => c.id)).toEqual([parent.id, reply.id]);
    expect(groups.find((g) => g.postId === POST_B)!.comments.map((c) => c.id)).toEqual([elsewhere.id]);
  });
});
