import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFacebookComments, type ParsedComment } from '../apps/fb-bridge/src/parsers/comments.ts';
import { parseHtml, queryAll } from '../apps/fb-bridge/src/parsers/dom.ts';
import { selectPostSurfaceHtml } from '../apps/fb-bridge/src/pageHtml.ts';
import { CommentWatcher, SWEEP_INTERVAL_MS } from '../apps/fb-bridge/src/commentWatcher.ts';
import { createCrmClient } from '../apps/fb-bridge/src/crmClient.ts';
import type { FbBridgeEvent } from '../apps/fb-bridge/src/events.ts';

/**
 * The Facebook comment sweep against the markup the live Page renders today.
 *
 * The two fixtures are minimised from real snapshots taken on 2026-09-25 —
 * roles, labels, link shapes and nesting exactly as served, every id and name
 * synthetic. They exist because every earlier fixture here was hand-written
 * and still passed while the live sweep read `posts: 0` for a day.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'facebook');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');

const PAGE = { pageId: '90000000000009', pageName: 'Toko Uji' };
const CUSTOMER = { id: '900000000000018', name: 'Sinta' };
/** Comment ids as the fixtures carry them (decoded from the base64 permalinks). */
const IDS = {
  pageTopComment: '90000000000000002',
  customerOnPost2: '9000000000000004',
  pageReplyOnPost2: '9000000000000005',
  customerOnPost3: '9000000000000007',
  pageReplyOnPost3: '9000000000000008',
};

const b64Id = (post: string, comment: string) =>
  encodeURIComponent(Buffer.from(`comment:${post}_${comment}`, 'utf8').toString('base64'));

/* ------------------------------------------------------------ fixtures */

describe('the live fixtures', () => {
  it('carry no real identity: synthetic ids, synthetic accounts, no tracking parameters', async () => {
    const routes = new Set([
      'ad_center', 'business', 'help', 'permalink.php', 'photo', 'policies', 'privacy', 'professional_dashboard',
      'profile.php', 'stories', 'watch', 'latest', 'notifications', 'akunlain0',
    ]);
    for (const name of ['page-timeline-live.html', 'post-permalink-live.html']) {
      const html = await fixture(name);
      for (const id of html.match(/\d{12,}/g) ?? []) expect(id, `${name}: ${id}`).toMatch(/^9/);
      for (const [, slug] of html.matchAll(/facebook\.com\/([A-Za-z0-9._]+)/g)) {
        expect(routes.has(slug!) || /^9\d+$/.test(slug!), `${name}: facebook.com/${slug}`).toBe(true);
      }
      for (const [slug] of html.matchAll(/pfbid0[A-Za-z0-9]+/g)) expect(slug).toMatch(/^pfbid0Test/);
      expect(html).not.toMatch(/__cft__|__tn__|notif_t=/);
    }
  });
});

/* ---------------------------------------------------------- the timeline */

