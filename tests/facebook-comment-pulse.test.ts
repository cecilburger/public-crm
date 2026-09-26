import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseFacebookComments } from '../apps/fb-bridge/src/parsers/comments.ts';
import { PulseTabs, changedPosts } from '../apps/fb-bridge/src/commentPulse.ts';
import { CommentWatcher, PULSE_INTERVAL_MS } from '../apps/fb-bridge/src/commentWatcher.ts';
import type { FbBridgeEvent } from '../apps/fb-bridge/src/events.ts';

/**
 * Near-real-time comments by a light check once a minute.
 *
 * Measured live, 2026-09-26: Facebook's notification badge is not a usable
 * push signal — it stopped updating in a tab left open ~15 minutes, and a
 * comment on a post that already had an unread notification (14:08:29) never
 * raised it at all. The Page timeline, reloaded, always shows each post's
 * comment count ("3 comments"); a count that rose names the one post to read.
 */

const PAGE = { pageId: '90000000000009', pageName: 'Toko Uji' };
const MARKER = { ...PAGE, tenantId: '11111111-1111-4111-8111-111111111111' };
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A post article as the live timeline renders its comment summary, 2026-09-26. */
const post = (postId: string, summary: string | null, comment = '') => `
  <div role="article">
    <a href="https://www.facebook.com/permalink.php?story_fbid=${postId}&amp;id=${PAGE.pageId}">1d</a>
    <div dir="auto">caption ${postId}</div>
    ${summary === null ? '' : `<div role="button" tabindex="0"><span dir="auto"><span>${summary}</span></span></div>`}
    ${comment}
  </div>`;
const feed = (...posts: string[]) => `<div role="feed">${posts.join('')}</div>`;

describe('the comment count on each post of the timeline', () => {
  it('is read off the post\'s own summary, in either language, and absent when the post has none', () => {
    const parsed = parseFacebookComments(feed(
      post('pfbid0A', '3 comments'),
      post('pfbid0B', '1 comment'),
      post('pfbid0C', '14 komentar'),
      post('pfbid0D', null),
      post('pfbid0E', '1,2 rb komentar'),
      post('pfbid0F', '2.4K comments'),
    ), PAGE);

    expect(parsed.commentCounts).toEqual({
      pfbid0A: 3, pfbid0B: 1, pfbid0C: 14, pfbid0E: 1200, pfbid0F: 2400,
    });
  });

  it('never takes a number a customer wrote inside a comment for the post\'s count', () => {
    const inside = `<div role="article" aria-label="Comment by Rina a day ago">
      <a href="https://www.facebook.com/profile.php?id=900000000000077&amp;comment_id=9000000000000099">Rina</a>
      <div dir="auto"><span dir="auto">5 comments</span></div></div>`;
    const parsed = parseFacebookComments(feed(post('pfbid0A', '2 comments', inside)), PAGE);

    expect(parsed.commentCounts).toEqual({ pfbid0A: 2 });
  });
});

describe('which posts a pulse reads', () => {
  const recent = ['pfbid0A', 'pfbid0B', 'pfbid0C'];

  it('reads only a post whose count rose, or a recent post it has never counted', () => {
    expect(changedPosts({ pfbid0A: 3, pfbid0B: 1 }, { pfbid0A: 4, pfbid0B: 1, pfbid0C: 2 }, recent))
      .toEqual(['pfbid0A', 'pfbid0C']);
  });

  it('reads nothing when counts held or fell (a comment deleted), and nothing without a baseline', () => {
    expect(changedPosts({ pfbid0A: 3, pfbid0B: 1 }, { pfbid0A: 3, pfbid0B: 0 }, recent)).toEqual([]);
    expect(changedPosts(undefined, { pfbid0A: 9 }, recent)).toEqual([]);
  });
});

/* ------------------------------------------------------------ the pulse tab */

