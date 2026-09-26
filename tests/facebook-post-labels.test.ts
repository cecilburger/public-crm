import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FacebookCommentRow } from '@kirana/db';
import { parseFacebookComments } from '../apps/fb-bridge/src/parsers/comments.ts';
import { postTimeFromLabel, POST_CAPTION_MAX } from '../apps/fb-bridge/src/parsers/postDetails.ts';
import { CommentWatcher, type PostDetailsUpdate } from '../apps/fb-bridge/src/commentWatcher.ts';
import { createCrmClient } from '../apps/fb-bridge/src/crmClient.ts';
import { groupCommentsByPost } from '../apps/console/lib/inbox.ts';
import {
  POST_TITLE_MAX, captionTitle, detailSubtitle, listMeta, postHeading,
} from '../apps/console/lib/facebookPost.ts';

/**
 * A Facebook comment group names the POST it belongs to — its caption, its
 * date — instead of Facebook's `pfbid…` slug, which no agent can read.
 *
 * Measured live, 2026-09-26: every post on the Page timeline (and on a post's
 * own permalink dialog) carries its caption in
 * `data-ad-rendering-role="story_message"`, and its age only as the relative
 * text of its own permalink link ("2 days ago"). There is no absolute date in
 * the markup, and the thumbnail is a signed CDN URL that expires (`oe=`), so it
 * is not stored.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name: string) => readFile(join(ROOT, 'tests/fixtures/facebook', name), 'utf8');
const source = (path: string) => readFile(join(ROOT, path), 'utf8');

const PAGE = { pageId: '90000000000009', pageName: 'Toko Uji' };
const POST_A = 'pfbid0PostAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POST_B = 'pfbid0PostBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const POST_C = 'pfbid0PostCcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
/** 12:00 in Jakarta, the bridge's own clock when these were read. */
const NOW = new Date('2026-09-26T05:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const before = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
/** A wall-clock time on the bridge's own machine — the zone Facebook renders its dates in. */
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

const LONG_CAPTION_SEEN = 'Nikmati hiburan favorit dan kumpulkan reward setiap hari 🎉\n'
  + 'Berlaku sampai akhir bulan. Syarat dan ketentuan berlaku';

/* ------------------------------------------------------------ the parser */

describe("a post's caption and age, read off the live timeline", () => {
  it("takes each post's own caption, never the comment of a customer under it", async () => {
    const { postDetails } = parseFacebookComments(await fixture('page-timeline-captions-live.html'), { ...PAGE, now: NOW });

    expect(postDetails[POST_A]?.text).toBe('Promo akhir pekan');
    expect(JSON.stringify(postDetails)).not.toContain('Masih ada kak');
  });

  it('keeps every line of a long caption and its emoji, and drops the "See more" cut', async () => {
    const { postDetails } = parseFacebookComments(await fixture('page-timeline-captions-live.html'), { ...PAGE, now: NOW });

    expect(postDetails[POST_B]?.text).toBe(LONG_CAPTION_SEEN);
  });

  it('dates each post from its own permalink link, and has no caption for a photo-only post', async () => {
    const { postDetails } = parseFacebookComments(await fixture('page-timeline-captions-live.html'), { ...PAGE, now: NOW });

    expect(postDetails).toEqual({
      [POST_A]: { text: 'Promo akhir pekan', createdAt: before(2 * DAY) },
      [POST_B]: { text: LONG_CAPTION_SEEN, createdAt: before(23 * HOUR) },
      [POST_C]: { text: null, createdAt: before(3 * DAY) },
    });
  });

  it("reads the whole caption off a post's own permalink dialog, where Facebook does not cut it", () => {
    const dialog = `<div role="dialog" aria-modal="true"><div role="article">
      <a aria-label="23 hours ago" href="https://www.facebook.com/permalink.php?story_fbid=${POST_B}&amp;id=${PAGE.pageId}" role="link"><span>23 hours ago</span></a>
      <div data-ad-rendering-role="story_message"><div data-ad-preview="message"><span dir="auto">
        <div dir="auto">Nikmati hiburan favorit dan kumpulkan reward setiap hari <img alt="🎉" src="x.png"></div>
        <div dir="auto">Berlaku sampai akhir bulan. Syarat dan ketentuan berlaku.</div>
        <div dir="auto">Info lebih lanjut hubungi admin.</div>
      </span></div></div>
      <div role="article" aria-label="Comment by Sinta 1 hour ago">
        <a href="https://www.facebook.com/profile.php?id=90000000000018&amp;comment_id=9000000000000401">Sinta</a>
        <div dir="auto">Info dong</div></div></div></div>`;

    const { postDetails } = parseFacebookComments(dialog, { ...PAGE, defaultPostId: POST_B, now: NOW });

    expect(postDetails[POST_B]?.text).toBe('Nikmati hiburan favorit dan kumpulkan reward setiap hari 🎉\n'
      + 'Berlaku sampai akhir bulan. Syarat dan ketentuan berlaku.\nInfo lebih lanjut hubungi admin.');
  });

  it('keeps a caption to a bounded length', () => {
    const html = `<div role="feed"><div role="article">
      <a aria-label="1 hour ago" href="https://www.facebook.com/permalink.php?story_fbid=${POST_A}&amp;id=${PAGE.pageId}">1h</a>
      <div data-ad-rendering-role="story_message"><div dir="auto">${'kata '.repeat(2_000)}</div></div></div></div>`;

    const text = parseFacebookComments(html, { ...PAGE, now: NOW }).postDetails[POST_A]?.text ?? '';

    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(POST_CAPTION_MAX);
  });
});

describe("a post's age, from the words Facebook shows for it", () => {
  const cases: Array<[string, string | null]> = [
    ['Just now', NOW.toISOString()],
    ['5m', before(5 * 60_000)],
    ['5 mins', before(5 * 60_000)],
    ['12 minutes ago', before(12 * 60_000)],
    ['3h', before(3 * HOUR)],
    ['23 hours ago', before(23 * HOUR)],
    ['1 hour ago', before(HOUR)],
    ['2d', before(2 * DAY)],
    ['2 days ago', before(2 * DAY)],
    ['1w', before(7 * DAY)],
    ['2 weeks ago', before(14 * DAY)],
    ['Yesterday at 3:14 PM', local(2026, 9, 25, 15, 14)],
    ['Yesterday', local(2026, 9, 25)],
    ['September 20 at 3:14 PM', local(2026, 9, 20, 15, 14)],
    ['September 20', local(2026, 9, 20)],
    ['Sep 20', local(2026, 9, 20)],
    ['September 20, 2025', local(2025, 9, 20)],
    ['20 September 2025', local(2025, 9, 20)],
    // A date with no year that would lie in the future is last year's.
    ['December 30', local(2025, 12, 30)],
    ['Baru saja', NOW.toISOString()],
    ['5 mnt', before(5 * 60_000)],
    ['3 jam', before(3 * HOUR)],
    ['2 hari', before(2 * DAY)],
    ['2 hari yang lalu', before(2 * DAY)],
    ['1 mgg', before(7 * DAY)],
    ['Kemarin pukul 15.14', local(2026, 9, 25, 15, 14)],
    ['20 September pukul 15.14', local(2026, 9, 20, 15, 14)],
    ['20 Agustus 2025', local(2025, 8, 20)],
    // Day first with no year and no time — how a post older than a week reads.
    ['20 September', local(2026, 9, 20)],
    ['20 Agustus', local(2026, 8, 20)],
    ['3 Jan', local(2026, 1, 3)],
    ['25 Des', local(2025, 12, 25)],
    // Anything else is no date at all, never a guess.
    ['Sponsored', null],
    ['Public', null],
    ['', null],
    ['31 Februari', null],
    ['99 years ago', null],
  ];

  it.each(cases)('reads %j', (label, expected) => {
    expect(postTimeFromLabel(label, NOW)).toBe(expected);
  });
});

/* ------------------------------------------------------ the sweep, sending */

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const MARKER = { ...PAGE, tenantId: '11111111-1111-4111-8111-111111111111' };

/** A timeline post as the live Page renders it, with a caption and a relative age. */
const timelinePost = (postId: string, caption: string | null, age: string, count: number) => `<div role="article">
  <a aria-label="${age}" href="https://www.facebook.com/permalink.php?story_fbid=${postId}&amp;id=${PAGE.pageId}" role="link"><span>${age}</span></a>
  ${caption === null ? '' : `<div data-ad-rendering-role="story_message"><div dir="auto">${caption}</div></div>`}
  <div role="button" tabindex="0"><span dir="auto"><span>${count} comments</span></span></div></div>`;

function livePage(state: { posts: Array<{ id: string; caption: string | null; age: string; count: number }> }) {
  let at = '';
  return {
    url: vi.fn(() => at),
    isClosed: vi.fn(() => false),
    browser: vi.fn(() => ({ isConnected: () => true })),
    on: vi.fn(),
    close: vi.fn(async () => {}),
    goto: vi.fn(async (url: string) => { at = url; return null; }),
    waitForSelector: vi.fn(async () => null),
    createCDPSession: vi.fn(async () => ({ send: vi.fn(async () => {}), detach: vi.fn(async () => {}) })),
    evaluate: vi.fn(async (script: unknown) => {
      const src = String(script);
      if (src === '1') return 1;
      if (src.includes('visibilityState')) return 'visible';
      if (src.startsWith('window.scrollBy')) return undefined;
      const postId = /var postId = "([^"]+)"/.exec(src)?.[1];
      if (postId) {
        const post = state.posts.find((p) => p.id === postId)!;
        return `<div role="article">${timelinePost(post.id, post.caption, post.age, post.count)}</div>`;
      }
      if (src.includes('var selectors')) {
        return `<div role="feed">${state.posts.map((p) => timelinePost(p.id, p.caption, p.age, p.count)).join('')}</div>`;
      }
      throw new Error(`unexpected script: ${src.slice(0, 60)}`);
    }),
  };
}