describe('reading the live Page timeline', () => {
  it('finds all three posts and the customers\' comments under Facebook\'s own ids', async () => {
    const parsed = parseFacebookComments(await fixture('page-timeline-live.html'), PAGE);

    expect(parsed.postIds).toHaveLength(3);
    for (const id of parsed.postIds) expect(id).toMatch(/^pfbid0Test0\d/);
    expect(parsed.postArticles).toBe(3);
    expect(parsed.postArticlesWithoutId).toBe(0);
    expect(parsed.droppedNoId).toBe(0);
    expect(parsed.comments.map((c) => c.commentId)).toEqual([IDS.customerOnPost2, IDS.customerOnPost3]);
    for (const c of parsed.comments) {
      expect(c).toMatchObject({ authorId: CUSTOMER.id, authorName: CUSTOMER.name, parentCommentId: null });
      expect(parsed.postIds).toContain(c.postId);
    }
    expect(parsed.comments[0]!.text).toBe('mau tanya jasa ini dong');
  });

  it('never takes the Page\'s own comment or its replies for a customer', async () => {
    const html = await fixture('page-timeline-live.html');
    const withPage = parseFacebookComments(html, PAGE);
    const unfiltered = parseFacebookComments(html);

    // They are on the page — the Page's first comment and both its replies…
    expect(unfiltered.comments.filter((c) => c.authorId === PAGE.pageId).map((c) => c.commentId))
      .toEqual([IDS.pageTopComment, IDS.pageReplyOnPost2, IDS.pageReplyOnPost3]);
    // …and none of them is ever offered as a customer's.
    expect(withPage.droppedPageOwn).toBe(3);
    expect(withPage.comments.some((c) => c.authorId === PAGE.pageId)).toBe(false);
  });

  it('keeps a reply\'s own id and names the comment it answers', async () => {
    const replies = parseFacebookComments(await fixture('page-timeline-live.html')).comments
      .filter((c) => c.parentCommentId !== null);

    expect(replies.map((c) => [c.commentId, c.parentCommentId])).toEqual([
      [IDS.pageReplyOnPost2, IDS.customerOnPost2],
      [IDS.pageReplyOnPost3, IDS.customerOnPost3],
    ]);
  });

  it('files a customer\'s reply under the comment it answers', async () => {
    // The live Page had only its own replies; one becomes a customer's here,
    // by its author link and name, with the rest of the markup untouched.
    const root = parseHtml(await fixture('page-timeline-live.html'));
    for (const a of queryAll(root, ['a[href]'])) {
      const href = a.getAttribute('href') ?? '';
      const encoded = /comment_id=([^&]+)/.exec(href)?.[1];
      const plain = encoded ? Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8') : '';
      if (!href.includes(`id=${PAGE.pageId}`) || !plain.endsWith(`_${IDS.pageReplyOnPost2}`)) continue;
      a.setAttribute('href', href.replace(`id=${PAGE.pageId}`, 'id=900000000000077'));
      if (a.text.trim() === PAGE.pageName) a.set_content('Rina');
    }

    const reply = parseFacebookComments(root.toString(), PAGE).comments
      .find((c) => c.commentId === IDS.pageReplyOnPost2);

    expect(reply).toMatchObject({
      authorId: '900000000000077', authorName: 'Rina', parentCommentId: IDS.customerOnPost2,
    });
  });

  it('reads the Indonesian interface the same way', async () => {
    const english = await fixture('page-timeline-live.html');
    const indonesian = english
      .replace(/aria-label="Comment by ([^"]+?) (\d+ \w+ ago|a day ago|a few seconds ago)"/g, 'aria-label="Komentar oleh $1 $2"')
      .replace(/aria-label="Reply by ([^"]+?) to ([^"]+?)'s comment([^"]*)"/g, 'aria-label="Balasan dari $1 untuk komentar $2$3"')
      .replace(/>Like</g, '>Suka<').replace(/>Reply</g, '>Balas<').replace(/>Author</g, '>Penulis<');
    expect(indonesian).toContain('Komentar oleh Sinta');
    expect(indonesian).toContain('Balasan dari Toko Uji untuk komentar Sinta');
    expect(indonesian).not.toMatch(/aria-label="(Comment|Reply) by/);

    const en = parseFacebookComments(english, PAGE);
    const id = parseFacebookComments(indonesian, PAGE);

    expect(id.postIds).toEqual(en.postIds);
    expect(id.droppedPageOwn).toBe(3);
    const shape = (cs: ParsedComment[]) => cs.map((c) => [c.commentId, c.postId, c.authorId, c.authorName, c.text]);
    expect(shape(id.comments)).toEqual(shape(en.comments));
  });

  it('counts post-shaped placeholders as posts without a link, never as posts', () => {
    // What the feed paints before its data arrives — the state the old sweep
    // read, and recorded as "no posts".
    const placeholders = '<div role="main"><div role="article"><div></div></div><div role="article"><span></span></div></div>';

    const parsed = parseFacebookComments(placeholders, PAGE);

    expect(parsed).toMatchObject({ postIds: [], postArticles: 2, postArticlesWithoutId: 2, comments: [] });
  });
});

/* ----------------------------------------------------- who wrote it */