function fakeTab(url = 'about:blank') {
  let connected = true;
  const handlers = new Map<string, () => void>();
  const focusCalls: unknown[] = [];
  const page = {
    url: vi.fn(() => url),
    isClosed: vi.fn(() => false),
    browser: vi.fn(() => ({ isConnected: () => connected })),
    close: vi.fn(async () => {}),
    bringToFront: vi.fn(async () => {}),
    on: vi.fn((event: string, fn: () => void) => { handlers.set(event, fn); }),
    evaluate: vi.fn(async () => 1),
    createCDPSession: vi.fn(async () => ({
      send: vi.fn(async (method: string, params: unknown) => { focusCalls.push([method, params]); }),
      detach: vi.fn(async () => {}),
    })),
  };
  return { page, focusCalls, closed: () => handlers.get('close')?.(), browserLost: () => { connected = false; } };
}

const sessionsWith = (tabs: unknown[], inbox: unknown = fakeTab('https://business.facebook.com/latest/inbox').page) => {
  const queue = [...tabs];
  return {
    getPageMarker: async () => MARKER,
    newPage: vi.fn(async () => queue.shift() ?? null),
    getActivePage: vi.fn(async () => inbox),
    assertUsable: vi.fn(async () => {}),
    forgetSession: vi.fn(),
    knownSessionKeys: async () => ['k1'],
  };
};

describe('the pulse tab', () => {
  const FOCUS = ['Emulation.setFocusEmulationEnabled', { enabled: true }];

  it('is opened once and reused, rendering behind other tabs, with the inbox tab kept rendering too', async () => {
    const tab = fakeTab();
    const inbox = fakeTab('https://business.facebook.com/latest/inbox');
    const sessions = sessionsWith([tab.page], inbox.page);
    const tabs = new PulseTabs(sessions as never, log());

    expect(await tabs.get('k1')).toBe(tab.page);
    expect(await tabs.get('k1')).toBe(tab.page);

    expect(sessions.newPage).toHaveBeenCalledTimes(1);
    expect(tab.focusCalls).toContainEqual(FOCUS);
    expect(inbox.focusCalls).toContainEqual(FOCUS);
    expect(tab.page.bringToFront).not.toHaveBeenCalled();
    expect(inbox.page.bringToFront).not.toHaveBeenCalled();
  });

  it('is replaced after it closes, or after the browser under it went away without a close event', async () => {
    const [a, b, c] = [fakeTab(), fakeTab(), fakeTab()];
    const sessions = sessionsWith([a.page, b.page, c.page]);
    const tabs = new PulseTabs(sessions as never, log());

    await tabs.get('k1');
    a.closed();
    expect(await tabs.get('k1')).toBe(b.page);
    b.browserLost();
    expect(await tabs.get('k1')).toBe(c.page);
  });
});

/* ----------------------------------------------------------- whole pulses */

