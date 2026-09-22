import type { Page } from 'puppeteer';
import { SessionExpiredError } from './dmScraperPuppeteer.ts';

export interface ScrapedComment {
  /** Instagram's own comment id. Stable across reads, which is the whole
   * reason this file talks to the JSON endpoints instead of scraping the
   * post page: the comments table is keyed on it, and a hash of scraped
   * text is not stable enough to key on (we already learned that the hard
   * way with inbound DMs, which triple-ingested on an unstable id). */
  commentRef: string;
  /** The shortcode in the permalink — what a person sees and can paste. */
  postRef: string;
  mediaId: string;
  username: string;
  text: string;
  /** Set when this is a reply to another comment — including our own replies,
   * which is how "have we answered this one already?" is answered. */
  parentRef: string | null;
  createdAt: string;
}

/**
 * The web client's own app id. Every `/api/v1/` call instagram.com makes from
 * the browser carries it, and the endpoints below return 400 without it.
 */
const IG_APP_ID = '936619743392459';

/** Instagram is asking us to slow down, not telling us the session is gone.
 * Kept distinct so no caller can mistake one for the other and tear down a
 * working login over a temporary throttle. */
export class ThrottledError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * These are instagram.com's own internal JSON endpoints — the ones the web app
 * calls while you scroll it — not a supported public API, and they can change
 * without notice, exactly like the DM selectors next door. The tradeoff is
 * deliberate: a post page's comment list is lazy-loaded, virtualised and
 * carries no id we could key a row on, so scraping it would give us neither
 * completeness nor idempotency. Here the call happens *inside the logged-in
 * page*, so it is same-origin and rides the session cookie that is already
 * there — no token to store anywhere, and nothing leaves the browser.
 */
async function apiGet(page: Page, path: string): Promise<unknown> {
  const raw = await page.evaluate(`
    (async function () {
      try {
        var res = await fetch(${JSON.stringify(path)}, {
          headers: { 'x-ig-app-id': '${IG_APP_ID}', 'accept': 'application/json' },
          credentials: 'include',
        });
        return JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 2000000) });
      } catch (err) {
        return JSON.stringify({ status: 0, body: String(err) });
      }
    })();
  `) as string;

  const { status, body } = JSON.parse(raw) as { status: number; body: string };

  // Only an outright 401/403 means the cookie jar is dead. A 429 is a
  // throttle and an HTML body is usually a rate-limit or checkpoint page —
  // both are temporary, and calling them "session expired" once cost us a
  // live session that the DM watcher was still happily using.
  if (status === 401 || status === 403) {
    throw new SessionExpiredError('Sesi Instagram sudah tidak aktif — silakan login ulang');
  }
  if (status === 429) {
    throw new ThrottledError('Instagram sedang membatasi permintaan (429) — coba lagi nanti');
  }
  if (status !== 200) throw new Error(`Instagram menjawab ${status} untuk ${path}`);

  try {
    return JSON.parse(body);
  } catch {
    throw new ThrottledError(
      `Instagram mengembalikan halaman, bukan data (${body.slice(0, 120).replace(/\s+/g, ' ')})`,
    );
  }
}

interface ProfileMedia { mediaId: string; shortcode: string }

/**
 * The shortcode in a permalink *is* the media id, written in base 64 with
 * Instagram's own alphabet. Converting it is arithmetic, not a lookup — no
 * request, nothing to be throttled, and nothing to go stale.
 *
 * This is what replaced asking Instagram which posts we have. The obvious
 * lookup, `web_profile_info`, is the most aggressively throttled endpoint on
 * the site and answered 429 on the first live run; the mobile app's
 * `feed/user` endpoint is not served to the web at all and answers with the
 * page shell. The profile page's own grid, read from the DOM, has neither
 * problem — it is just the page a person looks at.
 */
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function mediaIdFromShortcode(shortcode: string): string | null {
  let id = 0n;
  for (const ch of shortcode) {
    const index = SHORTCODE_ALPHABET.indexOf(ch);
    if (index < 0) return null;
    id = id * 64n + BigInt(index);
  }
  return id > 0n ? id.toString() : null;
}