describe('who wrote a comment', () => {
  /**
   * Rewrites the author links of one comment (the anchors carrying that
   * comment's own id) to `authorHref`, optionally renaming them and putting a
   * mention into its text — the live markup otherwise untouched.
   */
  async function rewrite(commentId: string, change: { authorHref: string; name?: string; mention?: string }) {
    const root = parseHtml(await fixture('page-timeline-live.html'));
    for (const a of queryAll(root, ['a[href]'])) {
      const href = a.getAttribute('href') ?? '';
      const encoded = /comment_id=([^&]+)/.exec(href)?.[1];
      const plain = encoded ? Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8') : '';
      if (!plain.endsWith(`_${commentId}`) || /story_fbid=/.test(href)) continue;
      a.setAttribute('href', `${change.authorHref}?comment_id=${encoded}`);
      if (change.name && a.text.trim()) a.set_content(change.name);
    }
    if (change.mention) {
      const article = queryAll(root, ['div[role="article"]']).find((el) =>
        el.querySelectorAll('a').some((a) => (a.getAttribute('href') ?? '').includes(`comment_id=${commentId}`)));
      const text = article!.querySelector('div[dir="auto"]')!;
      text.set_content(`${change.mention} ${text.text}`);
    }
    return root.toString();
  }
  const pageTag = `<a href="https://www.facebook.com/profile.php?id=${PAGE.pageId}">${PAGE.pageName}</a>`;

  it('keeps a customer with a username who tags the Page, under their own name', async () => {
    const html = await rewrite(IDS.customerOnPost2, { authorHref: 'https://www.facebook.com/sinta.uji', mention: pageTag });

    const parsed = parseFacebookComments(html, PAGE);
    const comment = parsed.comments.find((c) => c.commentId === IDS.customerOnPost2);

    expect(comment).toMatchObject({ authorId: null, authorName: CUSTOMER.name });
    expect(parsed.droppedPageOwn).toBe(3);
  });

  it('keeps a customer with a numeric profile who tags the Page', async () => {
    const html = await rewrite(IDS.customerOnPost2, {
      authorHref: `https://www.facebook.com/profile.php?id=${CUSTOMER.id}`, mention: pageTag,
    });

    const comment = parseFacebookComments(html, PAGE).comments.find((c) => c.commentId === IDS.customerOnPost2);

    expect(comment).toMatchObject({ authorId: CUSTOMER.id, authorName: CUSTOMER.name });
  });

  it('recognises the Page by a username link too, and never files its reply under the customer it tags', async () => {
    let html = await rewrite(IDS.pageTopComment, { authorHref: 'https://www.facebook.com/tokouji' });
    html = await (async () => {
      const once = html;
      const root = parseHtml(once);
      for (const a of queryAll(root, ['a[href]'])) {
        const href = a.getAttribute('href') ?? '';
        const encoded = /comment_id=([^&]+)/.exec(href)?.[1];
        const plain = encoded ? Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8') : '';
        if (plain.endsWith(`_${IDS.pageReplyOnPost2}`) && !/story_fbid=/.test(href)) {
          a.setAttribute('href', `https://www.facebook.com/tokouji?comment_id=${encoded}`);
        }
      }
      return root.toString();
    })();

    const parsed = parseFacebookComments(html, PAGE);

    expect(parsed.comments.map((c) => c.commentId)).not.toContain(IDS.pageTopComment);
    expect(parsed.comments.map((c) => c.commentId)).not.toContain(IDS.pageReplyOnPost2);
    expect(parsed.comments.some((c) => c.authorName.startsWith(PAGE.pageName))).toBe(false);
    expect(parsed.droppedPageOwn).toBe(3);
  });
});

/* ------------------------------------------------------ a single post */

describe('reading a post on its permalink', () => {
  it('reads the opened post from its modal, never from the feed behind it', async () => {
    const doc = await fixture('post-permalink-live.html');
    const postId = parseFacebookComments(await fixture('page-timeline-live.html'), PAGE).postIds[1]!;

    const surface = selectPostSurfaceHtml(doc, postId);
    const parsed = parseFacebookComments(surface!, { ...PAGE, defaultPostId: postId });

    expect(parsed.comments).toHaveLength(6);
    expect(parsed.comments.every((c) => c.postId === postId)).toBe(true);
    expect(parsed.comments.map((c) => c.authorName)).toContain('Budi Santoso');
    expect(new Set(parsed.comments.map((c) => c.commentId)).size).toBe(6);
    // Read feed-first, the same document yields none of the post's comments.
    expect(parseFacebookComments(doc, PAGE).comments).toEqual([]);
  });

  it('refuses a surface it cannot prove belongs to the post', async () => {
    const doc = await fixture('post-permalink-live.html');
    const [first, , third] = parseFacebookComments(await fixture('page-timeline-live.html'), PAGE).postIds;

    expect(selectPostSurfaceHtml(doc, first!)).toBeNull();
    expect(selectPostSurfaceHtml(doc, third!)).toBeNull();
    expect(selectPostSurfaceHtml(doc, 'pfbid0NotOnThisPage')).toBeNull();
  });
});

