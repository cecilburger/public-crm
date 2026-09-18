import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { sendThreadMessage, clickButtonByText, SessionExpiredError } from './dmScraperPuppeteer.ts';

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
    if (existing) return existing;

    const inFlight = this.launching.get(tenantId);
    if (inFlight) return inFlight;

    const launch = (async () => {
      if (!(await this.hasSession(tenantId))) return null;
      await this.clearCrashedSessionState(tenantId);
      const browser = await puppeteerExtra.launch({
        headless: HEADLESS, userDataDir: this.profileDir(tenantId), defaultViewport: { width: 1280, height: 900 },
      }) as unknown as Browser;
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

  private profileDir(tenantId: string): string {
    return path.join(this.authDir, tenantId);
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
  async sendDm(tenantId: string, threadId: string, text: string): Promise<void> {
    const page = await this.newPage(tenantId);
    if (!page) throw new NoActiveSessionError('Tidak ada sesi Instagram yang aktif untuk tenant ini');
    try {
      await sendThreadMessage(page, threadId, text);
    } catch (err) {
      if (err instanceof SessionExpiredError) this.forgetSession(tenantId);
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async logout(tenantId: string): Promise<void> {
    await this.closeContext(tenantId);
    this.ownUsernames.delete(tenantId);
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