/** The most recent posts on our own profile, newest first. */
async function ownRecentPosts(page: Page, ownUsername: string, limit: number): Promise<ProfileMedia[]> {
  if (!page.url().includes(`instagram.com/${ownUsername}`)) {
    await page.goto(`https://www.instagram.com/${encodeURIComponent(ownUsername)}/`, {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    });
    assertLoggedIn(page);
  }

  const posts: ProfileMedia[] = [];
  for (const shortcode of (await waitForPostLinks(page)).slice(0, limit)) {
    const mediaId = mediaIdFromShortcode(shortcode);
    if (mediaId) posts.push({ mediaId, shortcode });
  }
  return posts;
}

function assertLoggedIn(page: Page): void {
  if (page.url().includes('/accounts/login')) {
    throw new SessionExpiredError('Sesi Instagram sudah tidak aktif — silakan login ulang');
  }
}

interface RawComment {
  pk?: unknown; text?: unknown; created_at?: unknown; user?: { username?: unknown };
  parent_comment_id?: unknown; replied_to_comment_id?: unknown;
  preview_child_comments?: RawComment[]; child_comments?: RawComment[];
  /** How many replies this comment has. The only signal that a thread exists
   * — the reply arrays above come back empty regardless. */
  child_comment_count?: unknown;
}

function toScraped(raw: RawComment, post: ProfileMedia, parentRef: string | null): ScrapedComment | null {
  const commentRef = String(raw?.pk ?? '');
  const username = String(raw?.user?.username ?? '');
  const text = String(raw?.text ?? '').trim();
  if (!commentRef || !username || !text) return null;

  // `created_at` is unix seconds. A comment with no timestamp is not worth
  // guessing a time for — the row's own created_at is closer to the truth
  // than `now` pretending to be the comment's own clock.
  const seconds = Number(raw?.created_at ?? 0);
  return {
    commentRef,
    postRef: post.shortcode,
    mediaId: post.mediaId,
    username,
    text,
    parentRef: parentRef ?? (String(raw.parent_comment_id ?? raw.replied_to_comment_id ?? '') || null),
    createdAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : new Date().toISOString(),
  };
}

/**
 * Every comment on one post, replies included.
 *
 * Replies are not in this response. Instagram reports `child_comment_count`
 * on the parent and leaves `preview_child_comments` empty, serving the
 * replies themselves from a separate endpoint — the one the "View replies"
 * link calls. Reading only what comes back here meant a real question asked
 * inside a thread was invisible to the CRM, and it is also what made the
 * duplicate check blind.
 *
 * Each thread costs one extra request, so only threads that actually have
 * replies are fetched.
 */
async function commentsOn(page: Page, post: ProfileMedia): Promise<ScrapedComment[]> {
  const data = await apiGet(
    page, `/api/v1/media/${post.mediaId}/comments/?can_support_threading=true&permalink_enabled=false`,
  ) as { comments?: RawComment[] };

  const out: ScrapedComment[] = [];
  for (const raw of data?.comments ?? []) {
    const parent = toScraped(raw, post, null);
    if (!parent) continue;
    out.push(parent);

    const inline = raw.preview_child_comments ?? raw.child_comments ?? [];
    if (inline.length > 0) {
      for (const child of inline) {
        const scraped = toScraped(child, post, parent.commentRef);
        if (scraped) out.push(scraped);
      }
      continue;
    }
    if (Number(raw.child_comment_count ?? 0) === 0) continue;

    await sleep(1200);
    let children: { child_comments?: RawComment[] };
    try {
      children = await apiGet(
        page, `/api/v1/media/${post.mediaId}/comments/${parent.commentRef}/child_comments/`,
      ) as { child_comments?: RawComment[] };
    } catch (err) {
      // A throttle is the watcher's to act on. Anything else costs us this
      // one thread's replies until the next poll, which is cheaper than
      // losing the whole post's comments to one bad read.
      if (err instanceof ThrottledError) throw err;
      continue;
    }
    for (const child of children?.child_comments ?? []) {
      const scraped = toScraped(child, post, parent.commentRef);
      if (scraped) out.push(scraped);
    }
  }
  return out;
}

/**
 * What instagram.com itself asks for when a person opens one of our posts.
 *
 * Guessing endpoint names costs one request per guess against an account
 * that is already being throttled, and two guesses had already missed. This
 * instead loads two ordinary pages — the profile, then one post, which is
 * exactly what a human visit looks like — and writes down the XHRs the page
 * fires on its own. Whatever loads the comments is in that list, by
 * definition, with the parameters the site really sends.
 */