/* ---------------------------------------------------------- comment ids */

describe('a comment\'s id', () => {
  const comment = (href: string, label = 'Comment by Rina a day ago') =>
    `<div role="main"><div role="article" aria-label="${label}">`
    + `<a href="${href}">Rina</a><div dir="auto">halo kak</div></div></div>`;

  it('is decoded from the base64 permalink the live Page writes', () => {
    const html = comment(`https://www.facebook.com/profile.php?id=900000000000077&amp;comment_id=${b64Id('900000000000000001', '9000000000000099')}`);

    expect(parseFacebookComments(html, { ...PAGE, defaultPostId: 'pfbid0x' }).comments[0]!.commentId)
      .toBe('9000000000000099');
  });

  it('is the reply\'s own id when the link names both, never its parent\'s', () => {
    const html = comment(
      'https://www.facebook.com/permalink.php?story_fbid=pfbid0Abc&amp;id=90000000000009'
      + '&amp;comment_id=9000000000000004&amp;reply_comment_id=9000000000000098',
      "Reply by Rina to Sinta's comment a day ago",
    );

    expect(parseFacebookComments(html, PAGE).comments[0]).toMatchObject({
      commentId: '9000000000000098', parentCommentId: '9000000000000004', postId: 'pfbid0Abc',
    });
  });

  it('is never made up: a comment with no readable id is dropped and counted', () => {
    const html = comment('https://www.facebook.com/profile.php?id=900000000000077');

    const parsed = parseFacebookComments(html, { ...PAGE, defaultPostId: 'pfbid0x' });

    expect(parsed.comments).toEqual([]);
    expect(parsed.droppedNoId).toBe(1);
  });
});

/* ------------------------------------------------ schedule and delivery */

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const MARKER = { pageId: PAGE.pageId, pageName: PAGE.pageName, tenantId: '11111111-1111-4111-8111-111111111111' };

function parsed(commentId: string, parentCommentId: string | null = null): ParsedComment {
  return {
    commentId, postId: 'pfbid0Test02', parentCommentId, authorId: CUSTOMER.id, authorName: CUSTOMER.name,
    text: `komentar ${commentId}`, commentedAt: null,
  };
}

describe('when the comment sweep runs', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('sweeps once at startup without waiting, then on the interval, and at once after a login', async () => {
    vi.useFakeTimers();
    const sessions = { knownSessionKeys: async () => ['k1'] };
    const watcher = new CommentWatcher(sessions as never, () => true, log());
    const sweep = vi.spyOn(watcher, 'sweep').mockResolvedValue(null);
    // Full sweeps only: the once-a-minute pulses between them have their own test.
    const full = () => sweep.mock.calls.filter(([, trigger]) => trigger !== 'pulse');

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(full()).toEqual([['k1', 'startup']]);

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS - 1);
    expect(full()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(full()[1]).toEqual(['k1', 'interval']);

    watcher.onSessionReady('k2');
    expect(full()[2]).toEqual(['k2', 'ready']);
    watcher.stop();
  });
});

