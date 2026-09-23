import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
  sendThreadMessage, clickButtonByText, SessionExpiredError, SendNotConfirmedError,
} from './dmScraperPuppeteer.ts';
import { dmLanded } from './commentPoster.ts';

// `puppeteer-extra`'s own default export relies on CJS/ESM default-import
// interop this workspace's tsconfig doesn't enable — `addExtra` is a plain
// named export typed against the real `puppeteer` package, so it sidesteps
// that entirely. `addExtra`'s own typings are pinned to a different
// `puppeteer`/`puppeteer-core` version than the one installed here (missing
// `createBrowserFetcher`, a nominally distinct private `Browser` class) —
// a typings mismatch between the two packages, not a real runtime one:
// `puppeteerExtra.launch()` hands back a real instance of *our* installed
// puppeteer either way, so the return value is cast back to our own
// `Browser` type at each call site below.
const puppeteerExtra = addExtra(puppeteer as unknown as Parameters<typeof addExtra>[0]);
puppeteerExtra.use(StealthPlugin());

const LOGIN_URL = 'https://www.instagram.com/accounts/login/';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Confirmed live: even a valid, logged-in session cookie rendered a
// completely blank page under plain headless Chromium (URL correct,
// `document.body.innerText` empty) — consistent with Instagram detecting
// the headless browser itself and serving nothing, rather than rejecting
// the login outright. `puppeteer-extra-plugin-stealth` patches the common
// fingerprints real sites check for (`navigator.webdriver`, missing
// plugins, headless-specific rendering signatures, …) specifically so
// headless Chromium reads as a real browser — this is what makes
// `HEADLESS` default back to `true` a reasonable default again, after the
// plain (unpatched) headless attempt earlier in development forced a
// visible window as the only working option. A realistic desktop
// User-Agent is the other half of the same story.
const HEADLESS = process.env.IG_BRIDGE_HEADLESS !== 'false';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type LoginResult =
  | { status: 'ready'; username: string }
  | { status: 'challenge_required'; challengeType: 'two_factor' | 'checkpoint' | 'unknown' }
  | { status: 'failed'; error: string };

/**
 * The three cookies the manual paste-them-in form asks for, captured from a
 * login the operator performed themselves in a window the bridge opened.
 *
 * `sessionId` is exactly as sensitive as a password — it *is* the session. It
 * is held in memory here so the console can confirm a capture happened, and it
 * is masked before it leaves this service. The other two are not secrets on
 * their own: `dsUserId` is the account's public numeric id, and `csrfToken` is
 * worthless without the session it pairs with.
 */
export interface CapturedCookies {
  sessionId: string;
  csrfToken: string | null;
  dsUserId: string | null;
  capturedAt: string;
}

/** How long a login window stays open before the bridge gives up on it. Long,
 * because the operator may be waiting on a 2FA code from a phone. */
const LOGIN_WINDOW_TIMEOUT_MS = 15 * 60_000;
const LOGIN_POLL_INTERVAL_MS = 3_000;

/** Distinct from a Playwright/network failure so the send route can tell the
 * caller "reconnect Instagram" (a permanent condition worth surfacing
 * distinctly) apart from "the send itself failed" (worth retrying). */
export class NoActiveSessionError extends Error {}

/**
 * Unofficial by construction: this drives the real instagram.com web UI
 * with a real (by default headless, stealth-patched) Chromium profile —
 * there is no supported "connect an account" API for this, only the login
 * form a person would use by hand, or (for `loginWithCookie`) a `sessionid`
 * cookie from a real, manually-authenticated browser session imported
 * directly. Instagram's own anti-abuse systems watch for exactly this kind
 * of automated login, so:
 *   - every tenant gets its own persistent Chromium profile (`userDataDir`),
 *     reused across restarts — a fresh login every time is the single
 *     biggest trigger for a "suspicious login" checkpoint, a repeated cold
 *     login is worse than one that resumes an existing cookie jar.
 *   - selectors below match the login form and inbox as of when this was
 *     written; Instagram changes this markup without notice, so a selector
 *     going stale here is expected maintenance, not a surprise.
 */