export async function probeCommentRequests(page: Page, ownUsername: string): Promise<{
  shortcodes: string[];
  requests: string[];
  pageText: string;
  commentsRaw: string;
}> {
  const requests: string[] = [];
  const onRequest = (req: { url: () => string; resourceType: () => string }): void => {
    const url = req.url();
    if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
    if (/\/api\/v1\/|\/graphql/.test(url)) requests.push(url);
  };
  page.on('request', onRequest);

  try {
    await page.goto(`https://www.instagram.com/${encodeURIComponent(ownUsername)}/`, {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    });
    if (page.url().includes('/accounts/login')) {
      throw new SessionExpiredError('Sesi Instagram sudah tidak aktif — silakan login ulang');
    }
    const shortcodes = await waitForPostLinks(page);
    const pageText = await page.evaluate(`
      (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 600)
    `).catch(() => '') as string;

    let commentsRaw = '';
    if (shortcodes[0]) {
      requests.length = 0;
      await page.goto(`https://www.instagram.com/p/${shortcodes[0]}/`, {
        waitUntil: 'domcontentloaded', timeout: 30_000,
      });
      await sleep(6000);

      // What the comments endpoint really answers for a post we can see —
      // the difference between "this post has no comments" and "we are
      // asking the wrong thing" is not visible from an empty array alone.
      const mediaId = mediaIdFromShortcode(shortcodes[0]);
      if (mediaId) {
        commentsRaw = await page.evaluate(`
          (async function () {
            try {
              var res = await fetch('/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false', {
                headers: { 'x-ig-app-id': '${IG_APP_ID}', 'accept': 'application/json' },
                credentials: 'include',
              });
              return res.status + ' ' + (await res.text()).slice(0, 700);
            } catch (err) { return 'threw ' + String(err); }
          })();
        `).catch((err) => `evaluate failed: ${err}`) as string;
      }
    }
    return { shortcodes, requests: [...new Set(requests)], pageText, commentsRaw };
  } finally {
    page.off('request', onRequest);
  }
}

/**
 * The profile grid is lazy-loaded — the links are not in the first paint.
 * Polls (nudging the page down, which is what makes Instagram fetch the next
 * rows) until some appear or the deadline passes, so "no posts" is a real
 * answer rather than "we looked too early".
 */
async function waitForPostLinks(page: Page, timeoutMs = 20_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hrefs = await page.evaluate(`
      Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'))
        .map(function (a) { return a.getAttribute('href') || ''; })
        .filter(function (h) { return h.indexOf('/p/') >= 0 || h.indexOf('/reel/') >= 0; })
        .slice(0, 24);
    `).catch(() => []) as string[];

    const codes = [...new Set(hrefs
      .map((h) => {
        const parts = h.split('?')[0]!.split('/').filter(Boolean);
        const at = parts.findIndex((p) => p === 'p' || p === 'reel');
        return at >= 0 ? parts[at + 1] ?? '' : '';
      })
      .filter(Boolean))];
    if (codes.length > 0) return codes;

    await page.evaluate('window.scrollBy(0, 800)').catch(() => {});
    await sleep(1500);
  }
  return [];
}

/**
 * Every comment on our own recent posts, ours excluded.
 *
 * Paced on purpose. This account has already been flagged once during
 * development, and a burst of reads against instagram.com is exactly the
 * shape that earns that — so it visits a handful of posts and waits between
 * calls. Missing a comment for one poll cycle costs nothing; losing the
 * session costs the whole feature.
 */
export async function readRecentComments(
  page: Page, ownUsername: string, limit = 6, opts: { includeOwn?: boolean } = {},
): Promise<ScrapedComment[]> {
  const posts = await ownRecentPosts(page, ownUsername, limit);
  const found: ScrapedComment[] = [];

  for (const post of posts) {
    await sleep(1500);
    const comments = await commentsOn(page, post);
    for (const comment of comments) {
      // Our own public replies come back down this same list. Ingesting them
      // would queue the bot to answer itself. `includeOwn` is for the one
      // caller that needs to see them: checking whether we already replied.
      if (!opts.includeOwn && comment.username.toLowerCase() === ownUsername.toLowerCase()) continue;
      found.push(comment);
    }
  }
  return found;
}