describe('a whole sweep against a Page that is still rendering', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** Blanks the given post articles, the way the live feed shows a post before its data arrives. */
  function hydrateOnly(html: string, keep: number): string {
    const root = parseHtml(html);
    const posts = queryAll(root, ['div[role="article"]'])
      .filter((a) => !/omment|omentar/i.test(a.getAttribute('aria-label') ?? ''));
    posts.forEach((post, i) => { if (i >= keep) post.set_content(''); });
    return root.toString();
  }

  function withoutComments(surface: string): string {
    const root = parseHtml(surface);
    for (const a of queryAll(root, ['div[role="article"]'])) {
      if (/omment|omentar/i.test(a.getAttribute('aria-label') ?? '')) a.remove();
    }
    return root.toString();
  }

  it('waits for post links, scrolls for the rest, reads each post once its comments settle, and hands them over', async () => {
    vi.useFakeTimers();
    const timeline = await fixture('page-timeline-live.html');
    const doc = await fixture('post-permalink-live.html');
    const postIds = parseFacebookComments(timeline, PAGE).postIds;
    const surface = selectPostSurfaceHtml(doc, postIds[1]!)!;

    let timelineReads = 0;
    let scrolls = 0;
    const surfaceReads = new Map<string, number>();
    const page = {
      goto: vi.fn(async () => null),
      waitForSelector: vi.fn(async () => null),
      close: vi.fn(async () => {}),
      evaluate: vi.fn(async (script: unknown) => {
        const src = String(script);
        if (src.startsWith('window.scrollBy')) { scrolls += 1; return undefined; }
        const postId = /var postId = "([^"]+)"/.exec(src)?.[1];
        if (postId) {
          const n = (surfaceReads.get(postId) ?? 0) + 1;
          surfaceReads.set(postId, n);
          if (postId !== postIds[1]) return null;              // not provably this post: refused
          return n === 1 ? withoutComments(surface) : surface;  // comments arrive a moment later
        }
        if (src.includes('var selectors')) {
          timelineReads += 1;
          if (scrolls > 0) return timeline;                               // scrolled: all hydrated
          return hydrateOnly(timeline, timelineReads === 1 ? 0 : 1);      // placeholders, then the first post
        }
        throw new Error(`unexpected script: ${src.slice(0, 60)}`);
      }),
    };
    const sessions = {
      getPageMarker: async () => MARKER, newPage: async () => page, assertUsable: async () => {},
      forgetSession: () => {}, knownSessionKeys: async () => ['k1'],
    };
    const events: FbBridgeEvent[] = [];
    const logger = log();
    const watcher = new CommentWatcher(sessions as never, (ev) => { events.push(ev); return true; }, logger, async () => new Set());

    const running = watcher.sweep('k1', 'manual');
    await vi.runAllTimersAsync();
    const summary = await running;

    expect(summary).toMatchObject({ posts: 3, fresh: 7, known: 0, rejected: 0 });
    const emitted = events.flatMap((e) => (e.event === 'comment' ? [e.comment.commentId] : []));
    expect(new Set(emitted).size).toBe(7);
    expect(emitted).toContain(IDS.customerOnPost3);
    expect(emitted).not.toContain(IDS.pageReplyOnPost2);

    const logged = (name: string) => logger.info.mock.calls.map(([f]) => f as Record<string, unknown>).filter((f) => f.event === name);
    // The evidence the live sweep now records: nothing at the old reading, everything after waiting.
    expect(logged('fb_posts_discovered')[0]).toMatchObject({
      count: 3, atFirstRead: { posts: 0, postArticles: 3, postArticlesWithoutId: 3 }, afterWait: { posts: 3 }, scrolls: 1,
    });
    const surfaces = logged('fb_post_surface_found');
    expect(surfaces.find((s) => s.postId === postIds[1])).toMatchObject({ found: true });
    expect((surfaces.find((s) => s.postId === postIds[1])!.reads as number)).toBeGreaterThan(2);
    expect(surfaces.filter((s) => s.postId !== postIds[1]).every((s) => s.found === false)).toBe(true);
    expect(page.close).toHaveBeenCalled();
  });

  // Live, 2026-09-26: 11 of 45 sweeps found 0 or 1 of the Page's 3 posts. Reproduced 3 of 3 by opening
  // another tab in the bridge's browser mid-discovery — what the inbox watcher does to read a thread.
  // The sweep's tab turns `visibilityState: hidden` and Facebook stops hydrating the post placeholders,
  // in view or not, for as long as it stays hidden; brought back to visible, both hydrate within 2s.
  it('discovers every recent post while another bridge tab is in front', async () => {
    vi.useFakeTimers();
    const timeline = await fixture('page-timeline-live.html');
    const postIds = parseFacebookComments(timeline, PAGE).postIds;

    // Another tab took the front before discovery began. Only a tab that still
    // renders as if in front gets the placeholders it scrolls to hydrated.
    let rendersInBackground = false;
    let hydrated = false;
    const page = {
      goto: vi.fn(async () => null),
      waitForSelector: vi.fn(async () => null),
      close: vi.fn(async () => {}),
      createCDPSession: vi.fn(async () => ({
        send: vi.fn(async (method: string, params?: { enabled?: boolean }) => {
          if (method === 'Emulation.setFocusEmulationEnabled') rendersInBackground = params?.enabled === true;
        }),
        detach: vi.fn(async () => {}),
      })),
      evaluate: vi.fn(async (script: unknown) => {
        const src = String(script);
        if (src.includes('visibilityState')) return rendersInBackground ? 'visible' : 'hidden';
        if (src.startsWith('window.scrollBy')) { if (rendersInBackground) hydrated = true; return undefined; }
        if (/var postId = "/.test(src)) return null;                     // no post surfaces needed here
        if (src.includes('var selectors')) return hydrated ? timeline : hydrateOnly(timeline, 1);
        throw new Error(`unexpected script: ${src.slice(0, 60)}`);
      }),
    };
    const sessions = {
      getPageMarker: async () => MARKER, newPage: async () => page, assertUsable: async () => {},
      forgetSession: () => {}, knownSessionKeys: async () => ['k1'],
    };
    const logger = log();
    const watcher = new CommentWatcher(sessions as never, () => true, logger, async () => new Set());

    const running = watcher.sweep('k1', 'interval');
    await vi.runAllTimersAsync();
    const summary = await running;

    expect(summary).toMatchObject({ posts: 3 });
    const discovered = logger.info.mock.calls.map(([f]) => f as Record<string, unknown>)
      .find((f) => f.event === 'fb_posts_discovered')!;
    expect(discovered).toMatchObject({ count: 3, postIds });
    // Every step on record, so a short sweep says exactly where it stalled and whether the tab was rendering.
    expect(discovered.steps).toEqual([
      expect.objectContaining({ step: 'first-read', posts: 1, postArticles: 3, postArticlesWithoutId: 2, visible: true }),
      expect.objectContaining({ step: 'scroll-1', posts: 3, postArticlesWithoutId: 0, visible: true }),
    ]);
  });
});

