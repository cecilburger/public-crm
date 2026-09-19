import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
  CHECKPOINT_TEXT_RE, CHECKPOINT_URL_MARKERS, LOGGED_OUT_TEXT_RE, LOGGED_OUT_URL_MARKERS, URLS,
} from './selectors.ts';

// Same interop dance as `apps/ig-bridge/src/sessionManager.ts`, and for the
// same reason: `puppeteer-extra`'s default export needs CJS/ESM interop this
// workspace's tsconfig does not enable, and `addExtra`'s own typings are pinned
// to a different puppeteer version than the one installed. `launch()` still
// returns a real instance of *our* puppeteer, so the result is cast back.
const puppeteerExtra = addExtra(puppeteer as unknown as Parameters<typeof addExtra>[0]);
puppeteerExtra.use(StealthPlugin());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Watching runs headless by default; the login window never does, because a
 * human has to see it. */
const HEADLESS = process.env.FB_BRIDGE_HEADLESS !== 'false';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** How long the login window stays open waiting for the operator, and how often
 * it is checked. Generous: a checkpoint plus a 2FA code from a phone is a
 * several-minute job, and timing out underneath someone mid-login would throw
 * away the work and, worse, look to Facebook like a second login attempt. */
const LOGIN_WINDOW_TIMEOUT_MS = 15 * 60_000;
const LOGIN_POLL_INTERVAL_MS = 3_000;

/** The persisted session is gone — the operator has to log in again. */
export class SessionExpiredError extends Error {}
/** Facebook is asking a human something (checkpoint, 2FA, account review).
 * Deliberately distinct from expiry: retrying does nothing, a person must act. */
export class CheckpointRequiredError extends Error {}
/** Nothing is connected for this tenant at all. */
export class NoActiveSessionError extends Error {}

export type SessionStatus = 'disconnected' | 'awaiting_login' | 'ready' | 'checkpoint_required' | 'error';

export interface SessionState {
  status: SessionStatus;
  pageId: string | null;
  pageName: string | null;
  lastError: string | null;
}

interface PageMarker {
  pageId: string;
  pageName: string;
}

/**
 * Owns one persistent Chromium profile per tenant and nothing else.
 *
 * NO CREDENTIAL EVER PASSES THROUGH THIS CLASS. There is no `login(username,
 * password)` here, unlike `apps/ig-bridge` — the operator opens a real browser
 * window and logs in by hand, exactly as they would on their own laptop, and
 * what persists afterwards is Chromium's own cookie jar inside `userDataDir`.
 * That is what makes "do not store email/password in plaintext" true by
 * construction rather than by discipline, and it is also the only honest way to
 * handle a checkpoint or a 2FA prompt: a person answers it in the window.
 *
 * Nothing here tries to defeat a CAPTCHA, a checkpoint or two-factor auth. When
 * one appears the bridge stops, says so, and waits for the operator.
 *
 * TREAT THE PROFILE DIRECTORY AS A CREDENTIAL. `.fb_bridge_auth/<tenant>/`
 * holds a live logged-in Facebook session; anyone who can read it can act as
 * that account. It is gitignored, it is never logged, and it is never sent
 * anywhere.
 */
export class SessionManager {
  private browsers = new Map<string, Browser>();
  private launching = new Map<string, Promise<Browser | null>>();
  private markers = new Map<string, PageMarker>();
  private loginWindows = new Map<string, Browser>();
  private lastErrors = new Map<string, string>();

  constructor(private authDir: string) {}

  private profileDir(tenantId: string): string {
    return path.join(this.authDir, tenantId);
  }

  /** Public so the watchers can keep their own per-tenant state (thread
   * anchors, seen comment ids) beside the profile without duplicating the
   * naming scheme. */
  getProfileDir(tenantId: string): string {
    return this.profileDir(tenantId);
  }

  private markerFile(tenantId: string): string {
    return path.join(this.profileDir(tenantId), '.page');
  }