export class SessionManager {
  private contexts = new Map<string, Browser>();
  private pendingChallenge = new Map<string, Page>();
  private pendingUsernames = new Map<string, string>();
  /** Browser windows a human is currently logging in to, by tenant. Their
   * presence is what `awaiting_login` means — a second click while one is open
   * must not launch another against the same profile. */
  private loginWindows = new Map<string, Browser>();
  /** What the last browser login captured, kept in memory only and read once.
   * `sessionid` is a credential: it is never written to disk here and never
   * reaches `apps/api`'s database. */
  private capturedCookies = new Map<string, CapturedCookies>();
  // In-memory cache of the persisted-to-disk username below — read once per
  // tenant, not on every call.
  private ownUsernames = new Map<string, string>();

  constructor(private authDir: string) {}

  /**
   * `apps/ig-bridge` restarts on every code change (`tsx watch`) and, in
   * production, on any redeploy or crash — an in-memory-only record of "who
   * is logged in" went stale on every single one of those, silently, with
   * `ig_bridge_connections` still reading 'ready' in the console the whole
   * time. The username is written to a small file next to the Chromium
   * profile the moment login succeeds, specifically so a restart can resume
   * polling on its own instead of needing a manual reconnect from Pengaturan
   * every time.
   */
  private usernameFile(tenantId: string): string {
    return path.join(this.profileDir(tenantId), '.own-username');
  }

  private async persistOwnUsername(tenantId: string, username: string): Promise<void> {
    this.ownUsernames.set(tenantId, username);
    await fs.mkdir(this.profileDir(tenantId), { recursive: true }).catch(() => {});
    await fs.writeFile(this.usernameFile(tenantId), username, 'utf8').catch(() => {});
  }

  /** Lets `DmWatcher` notice a tenant it already marked "observed" is
   * actually sitting on a dead browser connection (crashed, or CDP just
   * dropped) — its inbox observer died with that browser, silently, and
   * nothing re-attaches it on its own. */
  isConnected(tenantId: string): boolean {
    return this.contexts.get(tenantId)?.connected ?? false;
  }

  /** One recovery attempt at a time per tenant, so a console polling every
   * five seconds cannot stack a queue of browser tabs against one profile. */
  private recoveringUsername = new Map<string, Promise<string | null>>();

  /**
   * Fills in a username for a session that has one on Instagram but not on
   * disk.
   *
   * This exists because a login can succeed and still leave nothing behind to
   * name the account — which is exactly what happened when the first version of
   * `readOwnUsername` came back empty against the live site. Without this the
   * only way out is Putuskan and log in again, for a session that is otherwise
   * perfectly healthy.
   *
   * Cheap when it is not needed: the caller checks for a persisted username
   * first, so this only ever runs for a connection that is actually missing one.
   */
  async recoverOwnUsername(tenantId: string): Promise<string | null> {
    const inFlight = this.recoveringUsername.get(tenantId);
    if (inFlight) return inFlight;

    const attempt = (async () => {
      const page = await this.newPage(tenantId);
      if (!page) return null;
      try {
        const cookies = await page.cookies('https://www.instagram.com').catch(() => []);
        const dsUserId = cookies.find((c) => c.name === 'ds_user_id')?.value ?? null;
        const username = await this.readOwnUsername(page, dsUserId).catch(() => null);
        if (username) await this.persistOwnUsername(tenantId, username);
        return username;
      } finally {
        await page.close().catch(() => {});
      }
    })();

    this.recoveringUsername.set(tenantId, attempt);
    try {
      return await attempt;
    } finally {
      this.recoveringUsername.delete(tenantId);
    }
  }

  async getOwnUsername(tenantId: string): Promise<string | null> {
    const cached = this.ownUsernames.get(tenantId);
    if (cached) return cached;
    try {
      const fromDisk = (await fs.readFile(this.usernameFile(tenantId), 'utf8')).trim();
      if (fromDisk) {
        this.ownUsernames.set(tenantId, fromDisk);
        return fromDisk;
      }
    } catch {
      // No persisted username yet — never logged in, or forgotten below.
    }
    return null;
  }