describe('the bridge\'s CRM client', () => {
  const COMMENT_EVENT: FbBridgeEvent = {
    event: 'comment', sessionKey: 'k1', at: '2026-09-25T00:00:00.000Z',
    comment: { ...parsed('c1', 'c0'), pageId: PAGE.pageId, pageName: PAGE.pageName },
  };

  function client(respond: () => Response | 'unreachable') {
    const calls: { url: string; body: Record<string, unknown>; auth: string | undefined }[] = [];
    const fetchStub = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      const answer = respond();
      if (answer === 'unreachable') throw new Error('connect ECONNREFUSED');
      return answer;
    };
    const crm = createCrmClient({
      apiUrl: 'http://crm.test', secret: 'shh', tenantOf: async () => MARKER.tenantId, log: log(),
      fetch: fetchStub as typeof fetch,
    });
    return { crm, calls };
  }

  it('reports a comment delivered only when the CRM accepted it', async () => {
    const ok = client(() => new Response('{"received":true}', { status: 200 }));
    expect(await ok.crm.postEvent(COMMENT_EVENT)).toBe(true);
    expect(ok.calls[0]).toMatchObject({
      url: 'http://crm.test/v1/webhooks/fb-bridge', auth: 'Bearer shh',
      body: { tenantId: MARKER.tenantId, event: 'comment', sessionKey: 'k1', comment: { commentId: 'c1', parentCommentId: 'c0' } },
    });

    for (const status of [400, 401, 500, 503]) {
      expect(await client(() => new Response('', { status })).crm.postEvent(COMMENT_EVENT), String(status)).toBe(false);
    }
    expect(await client(() => 'unreachable').crm.postEvent(COMMENT_EVENT)).toBe(false);
  });

  it('asks which comment ids are stored in the shape the CRM accepts, and treats any failure as "none"', async () => {
    const ok = client(() => Response.json({ known: [], knownComments: ['c1'] }));
    expect(await ok.crm.knownCommentIds('k1', ['c1', 'c2'])).toEqual(new Set(['c1']));
    expect(ok.calls).toEqual([{
      url: 'http://crm.test/v1/webhooks/fb-bridge/known', auth: 'Bearer shh',
      body: { tenantId: MARKER.tenantId, sessionKey: 'k1', externalIds: [], commentIds: ['c1', 'c2'] },
    }]);

    // Naming the post each comment was read under is how the CRM tells a
    // stored comment from one whose post Facebook has since renamed.
    const withPosts = client(() => Response.json({ known: [], knownComments: [] }));
    expect(await withPosts.crm.knownCommentIds('k1', ['c1'], { c1: 'pfbid0Renamed' })).toEqual(new Set());
    expect(withPosts.calls[0]!.body).toEqual({
      tenantId: MARKER.tenantId, sessionKey: 'k1', externalIds: [], commentIds: ['c1'], commentPosts: { c1: 'pfbid0Renamed' },
    });

    expect(await client(() => new Response('', { status: 400 })).crm.knownCommentIds('k1', ['c1'])).toEqual(new Set());
    expect(await client(() => 'unreachable').crm.knownCommentIds('k1', ['c1'])).toEqual(new Set());
    const none = client(() => Response.json({}));
    expect(await none.crm.knownCommentIds('k1', [])).toEqual(new Set());
    expect(none.calls).toEqual([]);
  });
});