  /**
   * Which Page this tenant connected, remembered on disk next to the profile.
   *
   * `tsx watch` restarts on every save, and in production any redeploy or crash
   * does the same. `apps/ig-bridge` learned that an in-memory-only record of
   * "who is connected" goes stale on every one of those — silently, while the
   * console still showed 'ready' — so a restart could not resume on its own and
   * needed a manual reconnect every time. A tiny file avoids all of that.
   */
  async getPageMarker(tenantId: string): Promise<PageMarker | null> {
    const cached = this.markers.get(tenantId);
    if (cached) return cached;
    try {
      const parsed = JSON.parse(await fs.readFile(this.markerFile(tenantId), 'utf8')) as PageMarker;
      if (parsed?.pageId) {
        this.markers.set(tenantId, parsed);
        return parsed;
      }
    } catch {
      // Never connected, or forgotten below.
    }
    return null;
  }

  private async persistPageMarker(tenantId: string, marker: PageMarker): Promise<void> {
    this.markers.set(tenantId, marker);
    await fs.mkdir(this.profileDir(tenantId), { recursive: true }).catch(() => {});
    await fs.writeFile(this.markerFile(tenantId), JSON.stringify(marker), 'utf8').catch(() => {});
  }

  /** Every tenant with a connected Page, read from disk — this is what the
   * watchers iterate, so it has to reflect what is on disk rather than what
   * happened to connect during this process's lifetime. */
  async knownTenantIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.authDir);
    } catch {
      return [];
    }
    const known: string[] = [];
    for (const tenantId of entries) {
      if (await this.getPageMarker(tenantId)) known.push(tenantId);
    }
    return known;
  }

  async hasSession(tenantId: string): Promise<boolean> {
    try {
      return (await fs.readdir(this.profileDir(tenantId))).length > 0;
    } catch {
      return false;
    }
  }

  /** Lets a watcher notice that a tenant it marked "observed" is sitting on a
   * dead CDP connection — its observer died with that browser and nothing
   * re-attaches it on its own. */
  isConnected(tenantId: string): boolean {
    return this.browsers.get(tenantId)?.connected ?? false;
  }

  async status(tenantId: string): Promise<SessionState> {
    const marker = await this.getPageMarker(tenantId);
    const lastError = this.lastErrors.get(tenantId) ?? null;
    const base = { pageId: marker?.pageId ?? null, pageName: marker?.pageName ?? null, lastError };

    if (this.loginWindows.has(tenantId)) return { ...base, status: 'awaiting_login' };
    if (!marker || !(await this.hasSession(tenantId))) return { ...base, status: 'disconnected' };
    if (lastError) return { ...base, status: 'error' };
    return { ...base, status: 'ready' };
  }

  /* ------------------------------------------------------------- browsers */

  /**
   * Chrome refuses a second launch against the same `userDataDir` outright —
   * its own single-instance lock. `apps/ig-bridge` hit this live with two
   * concurrent callers (a housekeeping tick and a route handler) each seeing an
   * empty cache and both launching. Memoising the in-flight launch per tenant
   * makes every concurrent caller await the one real launch.
   */
  private async ensureBrowser(tenantId: string): Promise<Browser | null> {
    const existing = this.browsers.get(tenantId);
    // A cached browser whose CDP connection has died fails every `newPage()`
    // call on it forever, with the OS process still alive. Re-checking here and
    // falling through to relaunch is what makes that self-heal.
    if (existing) {
      if (existing.connected) return existing;
      this.browsers.delete(tenantId);
      await existing.close().catch(() => {});
    }

    // A login window is a browser on this same profile. Launching a second one
    // beside it would hit Chrome's lock and kill the operator's half-finished
    // login.
    if (this.loginWindows.has(tenantId)) return null;

    const inFlight = this.launching.get(tenantId);
    if (inFlight) return inFlight;

    const launch = (async () => {
      if (!(await this.hasSession(tenantId))) return null;
      await this.clearCrashedSessionState(tenantId);
      const browser = await this.launch(tenantId, HEADLESS);
      this.browsers.set(tenantId, browser);
      return browser;
    })();
    this.launching.set(tenantId, launch);
    try {
      return await launch;
    } finally {
      this.launching.delete(tenantId);
    }
  }

  private async launch(tenantId: string, headless: boolean): Promise<Browser> {
    return await puppeteerExtra.launch({
      headless,
      userDataDir: this.profileDir(tenantId),
      defaultViewport: headless ? { width: 1400, height: 1000 } : null,
    }) as unknown as Browser;
  }

  /**
   * Launching against a profile that was last shut down uncleanly fails
   * outright in headless mode the moment Chrome's saved session tries to
   * restore more than one tab ("Multiple targets are not supported in headless
   * mode" — confirmed live in `apps/ig-bridge`). This bridge legitimately runs
   * several tabs at once, so any crash leaves exactly that state. Deleting
   * Chrome's own session-restore artifacts before every launch heads it off;
   * `Cookies` and the rest of the authenticated profile are untouched.
   */
  private async clearCrashedSessionState(tenantId: string): Promise<void> {
    const defaultDir = path.join(this.profileDir(tenantId), 'Default');
    const artifacts = ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];
    await Promise.all(artifacts.map((name) =>
      fs.rm(path.join(defaultDir, name), { recursive: true, force: true }).catch(() => {})));
  }

  /** The long-lived page a watcher installs its observer on. */
  async getActivePage(tenantId: string): Promise<Page | null> {
    const browser = await this.ensureBrowser(tenantId);
    if (!browser) return null;
    const pages = await browser.pages();
    return this.configurePage(pages[0] ?? await browser.newPage());
  }

  /** A fresh tab for a short trip (reading one thread, sweeping comments) that
   * must not disturb the long-lived observer page — re-navigating that one
   * tears its observer down, which `apps/ig-bridge` confirmed live stops
   * inbound messages arriving until the next reattach. */
  async newPage(tenantId: string): Promise<Page | null> {
    const browser = await this.ensureBrowser(tenantId);
    if (!browser) return null;
    return this.configurePage(await browser.newPage());
  }

  /** Puppeteer has no launch-level user agent option — it is per page. Applied
   * every time a page is handed out so no call site can forget it. */
  private async configurePage(page: Page): Promise<Page> {
    await page.setUserAgent(USER_AGENT).catch(() => {});
    return page;
  }

  /* ---------------------------------------------------------------- login */

  /**
   * Opens a real, visible Chromium window on Facebook's login page and returns
   * immediately. The operator logs in there by hand — password, 2FA, checkpoint
   * and all — and this polls until the window is somewhere that is not a login
   * wall, then closes it so the profile can be reused headlessly.
   *
   * Returning immediately rather than blocking for fifteen minutes is what lets
   * the CRM route answer the operator's click right away with 'awaiting_login'
   * and let them poll for status, instead of holding an HTTP request open for
   * the length of a human login.
   */
  async openLoginWindow(
    tenantId: string, marker: PageMarker, onSettled?: (state: SessionState) => void,
  ): Promise<SessionState> {
    if (this.loginWindows.has(tenantId)) return this.status(tenantId);

    await this.closeBrowser(tenantId);
    await this.clearCrashedSessionState(tenantId);
    this.lastErrors.delete(tenantId);
    await this.persistPageMarker(tenantId, marker);

    const browser = await this.launch(tenantId, false);
    this.loginWindows.set(tenantId, browser);

    const pages = await browser.pages();
    const page = await this.configurePage(pages[0] ?? await browser.newPage());
    await page.goto(URLS.login, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

    void this.awaitLogin(tenantId, page).then(async (state) => {
      this.loginWindows.delete(tenantId);
      await browser.close().catch(() => {});
      onSettled?.(state);
    });

    return { status: 'awaiting_login', pageId: marker.pageId, pageName: marker.pageName, lastError: null };
  }

  /** Polls the operator's own window until it is no longer a login wall. */
  private async awaitLogin(tenantId: string, page: Page): Promise<SessionState> {
    const deadline = Date.now() + LOGIN_WINDOW_TIMEOUT_MS;
    const marker = await this.getPageMarker(tenantId);
    const base = { pageId: marker?.pageId ?? null, pageName: marker?.pageName ?? null };

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        // The operator closed the window. Whether they finished is decided by
        // whether the profile now holds a session, not by guessing.
        const ok = await this.hasSession(tenantId);
        const lastError = ok ? null : 'Jendela login ditutup sebelum login selesai';
        if (lastError) this.lastErrors.set(tenantId, lastError);
        return { ...base, status: ok ? 'ready' : 'disconnected', lastError };
      }

      const url = page.url();
      const stillOnLoginWall = LOGGED_OUT_URL_MARKERS.some((marker) => url.includes(marker));
      if (!stillOnLoginWall && url.includes('facebook.com')) {
        this.lastErrors.delete(tenantId);
        return { ...base, status: 'ready', lastError: null };
      }
      await sleep(LOGIN_POLL_INTERVAL_MS);
    }

    const lastError = 'Waktu login habis — operator tidak menyelesaikan login dalam 15 menit';
    this.lastErrors.set(tenantId, lastError);
    return { ...base, status: 'error', lastError };
  }

  /* --------------------------------------------------------- health / teardown */

  /**
   * Whether the page we are looking at is really logged in, checked on both the
   * URL and the body text.
   *
   * The text check is not redundant. Facebook geo-localises its UI, so an
   * Indonesian login wall served at a perfectly ordinary URL would otherwise
   * read as a healthy page that simply has no messages in it — silence, which
   * is the one failure mode this whole design exists to avoid.
   */
  async assertUsable(page: Page): Promise<void> {
    const url = page.url();
    if (CHECKPOINT_URL_MARKERS.some((marker) => url.includes(marker))) {
      throw new CheckpointRequiredError('Facebook meminta verifikasi manual (checkpoint/2FA) — selesaikan lewat jendela login');
    }
    if (LOGGED_OUT_URL_MARKERS.some((marker) => url.includes(marker))) {
      throw new SessionExpiredError('Sesi Facebook sudah tidak aktif — operator perlu login ulang');
    }

    const body = await page.evaluate(
      '(document.body && document.body.innerText ? document.body.innerText : "").slice(0, 1500)',
    ).catch(() => '') as string;
    if (CHECKPOINT_TEXT_RE.test(body)) {
      throw new CheckpointRequiredError('Facebook meminta verifikasi manual (checkpoint/2FA) — selesaikan lewat jendela login');
    }
    if (LOGGED_OUT_TEXT_RE.test(body)) {
      throw new SessionExpiredError('Sesi Facebook sudah tidak aktif — operator perlu login ulang');
    }
  }

  /** Records why a tenant stopped working, so `status()` reports it instead of
   * claiming 'ready' for a session that is actually broken. */
  noteError(tenantId: string, error: string): void {
    this.lastErrors.set(tenantId, error);
  }

  /**
   * Drops in-memory session state after a read found the session dead, without
   * deleting the profile — the operator may still be able to log in against it.
   * Removing the marker is what stops `knownTenantIds` retrying a session
   * already known to be dead on every following tick.
   */
  forgetSession(tenantId: string, reason: string): void {
    this.lastErrors.set(tenantId, reason);
    this.markers.delete(tenantId);
    void fs.rm(this.markerFile(tenantId), { force: true }).catch(() => {});
    void this.closeBrowser(tenantId);
  }

  private async closeBrowser(tenantId: string): Promise<void> {
    // A housekeeping-driven launch may be in flight; waiting for it to land
    // means it gets closed here instead of surviving as an orphaned second
    // Chrome pointed at the same profile.
    const inFlight = this.launching.get(tenantId);
    if (inFlight) await inFlight.catch(() => {});

    const browser = this.browsers.get(tenantId);
    if (browser) {
      this.browsers.delete(tenantId);
      await browser.close().catch(() => {});
    }
  }

  /** Disconnects a tenant and deletes their profile — the only way the stored
   * session is destroyed, and the reason "disconnect" in the CRM really does
   * revoke this bridge's access rather than just hiding it. */
  async logout(tenantId: string): Promise<void> {
    const loginWindow = this.loginWindows.get(tenantId);
    if (loginWindow) {
      this.loginWindows.delete(tenantId);
      await loginWindow.close().catch(() => {});
    }
    await this.closeBrowser(tenantId);
    this.markers.delete(tenantId);
    this.lastErrors.delete(tenantId);
    await fs.rm(this.profileDir(tenantId), { recursive: true, force: true }).catch(() => {});
  }

  /** Closes every browser cleanly on shutdown, so a routine `tsx watch` reload
   * does not leave a profile in the uncleanly-shut-down state
   * `clearCrashedSessionState` exists to recover from. */
  async closeAll(): Promise<void> {
    await Promise.all([
      ...[...this.browsers.keys()].map((tenantId) => this.closeBrowser(tenantId)),
      ...[...this.loginWindows.values()].map((browser) => browser.close().catch(() => {})),
    ]);
    this.loginWindows.clear();
  }
}