  /** Every tenant with a saved login, on disk or already loaded — this is
   * what `DmWatcher` iterates each housekeeping cycle, so it has to reflect
   * disk state, not just what happened to log in during this particular
   * process's lifetime. */
  async knownTenantIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.authDir);
    } catch {
      return [];
    }
    const known: string[] = [];
    for (const tenantId of entries) {
      if (await this.getOwnUsername(tenantId)) known.push(tenantId);
    }
    return known;
  }

  /** Drops session state — in memory and the persisted username marker —
   * after a poll finds the cookie jar has expired, without deleting the
   * Chromium profile itself or touching `ig_bridge_connections` (that DB
   * row lives in `apps/api`, told separately via the `session_error` event
   * this triggers). Removing the marker, not just the in-memory entry, is
   * what stops `knownTenantIds` from retrying a session already known to be
   * dead on every following tick until the user actually reconnects. */
  forgetSession(tenantId: string): void {
    this.ownUsernames.delete(tenantId);
    void fs.rm(this.usernameFile(tenantId), { force: true }).catch(() => {});
    void this.closeContext(tenantId);
  }

  /**
   * A live `Page` for a tenant that is already `ready`, for use outside the
   * login request itself — `DmWatcher` and the send endpoint both need one.
   * Reuses the in-memory browser from `login()` when this process is the
   * one that logged in; otherwise resumes the persisted profile directory
   * (the cookie jar the last launch already wrote), the same profile
   * `login()` would have reused had it been called again.
   */
  async getActivePage(tenantId: string): Promise<Page | null> {
    const browser = await this.ensureBrowser(tenantId);
    if (!browser) return null;
    const pages = await browser.pages();
    return this.configurePage(pages[0] ?? await browser.newPage());
  }

  /** A brand-new tab in the same browser — for a short-lived trip (reading
   * one thread, checking Requests, sending) that must not disturb whatever
   * long-lived page `DmWatcher` keeps open with an inbox observer installed
   * on it. Same session, same cookies, just a separate tab. */
  async newPage(tenantId: string): Promise<Page | null> {
    const browser = await this.ensureBrowser(tenantId);
    if (!browser) return null;
    return this.configurePage(await browser.newPage());
  }

  /** Puppeteer has no `launch()`-level `userAgent` option — it's set
   * per-page instead. Applied every time a page is handed out (harmless to
   * repeat on an already-configured one) rather than only at creation, so
   * no call site can forget it. */
  private async configurePage(page: Page): Promise<Page> {
    await page.setUserAgent(USER_AGENT).catch(() => {});
    return page;
  }

  // Chrome refuses a second launch against the same `userDataDir` outright
  // (its own single-instance `ProcessSingleton` lock file) — confirmed live,
  // two concurrent callers for the same tenant (a housekeeping tick and a
  // route handler, say) each seeing `this.contexts` still empty and both
  // calling `puppeteer.launch()` crashed one of them with a lock-file
  // error. This memoizes the in-flight launch per tenant so every
  // concurrent caller awaits the one real launch instead of racing another.
  private launching = new Map<string, Promise<Browser | null>>();

  private async ensureBrowser(tenantId: string): Promise<Browser | null> {
    const existing = this.contexts.get(tenantId);
    // A cached `Browser` whose underlying CDP connection has died (the
    // browser process crashed, or Chrome's own remote-debugging connection
    // just dropped — confirmed live, with the OS process still alive) fails
    // every `newPage()` call on it with `Protocol error: Connection closed`
    // — forever, since nothing here previously re-checked before handing it
    // back out. Every send and every inbox read shares this same cache, so
    // one dead connection silently broke both at once until the process was
    // restarted by hand. Discarding it here and falling through to relaunch
    // is what makes that self-heal instead.
    if (existing) {
      if (existing.connected) return existing;
      this.contexts.delete(tenantId);
      await existing.close().catch(() => {});
    }

    const inFlight = this.launching.get(tenantId);
    if (inFlight) return inFlight;

    const launch = (async () => {
      if (!(await this.hasSession(tenantId))) return null;
      await this.clearCrashedSessionState(tenantId);
      let browser: Browser;
      try {
        browser = await puppeteerExtra.launch({
          headless: HEADLESS, userDataDir: this.profileDir(tenantId), defaultViewport: { width: 1280, height: 900 },
        }) as unknown as Browser;
      } catch (err) {
        // Almost always the profile lock, held by a Chrome this process did
        // not start. `tsx watch` restarts on every save and the shutdown
        // handler does not always win the race to close the browser first,
        // so the surviving Chrome blocks every launch the new process
        // attempts — confirmed live, repeatedly, each restart leaving the
        // bridge unable to open a single page until the stray was killed by
        // hand. Adopting it is strictly better than fighting it: same
        // profile, same cookies, same logged-in session.
        const adopted = await this.adoptRunningBrowser(tenantId);
        if (!adopted) throw err;
        this.contexts.set(tenantId, adopted);
        return adopted;
      }
      this.contexts.set(tenantId, browser);
      return browser;
    })();
    this.launching.set(tenantId, launch);
    try {
      return await launch;
    } finally {
      this.launching.delete(tenantId);
    }
  }

  /**
   * Reconnect to a Chrome already running against this tenant's profile.
   *
   * Chrome writes its own debugging port into `DevToolsActivePort` inside the
   * profile directory — that file exists precisely so something else can find
   * a running instance. Puppeteer can attach over it, which turns a leftover
   * browser from the previous `tsx watch` generation from a blocker into the
   * session we go on using.
   */
  private async adoptRunningBrowser(tenantId: string): Promise<Browser | null> {
    let port: string;
    try {
      const contents = await fs.readFile(path.join(this.profileDir(tenantId), 'DevToolsActivePort'), 'utf8');
      port = contents.split('\n')[0]?.trim() ?? '';
    } catch {
      return null;
    }
    if (!/^\d+$/.test(port)) return null;

    try {
      return await puppeteer.connect({
        browserURL: `http://127.0.0.1:${port}`, defaultViewport: { width: 1280, height: 900 },
      });
    } catch {
      // The file outlives the browser it described. Nothing to adopt.
      return null;
    }
  }

  private profileDir(tenantId: string): string {
    return path.join(this.authDir, tenantId);
  }

  /** Public so `DmWatcher` can persist its own per-tenant state (thread
   * read-anchors) alongside the Chrome profile, without duplicating the
   * naming scheme. */
  getProfileDir(tenantId: string): string {
    return this.profileDir(tenantId);
  }

  /**
   * Confirmed live: launching headless Chrome against a profile that was
   * last shut down uncleanly (killed by a crash, a forced process exit, or
   * — before the launch-locking fix above existed — a losing racer in a
   * concurrent-launch collision) fails outright with `[ERROR:chrome_main.cc]
   * Multiple targets are not supported in headless mode`, the moment its
   * saved session tries to restore more than one open tab at once. This
   * tenant's browser legitimately runs more than one tab at a time (the
   * long-lived inbox-observer page alongside a short-lived reader/request
   * tab), so any unclean shutdown leaves exactly the state that trips this.
   * Deleting Chrome's own session-restore artifacts before every launch
   * (never the profile itself) heads it off unconditionally — `Cookies`,
   * `Login Data` and the rest of the authenticated profile are untouched,
   * since nothing here reads them; there's simply nothing left for Chrome
   * to try restoring.
   */
  private async clearCrashedSessionState(tenantId: string): Promise<void> {
    const defaultDir = path.join(this.profileDir(tenantId), 'Default');
    const artifacts = ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];
    await Promise.all(artifacts.map((name) =>
      fs.rm(path.join(defaultDir, name), { recursive: true, force: true }).catch(() => {})));
  }

  /** Cheap, no browser involved — just "does this tenant have a saved profile". */
  async hasSession(tenantId: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(this.profileDir(tenantId));
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  private async closeContext(tenantId: string): Promise<void> {
    // `login`/`loginWithCookie` call this right before launching their own
    // fresh browser — if a housekeeping-driven `ensureBrowser` launch for
    // this same tenant happens to be in flight, wait for it to land (and
    // register itself in `this.contexts`) first, so it gets closed here
    // instead of surviving as an orphaned second Chrome pointed at the same
    // `userDataDir` the fresh login is about to launch against.
    const inFlight = this.launching.get(tenantId);
    if (inFlight) await inFlight.catch(() => {});

    const browser = this.contexts.get(tenantId);
    if (browser) {
      this.contexts.delete(tenantId);
      this.pendingChallenge.delete(tenantId);
      this.pendingUsernames.delete(tenantId);
      await browser.close().catch(() => {});
    }
  }

  /**
   * Instagram geo-detects language from the request's IP, so a login
   * attempt from Indonesia gets the cookie banner in Bahasa Indonesia, not
   * English. Matching by text stays inherently locale-fragile, so this also
   * falls back to "click whatever the last button in a top-of-page dialog
   * is" — on Meta's consent banners that is reliably the primary "allow"
   * action, regardless of what language it is rendered in.
   */
  private async dismissCookieBanner(page: Page): Promise<void> {
    const byText = /allow all cookies|only allow essential|izinkan semua cookie|hanya izinkan yang penting/i;
    const clicked = await clickButtonByText(page, byText, 4000);
    if (clicked) return;
    await page.evaluate(`
      (function () {
        var dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return;
        var buttons = dialog.querySelectorAll('div[role="button"], button');
        var last = buttons[buttons.length - 1];
        if (last) last.click();
      })();
    `).catch(() => {});
  }

  /**
   * Reads the page for ~15s after submitting a form, classifying whatever
   * state it lands on. Polling the URL/DOM rather than racing several
   * `waitForSelector`s — Instagram's post-submit flow branches into enough
   * different shapes (home feed, "save info" dialog, 2FA, checkpoint, plain
   * inline error) that one flat poll loop is far easier to keep correct
   * than a pile of races.
   */
  private async classifyOutcome(page: Page): Promise<LoginResult> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const url = page.url();

      if (url.includes('/accounts/login/two_factor')) {
        return { status: 'challenge_required', challengeType: 'two_factor' };
      }
      if (url.includes('/challenge/')) {
        return { status: 'challenge_required', challengeType: 'checkpoint' };
      }
      if (!url.includes('/accounts/login')) {
        await clickButtonByText(page, /Not now|Not Now/, 2000);
        return { status: 'ready', username: '' };
      }

      const errorText = await page.evaluate(`
        (function () {
          var el = document.querySelector('#slfErrorAlert, [role="alert"]');
          return el ? (el.textContent || '').trim() : '';
        })();
      `).catch(() => '') as string;
      if (errorText) return { status: 'failed', error: errorText };

      await sleep(500);
    }
    return { status: 'failed', error: 'Waktu tunggu habis — halaman Instagram tidak merespons seperti yang diharapkan' };
  }

  async login(tenantId: string, username: string, password: string): Promise<LoginResult> {
    await this.closeContext(tenantId);
    await this.clearCrashedSessionState(tenantId);

    const browser = await puppeteerExtra.launch({
      headless: HEADLESS, userDataDir: this.profileDir(tenantId), defaultViewport: { width: 1280, height: 900 },
    }) as unknown as Browser;
    this.contexts.set(tenantId, browser);

    const pages = await browser.pages();
    const page = await this.configurePage(pages[0] ?? await browser.newPage());
    try {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.dismissCookieBanner(page);
      await sleep(500);

      // Confirmed live: Instagram's fields are `name="email"` and
      // `name="pass"`, not `username`/`password`. The native
      // `<input type="submit">` sits invisible (a separate styled element
      // is the on-screen "Log in" button) — submitted via Enter in the
      // password field instead, the same way a real keyboard would.
      await page.waitForSelector('input[name="email"]', { timeout: 20_000 });
      await page.type('input[name="email"]', username, { delay: 10 });
      await page.type('input[name="pass"]', password, { delay: 10 });
      await page.keyboard.press('Enter');

      const result = await this.classifyOutcome(page);
      if (result.status === 'challenge_required') {
        this.pendingChallenge.set(tenantId, page);
        this.pendingUsernames.set(tenantId, username);
      } else if (result.status === 'ready') {
        await this.persistOwnUsername(tenantId, username);
        return { status: 'ready', username };
      } else {
        await this.closeContext(tenantId);
      }
      return result;
    } catch (err) {
      await this.closeContext(tenantId);
      return { status: 'failed', error: err instanceof Error ? err.message : 'Gagal membuka halaman login Instagram' };
    }
  }

  /**
   * The alternative to driving the login form at all: a `sessionid` cookie
   * lifted from a real, manually-authenticated browser session (Instagram
   * sees a normal human login, never an automated one), injected directly
   * into a fresh browser profile — the user's own session, imported into
   * their own self-hosted bridge for their own account. `username` is
   * asked for directly rather than scraped off the page, same as the
   * password-login flow trusts the form input it was given.
   *
   * `sessionid` is exactly as sensitive as the password `login()` takes,
   * handled the same way: passed through once, in memory, never written to
   * `apps/api`'s database.
   */
  async loginWithCookie(
    tenantId: string, username: string, sessionId: string, csrfToken?: string, dsUserId?: string,
  ): Promise<LoginResult> {
    await this.closeContext(tenantId);
    await this.clearCrashedSessionState(tenantId);

    const browser = await puppeteerExtra.launch({
      headless: HEADLESS, userDataDir: this.profileDir(tenantId), defaultViewport: { width: 1280, height: 900 },
    }) as unknown as Browser;
    this.contexts.set(tenantId, browser);

    try {
      const pages = await browser.pages();
      const page = await this.configurePage(pages[0] ?? await browser.newPage());

      const cookies: { name: string; value: string; domain: string; path: string; httpOnly?: boolean; secure?: boolean }[] = [
        { name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/', httpOnly: true, secure: true },
      ];
      if (csrfToken) cookies.push({ name: 'csrftoken', value: csrfToken, domain: '.instagram.com', path: '/', secure: true });
      if (dsUserId) cookies.push({ name: 'ds_user_id', value: dsUserId, domain: '.instagram.com', path: '/', secure: true });
      await page.setCookie(...cookies);

      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await sleep(1500);

      if (page.url().includes('/accounts/login')) {
        await this.closeContext(tenantId);
        return { status: 'failed', error: 'Session cookie tidak valid atau sudah kedaluwarsa — ambil ulang dari browser' };
      }
      await clickButtonByText(page, /Not now|Not Now/, 2000);
      await this.persistOwnUsername(tenantId, username);
      return { status: 'ready', username };
    } catch (err) {
      await this.closeContext(tenantId);
      return { status: 'failed', error: err instanceof Error ? err.message : 'Gagal memasukkan session cookie' };
    }
  }

  /* ------------------------------------------------- login in a real window */

  /**
   * Opens Instagram's own login page in a visible browser and waits.
   *
   * This is the third way in, and the only one where no Instagram credential
   * ever passes through the CRM. `login()` takes a password and types it;
   * `loginWithCookie()` takes a `sessionid` the operator dug out of DevTools by
   * hand. Here the operator logs in to Instagram directly, in a window on
   * whichever machine runs this bridge, and the session lands in the same
   * Chromium profile every other call already uses.
   *
   * It also sidesteps the whole challenge dance. 2FA prompts, checkpoints and
   * "was this you?" interstitials are Instagram's own screens — the operator
   * answers them in place, rather than the bridge classifying them and relaying
   * a code field into the console.
   *
   * Returns immediately with `awaiting_login`. Logging in is minutes of human
   * work and holding an HTTP request open for it would time out somewhere in
   * between; the console polls `/status` instead.
   */
  async openLoginWindow(tenantId: string, onSettled?: (result: LoginResult) => void): Promise<LoginResult | { status: 'awaiting_login' }> {
    // A second click must not launch a second Chrome against one `userDataDir`
    // — Chrome's own single-instance lock rejects that outright, and the error
    // it gives is far less useful than simply saying "a window is already open".
    if (this.loginWindows.has(tenantId)) return { status: 'awaiting_login' };

    await this.closeContext(tenantId);
    await this.clearCrashedSessionState(tenantId);

    const browser = await puppeteerExtra.launch({
      headless: false, userDataDir: this.profileDir(tenantId), defaultViewport: null,
    }) as unknown as Browser;
    this.loginWindows.set(tenantId, browser);

    const pages = await browser.pages();
    const page = await this.configurePage(pages[0] ?? await browser.newPage());
    await page.goto('https://www.instagram.com/accounts/login/', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    }).catch(() => {});

    void this.awaitBrowserLogin(tenantId, page).then(async (result) => {
      this.loginWindows.delete(tenantId);
      await browser.close().catch(() => {});
      onSettled?.(result);
    });

    return { status: 'awaiting_login' };
  }

  /** True while a human still has a login window open for this tenant. */
  isAwaitingLogin(tenantId: string): boolean {
    return this.loginWindows.has(tenantId);
  }

  /**
   * What the last browser login captured, masked for display.
   *
   * The console shows this as proof that the three values the manual form asks
   * for were really picked up. `sessionid` is only ever shown as its first and
   * last few characters: it is the credential itself, and a CRM page is not
   * where it belongs in full.
   */
  capturedFor(tenantId: string): { sessionIdMasked: string; csrfToken: string | null; dsUserId: string | null; capturedAt: string } | null {
    const got = this.capturedCookies.get(tenantId);
    if (!got) return null;
    const s = got.sessionId;
    const masked = s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '……';
    return { sessionIdMasked: masked, csrfToken: got.csrfToken, dsUserId: got.dsUserId, capturedAt: got.capturedAt };
  }

  /**
   * Polls the operator's own window until Instagram has actually issued a
   * session.
   *
   * POSITIVE PROOF, not the absence of a negative. The URL cannot answer this:
   * Instagram serves plenty of screens that are neither the login form nor a
   * logged-in feed — a loading skeleton, "Save your login info?", "Turn on
   * notifications", a checkpoint. `apps/fb-bridge` shipped two versions that
   * guessed from the URL and then from the page text, and both declared success
   * on the first screen they did not recognise, closing the window while the
   * operator was still typing. The `sessionid` cookie exists only once
   * Instagram has authenticated someone, so that is what this waits for.
   */
  private async awaitBrowserLogin(tenantId: string, page: Page): Promise<LoginResult> {
    const deadline = Date.now() + LOGIN_WINDOW_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        // Closed by the operator. Whether they finished is decided by what the
        // profile holds, not by assuming either way.
        const cookies = this.capturedCookies.get(tenantId);
        if (cookies) {
          const username = await this.getOwnUsername(tenantId);
          return { status: 'ready', username: username ?? '' };
        }
        return { status: 'failed', error: 'Jendela login ditutup sebelum login selesai' };
      }

      const cookies = await page.cookies('https://www.instagram.com').catch(() => []);
      const sessionId = cookies.find((c) => c.name === 'sessionid' && c.value)?.value;

      if (sessionId) {
        this.capturedCookies.set(tenantId, {
          sessionId,
          csrfToken: cookies.find((c) => c.name === 'csrftoken')?.value ?? null,
          dsUserId: cookies.find((c) => c.name === 'ds_user_id')?.value ?? null,
          capturedAt: new Date().toISOString(),
        });

        // Asked of Instagram rather than of the operator. The other two login
        // paths take the username from a form field, which is a guess the
        // operator can get wrong — and a wrong `ownUsername` makes the DM
        // watcher file our own replies as the customer's messages.
        const dsUserId = cookies.find((c) => c.name === 'ds_user_id')?.value ?? null;
        const username = await this.readOwnUsername(page, dsUserId).catch(() => null);
        if (username) await this.persistOwnUsername(tenantId, username);
        // A session without a username is still a session, but it is not one
        // anything should run on: `sendDm` needs `ownUsername` to tell our own
        // bubbles from the customer's. Said out loud rather than returned as an
        // empty string that every screen downstream renders as "@".
        if (!username) {
          return {
            status: 'failed',
            error: 'Login berhasil tapi username Instagram tidak terbaca — coba Putuskan lalu login ulang',
          };
        }
        return { status: 'ready', username };
      }

      await sleep(LOGIN_POLL_INTERVAL_MS);
    }

    return { status: 'failed', error: 'Waktu login habis — login tidak selesai dalam 15 menit' };
  }

  /**
   * The handle of whoever just logged in.
   *
   * Asked of Instagram's own `/api/v1/users/<id>/info/`, keyed on the
   * `ds_user_id` cookie that the login just set. That pairing is the reliable
   * one: the id comes from the session itself and the endpoint answers with
   * the account that id belongs to.
   *
   * An earlier version read `window._sharedData.config.viewer` and fell back to
   * a regex over the served HTML. Both came back empty against the live site —
   * the modern app shell ships neither — and the empty string travelled all the
   * way to the console, which rendered "Terhubung sebagai @" and, on Chat IG,
   * decided nothing was connected at all. The two DOM reads are kept below the
   * API call as a fallback rather than as the primary.
   */
  private async readOwnUsername(page: Page, dsUserId: string | null): Promise<string | null> {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    await sleep(1500);

    if (dsUserId) {
      // Same-origin, inside the logged-in page, so it rides the session cookie
      // that is already there — the same trick `commentScraper` uses.
      const raw = await page.evaluate(`
        (async function () {
          try {
            var res = await fetch('/api/v1/users/' + ${JSON.stringify(dsUserId)} + '/info/', {
              headers: { 'x-ig-app-id': '936619743392459', 'accept': 'application/json' },
              credentials: 'include',
            });
            return JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 100000) });
          } catch (err) { return JSON.stringify({ status: 0, body: String(err) }); }
        })();
      `).catch(() => null) as string | null;

      if (raw) {
        try {
          const { status, body } = JSON.parse(raw) as { status: number; body: string };
          if (status === 200) {
            const parsed = JSON.parse(body) as { user?: { username?: string } };
            const name = parsed.user?.username?.trim();
            if (name) return name;
          }
        } catch {
          // Not JSON — a checkpoint or throttle page. Fall through to the DOM.
        }
      }
    }

    const fromDom = await page.evaluate(`(() => {
      var w = window;
      var shared = w._sharedData && w._sharedData.config && w._sharedData.config.viewer;
      if (shared && shared.username) return shared.username;
      var m = document.documentElement.innerHTML.match(/"viewer".{0,200}?"username":"([A-Za-z0-9._]{1,30})"/);
      if (m) return m[1];
      // The profile link in the nav is the last thing standing: on a logged-in
      // shell it points at our own handle.
      var link = document.querySelector('a[href^="/"][role="link"] img[alt*="profile picture" i]');
      var href = link && link.closest('a') && link.closest('a').getAttribute('href');
      var seg = href && href.split('/').filter(Boolean)[0];
      return seg && /^[A-Za-z0-9._]{1,30}$/.test(seg) ? seg : null;
    })()`).catch(() => null) as string | null;

    return fromDom && fromDom.trim() ? fromDom.trim() : null;
  }

  async submitChallenge(tenantId: string, code: string): Promise<LoginResult> {
    const page = this.pendingChallenge.get(tenantId);
    if (!page) return { status: 'failed', error: 'Tidak ada proses login yang menunggu kode' };

    try {
      const selector = 'input[name="verificationCode"], input[name="security_code"], input[aria-label*="code" i]';
      await page.waitForSelector(selector, { timeout: 10_000 });
      await page.type(selector, code, { delay: 10 });
      await clickButtonByText(page, /Confirm|Submit|Next/, 5000);

      const result = await this.classifyOutcome(page);
      if (result.status !== 'challenge_required') this.pendingChallenge.delete(tenantId);
      if (result.status === 'ready') {
        const username = this.pendingUsernames.get(tenantId);
        if (username) await this.persistOwnUsername(tenantId, username);
      }
      if (result.status === 'failed') await this.closeContext(tenantId);
      return result;
    } catch (err) {
      await this.closeContext(tenantId);
      return { status: 'failed', error: err instanceof Error ? err.message : 'Gagal mengirim kode verifikasi' };
    }
  }

  /**
   * A short-lived tab, like every other on-demand action — never
   * `getActivePage`, which hands back the same long-lived page `DmWatcher`
   * keeps an inbox `MutationObserver` running on. Confirmed live: sending
   * through that page navigates it to `/direct/t/<threadId>/`, which tears
   * the observer down along with it, and inbound messages stop arriving
   * from that point on until the next reattach.
   */
  async sendDm(tenantId: string, threadId: string, text: string, username?: string): Promise<void> {
    const page = await this.newPage(tenantId);
    if (!page) throw new NoActiveSessionError('Tidak ada sesi Instagram yang aktif untuk tenant ini');
    try {
      const ownUsername = await this.getOwnUsername(tenantId);
      // Taken before anything is typed: only a message that appears after
      // this instant can be the one we are sending now. A few seconds of
      // slack absorbs clock differences between here and Instagram.
      const startedAt = Date.now() - 5_000;

      // Retry safety, asked of a source that has a clock. A queue retry lands
      // here within minutes, so "did we already send this text recently?" is
      // the real question — not "does this text appear in the thread", which
      // is true of every line the bot has ever repeated. When the username is
      // unknown there is nobody to ask, and the page scan inside
      // `sendThreadMessage` stays as the weaker fallback.
      if (username) {
        if (await dmLanded(page, username, text, { sinceMs: Date.now() - 10 * 60_000 })) return;
      }

      try {
        await sendThreadMessage(page, threadId, text, ownUsername, { skipDuplicateScan: !!username });
      } catch (err) {
        // The thread scrape cannot see a message Instagram rendered as a
        // link preview, and every opener this bot sends names a domain — so
        // "typed but not visible" was reported as a failure for messages
        // that had landed, and the queue's retries delivered the same
        // opening line to one prospect three times. Instagram's own inbox
        // can see it, and settles the question before a retry is earned.
        if (!(err instanceof SendNotConfirmedError) || !username) throw err;
        if (!(await dmLanded(page, username, text, { sinceMs: startedAt }))) throw err;
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) this.forgetSession(tenantId);
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async logout(tenantId: string): Promise<void> {
    await this.closeContext(tenantId);
    const window = this.loginWindows.get(tenantId);
    if (window) {
      // A login window left open would keep writing to the profile directory
      // being deleted underneath it, and on the next poll would report a
      // session for a connection the operator just revoked.
      this.loginWindows.delete(tenantId);
      await window.close().catch(() => {});
    }
    this.ownUsernames.delete(tenantId);
    this.capturedCookies.delete(tenantId);
    await fs.rm(this.profileDir(tenantId), { recursive: true, force: true }).catch(() => {});
  }

  /** Closes every open browser cleanly — called on process shutdown so a
   * normal `tsx watch` reload or `Ctrl+C` doesn't leave a profile in the
   * uncleanly-shut-down state `clearCrashedSessionState` above exists to
   * recover from in the first place. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.contexts.keys()].map((tenantId) => this.closeContext(tenantId)));
  }
}