describe('handing comments to the CRM', () => {
  it('offers each comment the CRM does not hold exactly once, with its parent and Page', async () => {
    const events: FbBridgeEvent[] = [];
    const watcher = new CommentWatcher({} as never, (ev) => { events.push(ev); return true; }, log(),
      async () => new Set(['c1']));

    const summary = await watcher.emitNew('k1', MARKER, [parsed('c1'), parsed('c2'), parsed('c2'), parsed('c3', 'c2')]);

    expect(summary).toEqual({ read: 3, known: 1, fresh: 2, rejected: 0 });
    expect(events.map((e) => (e.event === 'comment' ? e.comment.commentId : e.event))).toEqual(['c2', 'c3']);
    expect(events[1]).toMatchObject({
      event: 'comment', sessionKey: 'k1',
      comment: { commentId: 'c3', parentCommentId: 'c2', postId: 'pfbid0Test02', pageId: PAGE.pageId, pageName: PAGE.pageName },
    });
  });

  it('counts a comment the CRM refused as not delivered, so the next sweep offers it again', async () => {
    const offered: string[] = [];
    const stored = new Set<string>();
    const crmAccepts = (ev: FbBridgeEvent) => {
      if (ev.event !== 'comment') return false;
      offered.push(ev.comment.commentId);
      if (ev.comment.commentId === 'c2' && offered.length === 1) return false; // down the first time
      stored.add(ev.comment.commentId);
      return true;
    };
    const watcher = new CommentWatcher({} as never, crmAccepts, log(), async (_k, ids) =>
      new Set(ids.filter((id) => stored.has(id))));

    expect(await watcher.emitNew('k1', MARKER, [parsed('c2')])).toMatchObject({ fresh: 0, rejected: 1 });
    expect(await watcher.emitNew('k1', MARKER, [parsed('c2')])).toMatchObject({ fresh: 1, rejected: 0 });
    // A restart, or the next interval: the CRM holds it, so nothing is sent.
    expect(await watcher.emitNew('k1', MARKER, [parsed('c2')])).toMatchObject({ known: 1, fresh: 0 });
    expect(offered).toEqual(['c2', 'c2']);
  });

  it('offers a stored comment again when the CRM holds it under a post slug Facebook has since replaced', async () => {
    // What the CRM holds, by comment: filed under the slug the post had before.
    const stored = new Map([['c1', 'pfbid0Old']]);
    const offered: FbBridgeEvent[] = [];
    const watcher = new CommentWatcher({} as never, (ev) => {
      offered.push(ev);
      if (ev.event === 'comment') stored.set(ev.comment.commentId, ev.comment.postId);
      return true;
    }, log(), async (_k, ids, posts) =>
      new Set(ids.filter((id) => stored.has(id) && (!posts?.[id] || stored.get(id) === posts[id]))));

    expect(await watcher.emitNew('k1', MARKER, [parsed('c1')])).toMatchObject({ known: 0, fresh: 1 });
    expect(offered).toEqual([expect.objectContaining({
      event: 'comment', comment: expect.objectContaining({ commentId: 'c1', postId: 'pfbid0Test02' }),
    })]);
    // Filed under the slug it was read under, it is known again: nothing more is sent.
    expect(await watcher.emitNew('k1', MARKER, [parsed('c1')])).toMatchObject({ known: 1, fresh: 0 });
    expect(offered).toHaveLength(1);
  });

  it('logs each boundary with ids only', async () => {
    const logger = log();
    const watcher = new CommentWatcher({} as never, () => true, logger, async () => new Set());

    await watcher.emitNew('k1', MARKER, [parsed('c9', 'c8')]);

    const events = logger.info.mock.calls.map(([fields]) => (fields as { event?: string }).event);
    expect(events).toEqual(['fb_comment_candidate', 'fb_comment_event_emitted']);
    const [candidate] = logger.info.mock.calls[0]!;
    expect(candidate).toMatchObject({ commentId: 'c9', parentCommentId: 'c8', known: false, pageId: PAGE.pageId });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('komentar c9');
  });
});