const sessionsWith = (tabs: unknown[]) => {
  const queue = [...tabs];
  return {
    getPageMarker: async () => MARKER,
    newPage: vi.fn(async () => queue.shift() ?? null),
    getActivePage: vi.fn(async () => null),
    assertUsable: vi.fn(async () => {}),
    forgetSession: vi.fn(),
    knownSessionKeys: async () => ['k1'],
  };
};

describe("the sweep handing each post's caption and age to the CRM", () => {
  afterEach(() => { vi.useRealTimers(); });

  const run = async (watcher: CommentWatcher, trigger: 'startup' | 'pulse') => {
    const done = watcher.sweep('k1', trigger);
    await vi.runAllTimersAsync();
    return done;
  };

  it('sends each post once, and again only when its caption changes or the CRM did not take it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Three posts, the most a sweep reads, so discovery reads the timeline once
    // at NOW rather than scrolling on for more (each scroll waits two seconds).
    const state = {
      posts: [
        { id: POST_A, caption: 'Promo akhir pekan', age: '2 days ago', count: 0 },
        { id: POST_B, caption: 'Drama baru', age: '23 hours ago', count: 0 },
        { id: POST_C, caption: null, age: '3 days ago', count: 0 },
      ],
    };
    const sent: Array<{ sessionKey: string; pageId: string; posts: PostDetailsUpdate[] }> = [];
    let accept = true;
    const watcher = new CommentWatcher(
      sessionsWith([livePage(state), livePage(state)]) as never, () => true, log(), async () => new Set(),
      async (sessionKey, pageId, posts) => { sent.push({ sessionKey, pageId, posts }); return accept; },
    );

    await run(watcher, 'startup');
    expect(sent).toEqual([{
      sessionKey: 'k1', pageId: PAGE.pageId, posts: [
        { postId: POST_A, text: 'Promo akhir pekan', createdAt: before(2 * DAY) },
        { postId: POST_B, text: 'Drama baru', createdAt: before(23 * HOUR) },
        { postId: POST_C, text: null, createdAt: before(3 * DAY) },
      ],
    }]);

    // A minute later nothing changed — "2 days ago" now reads a minute later,
    // which is no better an age — so nothing is sent.
    vi.setSystemTime(NOW.getTime() + 60_000);
    await run(watcher, 'pulse');
    expect(sent).toHaveLength(1);

    // The Page edits one caption: that post alone goes again.
    state.posts[0]!.caption = 'Promo akhir pekan — diperpanjang';
    accept = false;
    await run(watcher, 'pulse');
    expect(sent.at(-1)?.posts).toEqual([
      { postId: POST_A, text: 'Promo akhir pekan — diperpanjang', createdAt: expect.any(String) },
    ]);

    // The CRM refused it, so the next minute offers it again.
    accept = true;
    await run(watcher, 'pulse');
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)?.posts.map((p) => p.postId)).toEqual([POST_A]);
    await run(watcher, 'pulse');
    expect(sent).toHaveLength(3);
  });

  it('never lets a failure to send post details stop the comments themselves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const state = { posts: [{ id: POST_A, caption: 'Promo', age: '1h', count: 0 }] };
    const watcher = new CommentWatcher(
      sessionsWith([livePage(state)]) as never, () => true, log(), async () => new Set(),
      async () => { throw new Error('kirana api unreachable'); },
    );

    await expect(run(watcher, 'startup')).resolves.toMatchObject({ posts: 1 });
  });
});

