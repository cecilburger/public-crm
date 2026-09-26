import type { Page } from 'puppeteer';
import type { Logger } from './messengerWatcher.ts';
import type { SessionManager } from './sessionManager.ts';

/** A tab that does not answer a trivial evaluate within this is treated as dead. */
const ALIVE_PING_MS = 5_000;

/**
 * Keeps a tab rendering while another tab of the same browser is in front.
 *
 * The bridge shares one browser between watchers, and a new tab takes the
 * front: the inbox watcher opens one for every thread it reads. The tab it
 * displaced turns `visibilityState: hidden`, and a hidden Page timeline stops
 * hydrating its post placeholders — scrolled into view or not, for as long as
 * it stays hidden. Confirmed live: 11 of 45 sweeps found 0 or 1 of the Page's
 * three posts, and each short one checked overlapped an inbox read; opening a
 * blank tab mid-discovery reproduced it 3 of 3 through the real sweep, and with
 * this set, 10 of 10 consecutive sweeps (half with that tab) found all three.
 * Emulated focus changes nothing but this tab's own rendering, which is why it
 * is preferred to `bringToFront()`: that would take the front away from
 * whichever tab was using it.
 *
 * Best effort: a browser that refuses leaves the tab exactly as before.
 */
export async function keepRenderingInBackground(page: Page, log: Logger, ids: Record<string, unknown>): Promise<void> {
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (err) {
    log.warn({ err, ...ids }, 'fb-bridge: could not keep a tab rendering in the background');
  }
}

/**
 * The recent posts a pulse has to open: those whose comment count rose since
 * the last reading, and any recent post it has never counted (new, or renamed
 * by Facebook). A count that held or fell — a comment deleted — opens nothing,
 * and with no earlier reading there is nothing to compare: the full sweep that
 * runs first is the baseline.
 */
export function changedPosts(
  previous: Readonly<Record<string, number>> | undefined,
  current: Readonly<Record<string, number>>,
  recent: readonly string[],
): string[] {
  if (!previous) return [];
  return recent.filter((postId) => {
    const now = current[postId] ?? 0;
    const before = previous[postId];
    return before === undefined ? now > 0 : now > before;
  });
}

/**
 * One long-lived tab per session for the once-a-minute pulse.
 *
 * Reused rather than opened and closed every minute: a new tab takes the front
 * each time it opens, which would keep pushing the inbox tab into the
 * background. It renders as if in front (`keepRenderingInBackground`), and so
 * does the long-lived inbox tab beside it, which would otherwise be left
 * behind it whenever a short-lived tab closes.
 */
export class PulseTabs {
  private tabs = new Map<string, Page>();
  private opening = new Map<string, Promise<Page | null>>();

  constructor(private sessions: SessionManager, private log: Logger) {}

  /** The session's pulse tab, alive — replaced when it is not. */
  async get(sessionKey: string): Promise<Page | null> {
    const pending = this.opening.get(sessionKey);
    if (pending) return pending;
    const open = this.tabs.get(sessionKey);
    if (open) {
      if (await isAlive(open)) return open;
      this.tabs.delete(sessionKey);
      await open.close().catch(() => {});
      this.log.warn({ sessionKey }, 'fb-bridge: comment pulse tab was lost — opening a new one');
    }
    const opening = this.open(sessionKey).finally(() => this.opening.delete(sessionKey));
    this.opening.set(sessionKey, opening);
    return opening;
  }

  async closeAll(): Promise<void> {
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    await Promise.all(tabs.map((tab) => tab.close().catch(() => {})));
  }

  private async open(sessionKey: string): Promise<Page | null> {
    const page = await this.sessions.newPage(sessionKey);
    if (!page) return null;
    await keepRenderingInBackground(page, this.log, { sessionKey });
    const forget = () => {
      if (this.tabs.get(sessionKey) === page) this.tabs.delete(sessionKey);
    };
    page.on('close', forget);
    page.on('error', forget);   // a crashed renderer: replaced on the next pulse
    this.tabs.set(sessionKey, page);

    const inbox = await this.sessions.getActivePage(sessionKey).catch(() => null);
    if (inbox && inbox !== page) await keepRenderingInBackground(inbox, this.log, { sessionKey });
    this.log.info({ event: 'fb_comment_pulse_tab_opened', sessionKey }, 'fb_comment_pulse_tab_opened');
    return page;
  }
}

/** "Alive" is asked, not assumed: a browser that died underneath leaves its tab claiming to be open. */
async function isAlive(page: Page): Promise<boolean> {
  if (page.isClosed() || !page.browser().isConnected()) return false;
  const ping = page.evaluate('1').then(() => true, () => false);
  const timeout = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ALIVE_PING_MS);
    timer.unref?.();
  });
  return Promise.race([ping, timeout]);
}