describe('a pulse against the live Page', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** One post's permalink surface, as `readPostSurfaceHtml` hands it back. */
  const surface = (postId: string, commentIds: string[]) => `<div role="article">
    <a href="https://www.facebook.com/permalink.php?story_fbid=${postId}&amp;id=${PAGE.pageId}">1d</a>
    ${commentIds.map((id) => `<div role="article" aria-label="Comment by Sinta a minute ago">
      <a href="https://www.facebook.com/profile.php?id=900000000000018&amp;comment_id=${id}">Sinta</a>
      <div dir="auto">komentar ${id}</div></div>`).join('')}</div>`;

  function livePage(state: { counts: Record<string, number>; comments: Record<string, string[]> }) {
    const visited: string[] = [];
    let at = '';
    const page = {
      url: vi.fn(() => at),
      isClosed: vi.fn(() => false),
      browser: vi.fn(() => ({ isConnected: () => true })),
      on: vi.fn(),
      close: vi.fn(async () => {}),
      goto: vi.fn(async (url: string) => { at = url; visited.push(url); return null; }),
      waitForSelector: vi.fn(async () => null),
      createCDPSession: vi.fn(async () => ({ send: vi.fn(async () => {}), detach: vi.fn(async () => {}) })),
      evaluate: vi.fn(async (script: unknown) => {
        const src = String(script);
        if (src === '1') return 1;
        if (src.includes('visibilityState')) return 'visible';
        if (src.startsWith('window.scrollBy')) return undefined;
        const postId = /var postId = "([^"]+)"/.exec(src)?.[1];
        if (postId) return surface(postId, state.comments[postId] ?? []);
        if (src.includes('var selectors')) {
          return feed(...Object.entries(state.counts).map(([id, n]) => post(id, `${n} comments`)));
        }
        throw new Error(`unexpected script: ${src.slice(0, 60)}`);
      }),
    };
    return { page, visited };
  }

  it('reads nothing past the timeline while counts hold, and only the post whose count rose when one does', async () => {
    const state = {
      counts: { pfbid0A: 1, pfbid0B: 1, pfbid0C: 0 } as Record<string, number>,
      comments: { pfbid0A: ['9000000000000101'], pfbid0B: ['9000000000000201'] } as Record<string, string[]>,
    };
    const sweepTab = livePage(state);
    const pulseTab = livePage(state);
    const sessions = sessionsWith([sweepTab.page, pulseTab.page]);
    const events: FbBridgeEvent[] = [];
    const stored = new Set<string>();
    const watcher = new CommentWatcher(sessions as never, (ev) => {
      events.push(ev);
      if (ev.event === 'comment') stored.add(ev.comment.commentId);
      return true;
    }, log(), async (_k, ids) => new Set(ids.filter((id) => stored.has(id))));

    vi.useFakeTimers();
    const full = watcher.sweep('k1', 'startup');
    await vi.runAllTimersAsync();
    expect(await full).toMatchObject({ posts: 3, fresh: 2 });

    // A minute with nothing new: one timeline read, no post opened, nothing sent.
    const quiet = watcher.sweep('k1', 'pulse');
    await vi.runAllTimersAsync();
    expect(await quiet).toMatchObject({ read: 0, fresh: 0 });
    expect(pulseTab.visited.filter((u) => u.includes('permalink'))).toEqual([]);

    // A customer comments on B: its count rises, and B alone is read.
    state.counts.pfbid0B = 2;
    state.comments.pfbid0B = ['9000000000000201', '9000000000000202'];
    const busy = watcher.sweep('k1', 'pulse');
    await vi.runAllTimersAsync();
    expect(await busy).toMatchObject({ fresh: 1 });
    expect(pulseTab.visited.filter((u) => u.includes('permalink'))).toEqual([
      expect.stringContaining('story_fbid=pfbid0B'),
    ]);
    expect(events.flatMap((e) => (e.event === 'comment' ? [e.comment.commentId] : [])))
      .toEqual(['9000000000000101', '9000000000000201', '9000000000000202']);
    // The pulse tab stays open for the next minute; the full sweep's own tab was closed.
    expect(pulseTab.page.close).not.toHaveBeenCalled();
    expect(sweepTab.page.close).toHaveBeenCalled();
  });

  it('runs once a minute after start, and never beside a sweep already running', async () => {
    vi.useFakeTimers();
    const watcher = new CommentWatcher(sessionsWith([]) as never, () => true, log());
    const calls: string[] = [];
    vi.spyOn(watcher, 'sweep').mockImplementation(async (_k, trigger) => { calls.push(trigger ?? 'manual'); return null; });

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['startup']);
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(calls).toEqual(['startup', 'pulse']);
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(calls).toEqual(['startup', 'pulse', 'pulse']);
    watcher.stop();
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS * 3);
    expect(calls).toEqual(['startup', 'pulse', 'pulse']);
  });
});

describe('a sweep whose tab could not be opened', () => {
  it('leaves the next sweep free to run instead of blocking every sweep after it', async () => {
    const sessions = sessionsWith([]);
    sessions.newPage.mockRejectedValueOnce(new Error('Target closed'));
    const watcher = new CommentWatcher(sessions as never, () => true, log());

    await expect(watcher.sweep('k1', 'interval')).rejects.toThrow('Target closed');

    await watcher.sweep('k1', 'interval');   // newPage answers null this time: asked again, not blocked
    expect(sessions.newPage).toHaveBeenCalledTimes(2);
  });
});