describe('the bridge client, posting post details', () => {
  const posts: PostDetailsUpdate[] = [{ postId: POST_A, text: 'Promo akhir pekan', createdAt: before(2 * DAY) }];

  it('names the session, its tenant and the Page, on the internal channel with the shared secret', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createCrmClient({
      apiUrl: 'http://api.test', secret: 's3cret', tenantOf: async () => MARKER.tenantId, log: log(),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ stored: 1 }), { status: 200 });
      }) as typeof fetch,
    });

    expect(await client.recordPostDetails('k1', PAGE.pageId, posts)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api.test/v1/webhooks/fb-bridge/posts');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer s3cret');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      tenantId: MARKER.tenantId, sessionKey: 'k1', pageId: PAGE.pageId, posts,
    });
  });

  it('answers false when the CRM refuses or cannot be reached, and sends nothing for no posts', async () => {
    const refusing = createCrmClient({
      apiUrl: 'http://api.test', secret: 's', tenantOf: async () => MARKER.tenantId, log: log(),
      fetch: (async () => new Response('', { status: 400 })) as unknown as typeof fetch,
    });
    const down = createCrmClient({
      apiUrl: 'http://api.test', secret: 's', tenantOf: async () => MARKER.tenantId, log: log(),
      fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    const fetchSpy = vi.fn();
    const idle = createCrmClient({
      apiUrl: 'http://api.test', secret: 's', tenantOf: async () => MARKER.tenantId, log: log(),
      fetch: fetchSpy as unknown as typeof fetch,
    });

    expect(await refusing.recordPostDetails('k1', PAGE.pageId, posts)).toBe(false);
    expect(await down.recordPostDetails('k1', PAGE.pageId, posts)).toBe(false);
    expect(await idle.recordPostDetails('k1', PAGE.pageId, [])).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------ the console */

type OverTheWire<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};
type ApiComment = OverTheWire<FacebookCommentRow>;
const overTheWire = (rows: FacebookCommentRow[]): ApiComment[] =>
  (JSON.parse(JSON.stringify({ comments: rows })) as { comments: ApiComment[] }).comments;

let seq = 0;
const row = (over: Partial<FacebookCommentRow> = {}): FacebookCommentRow => {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    id: `00000000-0000-4000-8000-00000000${n}`,
    divisionId: '11111111-1111-4111-8111-111111111111',
    pageId: PAGE.pageId, pageName: PAGE.pageName, postId: POST_A,
    commentId: `12203456789${n}`, parentCommentId: null,
    authorExternalId: null, authorName: 'Gabe', body: 'rt tes',
    commentedAt: new Date('2026-09-26T03:00:00.000Z'), createdAt: new Date('2026-09-26T03:00:05.000Z'),
    status: 'new', publicReplyAt: null, publicReplyError: null, dmAt: null, dmError: null, attempts: 0,
    postText: 'Drama baru', postCreatedAt: new Date('2026-09-26T05:00:00.000Z'),
    ...over,
  };
};

describe('the post a comment group is named after', () => {
  it("is the post's caption, with its date beside the comment count", () => {
    const [group] = groupCommentsByPost(overTheWire([row(), row()]));
    const list = postHeading(group!.post, { max: POST_TITLE_MAX.list, dateStyle: 'short' });
    const detail = postHeading(group!.post, { max: POST_TITLE_MAX.detail, dateStyle: 'long' });

    expect(list.title).toBe('Drama baru');
    expect(listMeta(list, group!.comments.length)).toBe('2 komentar · 26 Sep');
    expect(detail.title).toBe('Drama baru');
    expect(detailSubtitle(detail, 9)).toBe('Facebook · 26 Sep 2026 · 9 komentar');
  });

  it('cuts a long caption at a word, marks the cut, and keeps the whole caption for the detail view', () => {
    const caption = 'Nikmati hiburan favorit dan kumpulkan reward setiap hari di aplikasi kami\nBerlaku sampai akhir bulan';
    const [group] = groupCommentsByPost(overTheWire([row({ postText: caption })]));

    const list = postHeading(group!.post, { max: POST_TITLE_MAX.list, dateStyle: 'short' });
    const detail = postHeading(group!.post, { max: POST_TITLE_MAX.detail, dateStyle: 'long' });

    expect(list.title).toBe('Nikmati hiburan favorit dan kumpulkan reward setiap hari di…');
    expect(Array.from(list.title).length).toBeLessThanOrEqual(POST_TITLE_MAX.list);
    expect(list.truncated).toBe(true);
    expect(detail.title).toBe('Nikmati hiburan favorit dan kumpulkan reward setiap hari di aplikasi kami Berlaku sampai akhir bulan');
    expect(detail.truncated).toBe(false);
    expect(detail.fullText).toBe(caption);
  });

  it('never splits an emoji, and cuts a caption with no space in it at the limit', () => {
    expect(captionTitle(`${'🎉'.repeat(80)}`, 10)).toEqual({ title: `${'🎉'.repeat(9)}…`, truncated: true });
    expect(captionTitle('x'.repeat(100), 20)).toEqual({ title: `${'x'.repeat(19)}…`, truncated: true });
  });

  it('is "Postingan Facebook", with the date, when the post has no caption', () => {
    const [group] = groupCommentsByPost(overTheWire([row({ postText: null }), row({ postText: '  \n ' })]));
    const detail = postHeading(group!.post, { max: POST_TITLE_MAX.detail, dateStyle: 'long' });

    expect(detail.title).toBe('Postingan Facebook');
    expect(detail.date).toBe('26 Sep 2026');
    expect(detailSubtitle(detail, 3)).toBe('26 Sep 2026 · 3 komentar');
  });

  it('still renders a row stored before post details existed — no caption, no date', () => {
    const legacy = overTheWire([row({ postText: null, postCreatedAt: null })])
      .map(({ postText: _t, postCreatedAt: _d, ...rest }) => rest);
    const [group] = groupCommentsByPost(legacy);
    const list = postHeading(group!.post, { max: POST_TITLE_MAX.list, dateStyle: 'short' });

    expect(group!.post).toEqual({ text: null, createdAt: null });
    expect(list.title).toBe('Postingan Facebook');
    expect(listMeta(list, 1)).toBe('1 komentar');
  });

  it("never shows Facebook's post id as the name of a post", async () => {
    for (const over of [{}, { postText: null }, { postText: null, postCreatedAt: null }]) {
      const [group] = groupCommentsByPost(overTheWire([row(over)]));
      for (const dateStyle of ['short', 'long'] as const) {
        const heading = postHeading(group!.post, { max: POST_TITLE_MAX.detail, dateStyle });
        expect(heading.title).not.toContain('pfbid');
        expect(detailSubtitle(heading, 1)).not.toContain('pfbid');
      }
    }
    // And the components no longer render the slug as the post's name.
    const list = await source('apps/console/components/ConversationList.tsx');
    const thread = await source('apps/console/components/CommentPostThread.tsx');
    const copy = await source('apps/console/lib/copy.ts');
    expect(list).not.toMatch(/postLabel\(/);
    expect(thread).not.toMatch(/postLabel\(/);
    expect(copy).not.toMatch(/Postingan \$\{postId\}/);
    expect(list).toMatch(/postHeading\(group\.post/);
    expect(thread).toMatch(/postHeading\(/);
  });

  it('takes the earliest age any comment carries, and a caption from whichever comment has one', () => {
    const [group] = groupCommentsByPost(overTheWire([
      row({ postText: null, postCreatedAt: new Date('2026-09-26T05:00:00.000Z') }),
      row({ postText: 'Drama baru', postCreatedAt: new Date('2026-09-24T05:00:00.000Z') }),
    ]));

    expect(group!.post).toEqual({ text: 'Drama baru', createdAt: '2026-09-24T05:00:00.000Z' });
  });

  it("still previews the newest comment, whatever the post's details say", () => {
    const [group] = groupCommentsByPost(overTheWire([
      row({ authorName: 'Gabe', body: 'rt tes 12', commentedAt: new Date('2026-09-26T04:00:00.000Z') }),
      row({ authorName: 'Sinta', body: 'rt tes 3', commentedAt: new Date('2026-09-26T01:00:00.000Z'), postText: 'lama' }),
    ]));
    const latest = group!.comments[group!.comments.length - 1]!;

    expect(`${latest.authorName}: ${latest.body}`).toBe('Gabe: rt tes 12');
    expect(group!.latestAt).toBe('2026-09-26T04:00:00.000Z');
  });
});
