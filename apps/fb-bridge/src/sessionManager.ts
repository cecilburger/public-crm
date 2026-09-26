import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { DEBUG, trace } from './debug.ts';
import type { Browser, Page } from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import {
  BIZ_COMPOSER, BIZ_THREAD, CHECKPOINT_TEXT_RE, CHECKPOINT_URL_MARKERS, COMMENT_ACTIONS, COMPOSER,
  LOGGED_OUT_TEXT_RE, LOGGED_OUT_URL_MARKERS, PROFILE_ID_RE, THREAD, URLS,
} from './selectors.ts';
import {
  assertBusinessSuiteThreadSurface, assertPrivateMessageSurface, fireClick, fireCommentControl, focusComposer,
  hasCommentControl, hasPrivateComposer,
  listButtonLabels, readCommentHtml, readComposerText, readContainerHtml, readPostSurfaceHtml,
} from './pageHtml.ts';
import { countOwnCommentReplies, parseFacebookComments } from './parsers/comments.ts';
import { countMessagesWithText, messageIdsWithText } from './parsers/businessSuiteThread.ts';
import { firstHrefMatch, parseHtml } from './parsers/dom.ts';
import { businessSuiteTransport } from './transport/businessSuite.ts';
import { messengerDotComTransport } from './transport/messengerDotCom.ts';
import type { TransportContext, ThreadTransport } from './transport/types.ts';
import {
  confirmPrivateDelivery, enterPrivateText, runPrivateReply, waitForSendEnabled,
} from './privateReply.ts';
import { keepRenderingInBackground } from './commentPulse.ts';
import type { Logger } from './messengerWatcher.ts';

// Same interop dance as `apps/ig-bridge/src/sessionManager.ts`, and for the
// same reason: `puppeteer-extra`'s default export needs CJS/ESM interop this
// workspace's tsconfig does not enable, and `addExtra`'s own typings are pinned
// to a different puppeteer version than the one installed. `launch()` still
// returns a real instance of *our* puppeteer, so the result is cast back.
const puppeteerExtra = addExtra(puppeteer as unknown as Parameters<typeof addExtra>[0]);
puppeteerExtra.use(StealthPlugin());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SILENT: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The private reply's own budgets. The dialog was measured opening within
 * ~0.5–6s; "Send Message" enabling a few hundred ms after the text lands. The
 * confirmation re-reads the customer's conversation FRESH at these offsets
 * after the send — a tab that was open before the send never showed the
 * delivered message live — and a sighting must survive the dwell.
 */
const PRIVATE_SURFACE_BUDGET_MS = 15_000;
const PRIVATE_SEND_ENABLE_BUDGET_MS = 5_000;
const PRIVATE_CONFIRM_CHECKS_MS = [2_000, 10_000, 20_000] as const;
const PRIVATE_CONFIRM_DWELL_MS = 3_000;
// Bounded so the whole private reply stays well inside the worker's 300s
// request timeout: a pressed send must come back as "confirmed" or "may have
// been sent", never as a dropped connection.
const PRIVATE_THREAD_READ_BUDGET_MS = 25_000;

/** Polls a condition until it holds or the budget runs out. Facebook renders a
 * post's comments well after `domcontentloaded`, and a fixed sleep either wastes
 * seconds or lands early. */
async function waitFor(check: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

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

/** How often a public reply's own comment is re-read while waiting to see it
 * land — a plain in-place read, never a reload, so a 60s window costs no more
 * than a handful of DOM reads. */
const COMMENT_CONFIRM_POLL_MS = 1_000;

/** The persisted session is gone — the operator has to log in again. */
export class SessionExpiredError extends Error {}
/** Facebook is asking a human something (checkpoint, 2FA, account review).
 * Deliberately distinct from expiry: retrying does nothing, a person must act. */
export class CheckpointRequiredError extends Error {}
/** Nothing is connected for this tenant at all. */
export class NoActiveSessionError extends Error {}
/**
 * The send path exists as a contract but cannot run yet.
 *
 * Driving Messenger's composer needs selectors read off the real site, and
 * every selector guessed for this bridge so far has been wrong — four out of
 * four. A guessed composer is worse than no composer: a failed *read* delivers
 * nothing, while a failed *send* leaves an agent believing they answered a
 * customer. So the capability gate lives here, at the only place that would
 * actually do the sending, rather than in a flag somewhere upstream that could
 * be flipped by accident.
 */
export class SenderNotImplementedError extends Error {}
/**
 * The thread has no composer, so it cannot be replied to at all.
 *
 * Confirmed live: a conversation still sitting as a message request renders its
 * whole transcript and offers no message box — the same behaviour Instagram has,
 * where the composer only appears once a request is accepted. Permanent by
 * nature: waiting or retrying will never produce one. Accepting the request on
 * the operator's behalf is deliberately not done here.
 */
export class ThreadRequiresAcceptanceError extends Error {}
/** Typed into the composer, but never seen arriving in the transcript. */
export class SendNotConfirmedError extends Error {}
/**
 * A DM given up on before a single character was typed, so nothing reached
 * Facebook and trying again cannot send it twice. A subclass so every place
 * that handles an unconfirmed send still does; only the DM route tells the two
 * apart.
 */
export class SendNotAttemptedError extends SendNotConfirmedError {}

/**
 * A comment action whose DOM path has not been verified against the live site
 * yet. Answered as 501 so the CRM fails the job with a readable reason instead
 * of retrying into a capability that does not exist. The same stance
 * `sendMessage` took before its composer was probed — and it disappears the
 * same way, by the action landing rather than by anything upstream changing.
 */
export class CommentActionNotImplementedError extends Error {}
/** The comment could not be found on the post — deleted, hidden, or the post
 * is not the Page's. Permanent. */
export class CommentNotFoundError extends Error {}
/** Facebook offers no such action for this comment or this person: no reply
 * box, or no private-message affordance. Permanent, and carries the code the
 * CRM records verbatim. */
export class CommentActionUnavailableError extends Error {
  constructor(message: string, public readonly code: 'reply_unavailable' | 'private_reply_unavailable') {
    super(message);
  }
}

export interface CommentTarget {
  postId: string;
  commentId: string;
  text: string;
}

export type SessionStatus = 'disconnected' | 'awaiting_login' | 'ready' | 'checkpoint_required' | 'error';

export interface SessionState {
  status: SessionStatus;
  pageId: string | null;
  pageName: string | null;
  lastError: string | null;
}

export interface PageMarker {
  pageId: string;
  pageName: string;
  /** The tenant the CRM named when it connected this Page; profiles from
   * before the CRM said so have none, and the session key speaks instead. */
  tenantId?: string | null;
  /**
   * The Business Suite asset id, when this connection is a Page.
   *
   * Its presence is what selects the Business Suite transport, so it is the
   * single switch between reading a Page's inbox and reading a personal one.
   * Optional because every connection made before Page support existed has no
   * such id on disk, and those must keep working as messenger.com connections
   * rather than failing to load.
   *
   * NOT the Page id. Confirmed live: the same Page is `61594393176093` in a
   * profile URL and `1225922357281590` as a Business Suite asset. Overloading
   * one field with both would produce URLs that load a valid-looking page
   * containing none of this tenant's conversations.
   */
  assetId?: string | null;
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

  constructor(private authDir: string, private log: Logger = SILENT) {}

  private profileDir(sessionKey: string): string {
    return path.join(this.authDir, sessionKey);
  }

  /** Public so the watchers can keep their own per-tenant state (thread
   * anchors, seen comment ids) beside the profile without duplicating the
   * naming scheme. */
  getProfileDir(sessionKey: string): string {
    return this.profileDir(sessionKey);
  }

  private markerFile(sessionKey: string): string {
    return path.join(this.profileDir(sessionKey), '.page');
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
  async getPageMarker(sessionKey: string): Promise<PageMarker | null> {
    const cached = this.markers.get(sessionKey);
    if (cached) return cached;
    try {
      const parsed = JSON.parse(await fs.readFile(this.markerFile(sessionKey), 'utf8')) as PageMarker;
      if (parsed?.pageId) {
        this.markers.set(sessionKey, parsed);
        return parsed;
      }
    } catch {
      // Never connected, or forgotten below.
    }
    return null;
  }

  private async persistPageMarker(sessionKey: string, marker: PageMarker): Promise<void> {
    this.markers.set(sessionKey, marker);
    await fs.mkdir(this.profileDir(sessionKey), { recursive: true }).catch(() => {});
    await fs.writeFile(this.markerFile(sessionKey), JSON.stringify(marker), 'utf8').catch(() => {});
  }

  /** Every tenant with a connected Page, read from disk — this is what the
   * watchers iterate, so it has to reflect what is on disk rather than what
   * happened to connect during this process's lifetime. */
  async knownSessionKeys(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.authDir);
    } catch {
      return [];
    }
    const known: string[] = [];
    for (const sessionKey of entries) {
      if (await this.getPageMarker(sessionKey)) known.push(sessionKey);
    }
    return known;
  }

  async hasSession(sessionKey: string): Promise<boolean> {
    try {
      return (await fs.readdir(this.profileDir(sessionKey))).length > 0;
    } catch {
      return false;
    }
  }

  /** Lets a watcher notice that a tenant it marked "observed" is sitting on a
   * dead CDP connection — its observer died with that browser and nothing
   * re-attaches it on its own. */
  isConnected(sessionKey: string): boolean {
    return this.browsers.get(sessionKey)?.connected ?? false;
  }

  async status(sessionKey: string): Promise<SessionState> {
    const marker = await this.getPageMarker(sessionKey);
    const lastError = this.lastErrors.get(sessionKey) ?? null;
    const base = { pageId: marker?.pageId ?? null, pageName: marker?.pageName ?? null, lastError };

    if (this.loginWindows.has(sessionKey)) return { ...base, status: 'awaiting_login' };
    if (!marker || !(await this.hasSession(sessionKey))) return { ...base, status: 'disconnected' };
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
  private async ensureBrowser(sessionKey: string): Promise<Browser | null> {
    const existing = this.browsers.get(sessionKey);
    // A cached browser whose CDP connection has died fails every `newPage()`
    // call on it forever, with the OS process still alive. Re-checking here and
    // falling through to relaunch is what makes that self-heal.
    if (existing) {
      if (existing.connected) return existing;
      this.browsers.delete(sessionKey);
      await existing.close().catch(() => {});
    }

    // A login window is a browser on this same profile. Launching a second one
    // beside it would hit Chrome's lock and kill the operator's half-finished
    // login.
    if (this.loginWindows.has(sessionKey)) return null;

    const inFlight = this.launching.get(sessionKey);
    if (inFlight) return inFlight;

    const launch = (async () => {
      if (!(await this.hasSession(sessionKey))) return null;
      await this.clearCrashedSessionState(sessionKey);
      const browser = await this.launch(sessionKey, HEADLESS);
      this.browsers.set(sessionKey, browser);
      return browser;
    })();
    this.launching.set(sessionKey, launch);
    try {
      return await launch;
    } finally {
      this.launching.delete(sessionKey);
    }
  }

  private async launch(sessionKey: string, headless: boolean): Promise<Browser> {
    return await puppeteerExtra.launch({
      headless,
      userDataDir: this.profileDir(sessionKey),
      defaultViewport: headless ? { width: 1400, height: 1000 } : null,
      // Puppeteer's default is three minutes, which is not a timeout so much as
      // a hang. Confirmed live: one wedged in-page call held a comment action
      // for 188 seconds before failing, long past every budget this file sets
      // and long enough for the queue to look stuck. Sixty seconds is still far
      // above any healthy call here.
      protocolTimeout: 60_000,
      // A second Chromium beside the operator's own browser and a local dev
      // stack is enough to run a laptop out of memory — confirmed live, when
      // orphaned instances from earlier restarts accumulated and the kernel
      // killed this service mid-request with nothing in the log. These are the
      // flags that matter for a headless scraper: no GPU process, no shared
      // memory file that macOS sizes badly under Docker-less Chrome, and no
      // background timer throttling (the watcher's observer must keep firing
      // in a tab nobody is looking at).
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
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
  private async clearCrashedSessionState(sessionKey: string): Promise<void> {
    const defaultDir = path.join(this.profileDir(sessionKey), 'Default');
    const artifacts = ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs'];
    await Promise.all(artifacts.map((name) =>
      fs.rm(path.join(defaultDir, name), { recursive: true, force: true }).catch(() => {})));
  }

  /** The long-lived page a watcher installs its observer on. */
  async getActivePage(sessionKey: string): Promise<Page | null> {
    const browser = await this.ensureBrowser(sessionKey);
    if (!browser) return null;
    const pages = await browser.pages();
    return this.configurePage(pages[0] ?? await browser.newPage());
  }

  /** A fresh tab for a short trip (reading one thread, sweeping comments) that
   * must not disturb the long-lived observer page — re-navigating that one
   * tears its observer down, which `apps/ig-bridge` confirmed live stops
   * inbound messages arriving until the next reattach. */
  async newPage(sessionKey: string): Promise<Page | null> {
    const browser = await this.ensureBrowser(sessionKey);
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
    sessionKey: string, marker: PageMarker, onSettled?: (state: SessionState) => void,
  ): Promise<SessionState> {
    if (this.loginWindows.has(sessionKey)) return this.status(sessionKey);

    await this.closeBrowser(sessionKey);
    await this.clearCrashedSessionState(sessionKey);
    this.lastErrors.delete(sessionKey);
    await this.persistPageMarker(sessionKey, marker);

    const browser = await this.launch(sessionKey, false);
    this.loginWindows.set(sessionKey, browser);

    const pages = await browser.pages();
    const page = await this.configurePage(pages[0] ?? await browser.newPage());
    await page.goto(URLS.login, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

    void this.awaitLogin(sessionKey, page).then(async (state) => {
      this.loginWindows.delete(sessionKey);
      await browser.close().catch(() => {});
      onSettled?.(state);
    });

    return { status: 'awaiting_login', pageId: marker.pageId, pageName: marker.pageName, lastError: null };
  }

  /** Polls the operator's own window until it is no longer a login wall. */
  private async awaitLogin(sessionKey: string, page: Page): Promise<SessionState> {
    const deadline = Date.now() + LOGIN_WINDOW_TIMEOUT_MS;
    const marker = await this.getPageMarker(sessionKey);
    const base = { pageId: marker?.pageId ?? null, pageName: marker?.pageName ?? null };

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        // The operator closed the window. Whether they finished is decided by
        // whether the profile now holds a session, not by guessing.
        const ok = await this.hasSession(sessionKey);
        const lastError = ok ? null : 'Jendela login ditutup sebelum login selesai';
        if (lastError) this.lastErrors.set(sessionKey, lastError);
        return { ...base, status: ok ? 'ready' : 'disconnected', lastError };
      }

      // A URL cannot answer this question. Facebook serves its logged-OUT home
      // page at https://www.facebook.com/ and its logged-IN home page at the
      // same address, so "the URL no longer says /login" is not evidence of a
      // session. Confirmed live, twice: this returned 'ready' 42 seconds after
      // the window opened — before anyone had typed a password — and the
      // watcher then correctly found a login wall and tore the session down,
      // deleting the Page marker and forcing the whole connect flow to start
      // over. The operator never got a chance to log in at all.
      //
      // `assertUsable` is the check that does work, and it is the same one the
      // watchers already trust: it reads the page text, where a login wall
      // genuinely is distinguishable (confirmed live against the real site).
      // A throw here is the *normal* state while someone is still logging in —
      // a login form, a 2FA prompt, a checkpoint are all things it rejects — so
      // it means "keep waiting", never "fail". Only the window closing or the
      // deadline below ends this loop.
      // POSITIVE PROOF, not the absence of a negative.
      //
      // Two earlier versions of this asked "does the page look logged out?" —
      // first from the URL, then from the page text — and both declared success
      // on the first screen they did not recognise. Facebook shows several:
      // a loading spinner, "Save your login info?", a cookie dialog, the
      // redirect between them. Each one passed as "logged in", so the bridge
      // closed the operator's login window mid-typing, opened a fresh browser
      // against a session that did not exist, and landed back on the login
      // form. From the operator's side that looks exactly like the page
      // refreshing and eating what they typed — confirmed live, five times.
      //
      // `c_user` is set only for an authenticated session, so its presence is
      // the thing to wait for. Only the cookie's *existence* is read here;
      // its value is a credential and is never logged, stored or sent anywhere.
      const cookies = await page.cookies('https://www.facebook.com').catch(() => []);
      if (cookies.some((cookie) => cookie.name === 'c_user' && cookie.value)) {
        this.lastErrors.delete(sessionKey);
        return { ...base, status: 'ready', lastError: null };
      }
      await sleep(LOGIN_POLL_INTERVAL_MS);
    }

    const lastError = 'Waktu login habis — operator tidak menyelesaikan login dalam 15 menit';
    this.lastErrors.set(sessionKey, lastError);
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

    // An unreadable page is not a healthy one. `evaluate` fails routinely right
    // after a navigation ("Execution context was destroyed" while Facebook is
    // mid-redirect), and swallowing that into an empty string made every check
    // below vacuously pass — absence of evidence read as evidence of absence.
    // Confirmed live: the login window was declared ready five seconds after
    // opening, while it still showed the login form, because the body read
    // happened mid-redirect and came back empty.
    //
    // This throws a plain Error on purpose, not SessionExpiredError: the page
    // being unreadable says nothing about whether the session is dead. The
    // login poller treats any throw as "keep waiting", and the watchers act
    // only on the two specific error types, so a transient failure here is
    // retried on the next pass instead of tearing down a working session.
    // Callers navigate with `waitUntil: 'domcontentloaded'`, which fires long
    // before Facebook's React app has painted anything — so an empty body right
    // after a navigation is the ordinary case, not a failure. A first version
    // of this check threw on it immediately and broke every read against the
    // real site. Polling until there is text to judge is what makes the
    // distinction meaningful: "no text yet" is a page still loading, while "no
    // text after several seconds" is a page we genuinely cannot read.
    // 25 seconds, not 8. Measured headless against Business Suite: DOMContent-
    // Loaded fires at ~3.6s and the first text appears at ~6s on a warm, single
    // tab. At boot the message watcher and the comment watcher navigate at the
    // same moment on a cold browser, and 8s tripped this on both of them — the
    // bridge came up, logged "belum bisa dibaca" twice, and read nothing until
    // the next reconciliation ten minutes later. A page still blank after 25s
    // is genuinely unreadable; one blank at 8s was usually just late.
    let body: string | null = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      body = await page.evaluate(
        '(document.body && document.body.innerText ? document.body.innerText : "").slice(0, 1500)',
      ).catch(() => null) as string | null;
      if (body && body.trim() !== '') break;
      await sleep(500);
    }
    if (!body || body.trim() === '') {
      throw new Error('Halaman Facebook belum bisa dibaca — kemungkinan masih memuat atau sedang dialihkan');
    }
    if (CHECKPOINT_TEXT_RE.test(body)) {
      throw new CheckpointRequiredError('Facebook meminta verifikasi manual (checkpoint/2FA) — selesaikan lewat jendela login');
    }
    if (LOGGED_OUT_TEXT_RE.test(body)) {
      throw new SessionExpiredError('Sesi Facebook sudah tidak aktif — operator perlu login ulang');
    }
  }

  /** Records why a tenant stopped working, so `status()` reports it instead of
   * claiming 'ready' for a session that is actually broken. */
  noteError(sessionKey: string, error: string): void {
    this.lastErrors.set(sessionKey, error);
  }

  /**
   * Drops in-memory session state after a read found the session dead, without
   * deleting the profile — the operator may still be able to log in against it.
   * Removing the marker is what stops `knownSessionKeys` retrying a session
   * already known to be dead on every following tick.
   */
  forgetSession(sessionKey: string, reason: string): void {
    this.lastErrors.set(sessionKey, reason);
    this.markers.delete(sessionKey);
    void fs.rm(this.markerFile(sessionKey), { force: true }).catch(() => {});
    void this.closeBrowser(sessionKey);
  }

  private async closeBrowser(sessionKey: string): Promise<void> {
    // A housekeeping-driven launch may be in flight; waiting for it to land
    // means it gets closed here instead of surviving as an orphaned second
    // Chrome pointed at the same profile.
    const inFlight = this.launching.get(sessionKey);
    if (inFlight) await inFlight.catch(() => {});

    const browser = this.browsers.get(sessionKey);
    if (browser) {
      this.browsers.delete(sessionKey);
      await browser.close().catch(() => {});
    }
  }

  /** Disconnects a tenant and deletes their profile — the only way the stored
   * session is destroyed, and the reason "disconnect" in the CRM really does
   * revoke this bridge's access rather than just hiding it. */
  /**
   * Sends a message in a thread, on whichever surface this tenant is connected
   * to.
   *
   * The mechanics are identical on both and that is not a coincidence: the
   * composer is a Lexical editor in Business Suite exactly as it is on
   * messenger.com, and neither renders a Send button. What differs is only the
   * URL, the selectors and how "ours" is recognised in the transcript — all of
   * which the transport supplies.
   *
   * Success is never reported from an emptied composer. Facebook clears it
   * optimistically even when the server rejected the message, so the proof is a
   * new bubble of our own carrying exactly this text.
   */
  async sendMessage(sessionKey: string, threadId: string, text: string): Promise<void> {
    const marker = await this.getPageMarker(sessionKey);
    const ctx: TransportContext = { pageName: marker?.pageName ?? null, assetId: marker?.assetId ?? null };
    const transport = ctx.assetId ? businessSuiteTransport : messengerDotComTransport;

    const page = await this.newPage(sessionKey);
    if (!page) throw new NoActiveSessionError('Tidak ada sesi Facebook yang aktif untuk tenant ini');

    try {
      await page.goto(transport.threadUrl(ctx, threadId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.assertUsable(page);
      await page.waitForSelector(transport.threadWaitSelectors.join(', '), { timeout: 15_000 }).catch(() => {});

      const composer = transport.composerSelectors.join(', ');
      const hasComposer = await page.waitForSelector(composer, { timeout: transport.composerWaitMs })
        .then(() => true).catch(() => false);
      if (!hasComposer) {
        throw new ThreadRequiresAcceptanceError(
          'Percakapan ini belum bisa dibalas — Facebook tidak menampilkan kotak pesan '
          + '(kemungkinan masih berupa permintaan pesan yang harus diterima manual)',
        );
      }

      // Counted *before* sending, because a reply is often the same words as an
      // earlier one ("baik kak", "siap"). Asking "is our text on screen?" would
      // report success off a message from last week — including when nothing
      // was sent at all.
      const selfName = ctx.pageName;
      const readTranscript = async () => (await transport.readTranscriptHtml(page)) ?? '';
      const settled = await settleSurface(
        page, async () => (await transport.readSurfaceHtml(page)) ?? '', SURFACE_BUDGET_MS,
      );
      trace('send', () => `surface ${settled ? 'settled' : 'still moving'} at ${page.url().slice(0, 80)}`);
      // Everything thrown up to the typing below is SendNotAttemptedError:
      // nothing has reached Facebook yet, so the CRM may try again.
      if (!settled) {
        throw new SendNotAttemptedError(
          'Percakapan Facebook masih berubah — pesan tidak diketik agar tidak terkirim ke percakapan lain',
        );
      }
      if (transport.kind === 'business_suite') {
        const correctThread = await assertBusinessSuiteThreadSurface(page, threadId);
        if (!correctThread) {
          throw new SendNotAttemptedError(
            'Business Suite tidak membuktikan percakapan Messenger tujuan yang benar — pesan tidak diketik',
          );
        }
      }
      const before = transport.countOwn(await readTranscript(), { text, selfName });

      const focused = await withDeadline(focusComposer(page, transport.composerSelectors), transport.composerWaitMs, 'membuka kotak pesan');
      if (!focused) {
        throw new SendNotAttemptedError('Kotak pesan Facebook tidak dapat difokuskan — pesan tidak diketik');
      }
      if (transport.kind === 'business_suite' && !(await assertBusinessSuiteThreadSurface(page, threadId))) {
        throw new SendNotAttemptedError(
          'Business Suite mengubah percakapan sebelum pesan diisi — pesan tidak diketik',
        );
      }
      // `page.type()` would be the obvious call and it does not work here. The
      // composer is a Lexical editor (`data-lexical-editor="true"`, confirmed
      // live), and Lexical builds its own state from `beforeinput` events, so a
      // per-character keydown/keypress loop lands in the visible DOM without
      // Lexical ever registering it: the box looks typed into, Enter clears it,
      // and nothing is ever sent. `sendCharacter` issues one CDP
      // `Input.insertText` — the primitive a real paste uses — which Lexical
      // does register. Despite the name it takes the whole string.
      await page.keyboard.sendCharacter(text);
      if (transport.kind === 'business_suite' && !(await assertBusinessSuiteThreadSurface(page, threadId))) {
        throw new SendNotConfirmedError(
          'Business Suite mengubah percakapan sebelum pengiriman — pesan tidak dikirim',
        );
      }
      // There is no Send button to click. Beside the composer the live page
      // offers only attachment, sticker, GIF, emoji and Like; the send control
      // appears only once text is present. Enter is how the message goes.
      await page.keyboard.press('Enter');

      const stayed = await deliveredAndStayed(
        async () => transport.countOwn(await readTranscript(), { text, selfName }),
        before, Date.now() + transport.confirmMs,
      );
      if (stayed) return;
      throw new SendNotConfirmedError(
        'Pesan sudah diketik tapi tidak bertahan sebagai pesan terkirim di percakapan — '
        + 'kemungkinan ditolak diam-diam oleh Facebook',
      );
    } catch (err) {
      if (err instanceof SessionExpiredError || err instanceof CheckpointRequiredError) {
        this.forgetSession(sessionKey, (err as Error).message);
      }
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Public reply to a comment on the Page's post.
   *
   * NOT YET DRIVEN. The comment-reply composer has not been probed against the
   * live site, and every selector here is verified or absent — never guessed.
   * Throwing the typed 501 keeps the whole CRM chain honest in the meantime:
   * the worker records "not available yet" on the comment, in words an agent
   * can read, instead of a reply that sits queued looking sent.
   */
  async replyToComment(sessionKey: string, target: CommentTarget): Promise<void> {
    const marker = await this.getPageMarker(sessionKey);
    if (!marker) throw new NoActiveSessionError('Tidak ada sesi Facebook yang aktif untuk tenant ini');
    const page = await this.newPage(sessionKey);
    if (!page) throw new NoActiveSessionError('Tidak ada sesi Facebook yang aktif untuk tenant ini');

    const t0 = Date.now();
    const mark = (step: string) => trace('reply', `${step} +${Date.now() - t0}ms`);
    // Narrow, for finding THIS comment and its own controls — correct there,
    // and left alone: `hasCommentControl` must not confuse this comment's
    // "Reply" button with a reply's own "Reply" button one level down.
    const readComment = async () => (await readCommentHtml(page, target.commentId)) ?? '';
    // WIDE, for proving our own reply exists at all. Confirmed live: a reply
    // to a comment is NOT rendered as a descendant of that comment's own
    // `div[role="article"]` on the single-comment permalink view this
    // function navigates to — it lands as a SIBLING in the post's surface.
    // `readComment()`'s own scope therefore has zero nested articles no
    // matter how long a reply is waited for, and no timeout, however
    // generous, was ever going to fix a search that could not see the answer.
    // The post surface is the same reader the comment sweep already trusts to
    // find replies correctly.
    const readForConfirmation = async () => (await readPostSurfaceHtml(page, target.postId)) ?? '';
    try {
      await page.goto(URLS.postPermalink(marker.pageId, target.postId, target.commentId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      mark('goto-post');
      await this.assertUsable(page);
      mark('post-usable');
      const found = await waitFor(async () => (await readCommentHtml(page, target.commentId)) !== null,
        COMMENT_ACTIONS.waitMs);
      mark(`find-comment (found=${found})`);
      if (!found) {
        throw new CommentNotFoundError('Komentar ini tidak ditemukan di postingan Halaman — mungkin sudah dihapus atau disembunyikan');
      }

      // Counted before, for the same reason as `sendMessage`: a reply is often
      // the same words as one already there, and "our text is on the post"
      // would report success off a reply from last week.
      const before = countOwnCommentReplies(await readForConfirmation(), { pageName: marker.pageName, text: target.text });
      mark(`baseline (before=${before})`);

      const opened = await hasCommentControl(page, target.commentId, COMMENT_ACTIONS.replyButtonRe);
      mark(`reply-control (opened=${opened})`);
      // Fired, not awaited — see `fireCommentControl`. The editor appearing is
      // the evidence the click landed.
      if (opened) fireCommentControl(page, target.commentId, COMMENT_ACTIONS.replyButtonRe);
      if (!opened) {
        throw new CommentActionUnavailableError('Facebook tidak menampilkan tombol Balas pada komentar ini', 'reply_unavailable');
      }
      const editor = COMMENT_ACTIONS.replyEditor.join(', ');
      const hasEditor = await page.waitForSelector(editor, { timeout: COMMENT_ACTIONS.waitMs })
        .then(() => true).catch(() => false);
      mark(`editor-visible (${hasEditor})`);
      if (!hasEditor) {
        throw new CommentActionUnavailableError('Kotak balasan komentar tidak muncul setelah tombol Balas ditekan', 'reply_unavailable');
      }

      // Lexical, exactly as the Messenger composers: `page.type()` never
      // registers, one CDP insertText does, and Enter is the send.
      await page.click(editor);
      await page.keyboard.sendCharacter(target.text);
      const typedNow = await readComposerText(page, [editor]);
      mark(`typed (kotak berisi ${JSON.stringify((typedNow ?? '').slice(0, 60))})`);
      if (DEBUG) {
        const around = await page.evaluate(`(function(){
          var el = document.querySelector(${JSON.stringify(editor)});
          if (!el) return null;
          var wrap = el.closest('form') || el.parentElement || el;
          return (wrap.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 1200);
        })()`).catch(() => null) as string | null;
        trace('reply', `dom-around-editor: ${around}`);
        trace('reply', `controls: ${(await listButtonLabels(page)).join(' | ')}`);
      }
      await page.keyboard.press('Enter');
      mark('pressed-enter');

      // Enter is pressed EXACTLY ONCE, above. Everything from here on is
      // read-only polling of the comment we already asked Facebook to reply
      // to — never a second click, never a second keystroke. A confirmation
      // that timed out is therefore never "typed twice"; at worst it is typed
      // once and reported wrong, which is what the rest of this function
      // exists to make as unlikely as it can be.
      const confirmed = await confirmReplyWithFinalRecheck(
        async () => countOwnCommentReplies(await readForConfirmation(), { pageName: marker.pageName, text: target.text }) > before,
        { budgetMs: COMMENT_ACTIONS.publicReplyConfirmMs, pollMs: COMMENT_CONFIRM_POLL_MS },
      );
      if (confirmed === 'settled') { mark('confirmed'); return; }
      if (confirmed === 'final-recheck') { mark('confirmed on final recheck'); return; }
      mark(`not-confirmed after final recheck (last html len=${(await readForConfirmation()).length})`);
      throw new SendNotConfirmedError(
        'Balasan sudah diketik tapi tidak muncul di bawah komentar setelah 60 detik — '
        + 'kemungkinan ditolak diam-diam oleh Facebook',
      );
    } catch (err) {
      if (err instanceof SessionExpiredError || err instanceof CheckpointRequiredError) {
        this.forgetSession(sessionKey, (err as Error).message);
      }
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Private Messenger message to a commenter, through the comment's own
   * "Send message" control — Facebook's private reply.
   *
   * Measured live (2026-09-26): the control opens `Message <commenter>` as a
   * dialog in the SAME tab, beside the post's public composers; its "Send
   * Message" button enables a few hundred ms after the text lands; and a
   * delivered private reply shows up in a FRESH read of the commenter's
   * Messenger conversation, not in a Business Suite tab left open from before
   * the send. The order and the single send live in `runPrivateReply`; this
   * supplies the browser work.
   */
  async privateReplyToComment(
    sessionKey: string, target: CommentTarget,
  ): Promise<{ threadId: string; messageId: string | null }> {
    const marker = await this.getPageMarker(sessionKey);
    if (!marker) throw new NoActiveSessionError('Tidak ada sesi Facebook yang aktif untuk tenant ini');
    const ctx: TransportContext = { pageName: marker.pageName, assetId: marker.assetId ?? null };
    const transport = ctx.assetId ? businessSuiteTransport : messengerDotComTransport;
    const ids = { sessionKey, pageId: marker.pageId, postId: target.postId, commentId: target.commentId };
    const log = (event: string, fields: Record<string, unknown> = {}) => this.log.info({ event, ...ids, ...fields }, event);

    const postPage = await this.newPage(sessionKey);
    if (!postPage) throw new NoActiveSessionError('Tidak ada sesi Facebook yang aktif untuk tenant ini');
    // The dialog opens on this tab while other tabs (the conversation reads
    // below, the watchers) come and go in front of it.
    await keepRenderingInBackground(postPage, this.log, ids);

    try {
      await postPage.goto(URLS.postPermalink(marker.pageId, target.postId, target.commentId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.assertUsable(postPage);
      const found = await waitFor(async () => (await readCommentHtml(postPage, target.commentId)) !== null,
        COMMENT_ACTIONS.waitMs);
      if (!found) {
        throw new CommentNotFoundError('Komentar ini tidak ditemukan di postingan Halaman — mungkin sudah dihapus atau disembunyikan');
      }
      const commentHtml = (await readCommentHtml(postPage, target.commentId)) ?? '';
      const threadId = firstHrefMatch(parseHtml(commentHtml), PROFILE_ID_RE);
      if (!threadId) {
        throw new CommentActionUnavailableError('Pengomentar tidak bisa dikenali — tidak ada tautan profil pada komentar', 'private_reply_unavailable');
      }
      const contactName = parseFacebookComments(commentHtml, { defaultPostId: target.postId }).comments
        .find((comment) => comment.commentId === target.commentId)?.authorName.trim() ?? '';
      if (!contactName) {
        throw new CommentActionUnavailableError(
          'Nama pengomentar tidak terbaca — tujuan pesan pribadi tidak dapat dipastikan', 'private_reply_unavailable',
        );
      }
      if (!(await hasCommentControl(postPage, target.commentId, COMMENT_ACTIONS.sendMessageButtonRe))) {
        throw new CommentActionUnavailableError('Facebook tidak menyediakan pesan pribadi untuk komentar ini', 'private_reply_unavailable');
      }
      const expected = { contactId: threadId, contactName };
      const browser = await this.ensureBrowser(sessionKey);
      if (!browser) throw new NoActiveSessionError('Tidak ada sesi Facebook yang aktif untuk tenant ini');
      // Facebook's ids for rows with this text, before the send and at the
      // reading that confirmed it: the one that is new is this message, and it
      // is recorded under the key the inbox watcher will read it back as.
      let baselineIds: string[] = [];
      let seenIds: string[] = [];
      const countSent = async () => {
        const read = await this.freshConversationRead(sessionKey, transport, ctx, threadId, target.text);
        if (read) seenIds = read.ids;
        return read ? read.count : null;
      };

      await runPrivateReply<Page>({
        // A commenter who never messaged the Page has no conversation to
        // prove, and that is the first contact a private reply exists for:
        // after a second unproven read the baseline is zero, and the
        // confirmation still counts only on a PROVEN read of their thread.
        baseline: async () => {
          const count = (await countSent()) ?? (await countSent());
          if (count === null) log('fb_private_baseline_unproven', {});
          baselineIds = count === null ? [] : seenIds;
          return count ?? 0;
        },
        openSurface: async () => {
          const known = new Set(await browser.pages().catch(() => [] as Page[]));
          // Fired, not awaited: the click can tear down the clicked page's
          // execution context as the surface opens. The surface is the evidence.
          fireCommentControl(postPage, target.commentId, COMMENT_ACTIONS.sendMessageButtonRe);
          const surface = await resolvePrivateReplySurface(browser, known, PRIVATE_SURFACE_BUDGET_MS);
          log('fb_private_surface_candidate', {
            found: Boolean(surface), sameTab: surface === postPage, url: surface?.url().slice(0, 80) ?? null,
          });
          return surface;
        },
        proveSurface: (surface) => withDeadline(
          assertPrivateMessageSurface(surface, expected), COMMENT_ACTIONS.waitMs, 'memastikan tujuan pesan pribadi'),
        enterText: (surface, kind) => withDeadline(
          enterPrivateText(surface, kind === 'dialog' ? COMMENT_ACTIONS.messageEditor : BIZ_COMPOSER.box, target.text),
          COMMENT_ACTIONS.waitMs, 'mengetik pesan pribadi'),
        sendEnabled: async (surface, kind) =>
          (kind === 'dialog' ? waitForSendEnabled(surface, PRIVATE_SEND_ENABLE_BUDGET_MS) : true),
        // Exactly once. The dialog is sent with its own button; Enter only on a
        // surface proven to be the commenter's conversation — on a post page
        // the nearest box is the public reply, where Enter publishes.
        pressSend: async (surface, kind) => {
          if (kind === 'dialog') fireClick(surface, COMMENT_ACTIONS.messageSendButton);
          else await surface.keyboard.press('Enter');
        },
        confirm: (before) => confirmPrivateDelivery(countSent, before, {
          checksAtMs: PRIVATE_CONFIRM_CHECKS_MS, dwellMs: PRIVATE_CONFIRM_DWELL_MS,
        }),
        isPassthrough: (err) => err instanceof SessionExpiredError || err instanceof CheckpointRequiredError
          || err instanceof NoActiveSessionError,
        log,
      });
      const fresh = seenIds.filter((id) => !baselineIds.includes(id));
      return { threadId, messageId: fresh.length === 1 ? fresh[0]! : null };
    } catch (err) {
      if (err instanceof SessionExpiredError || err instanceof CheckpointRequiredError) {
        this.forgetSession(sessionKey, (err as Error).message);
      }
      throw err;
    } finally {
      await postPage.close().catch(() => {});
    }
  }

  /**
   * How many messages with exactly this text the commenter's conversation
   * holds, and their ids, from a FRESH load in a tab of its own — or null when the page
   * cannot prove it is that conversation (Business Suite silently shows
   * another one while it hydrates, and a count from the wrong conversation
   * would confirm a send that never happened).
   */
  private async freshConversationRead(
    sessionKey: string, transport: ThreadTransport, ctx: TransportContext, threadId: string, text: string,
  ): Promise<{ count: number; ids: string[] } | null> {
    const page = await this.newPage(sessionKey);
    if (!page) return null;
    try {
      return await withDeadline((async () => {
        await keepRenderingInBackground(page, this.log, { sessionKey });
        await page.goto(transport.threadUrl(ctx, threadId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await this.assertUsable(page);
        await page.waitForSelector(transport.threadWaitSelectors.join(', '), { timeout: 15_000 }).catch(() => {});
        const read = async () => (await readContainerHtml(page, BIZ_THREAD.messageList)) ?? '';
        await settleSurface(page, read, SURFACE_BUDGET_MS);
        if (transport === businessSuiteTransport && !(await assertBusinessSuiteThreadSurface(page, threadId))) return null;
        const html = await read();
        return { count: countMessagesWithText(html, text), ids: messageIdsWithText(html, text) };
      })(), PRIVATE_THREAD_READ_BUDGET_MS, 'membaca percakapan Messenger');
    } catch (err) {
      if (err instanceof SessionExpiredError || err instanceof CheckpointRequiredError) throw err;
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async logout(sessionKey: string): Promise<void> {
    const loginWindow = this.loginWindows.get(sessionKey);
    if (loginWindow) {
      this.loginWindows.delete(sessionKey);
      await loginWindow.close().catch(() => {});
    }
    await this.closeBrowser(sessionKey);
    this.markers.delete(sessionKey);
    this.lastErrors.delete(sessionKey);
    await fs.rm(this.profileDir(sessionKey), { recursive: true, force: true }).catch(() => {});
  }

  /** Closes every browser cleanly on shutdown, so a routine `tsx watch` reload
   * does not leave a profile in the uncleanly-shut-down state
   * `clearCrashedSessionState` exists to recover from. */
  async closeAll(): Promise<void> {
    await Promise.all([
      ...[...this.browsers.keys()].map((sessionKey) => this.closeBrowser(sessionKey)),
      ...[...this.loginWindows.values()].map((browser) => browser.close().catch(() => {})),
    ]);
    this.loginWindows.clear();
  }
}

/**
 * Where Facebook actually put the private-message composer.
 *
 * Clicking a comment's "Send message" does not reliably leave the composer on
 * the page that was clicked. Confirmed live by a per-step trace: the click
 * lands, the surface opens, and the original target then dies before anything
 * can be typed — surfacing as `Target closed` three steps away from the click
 * that caused it.
 *
 * Deliberately agnostic about HOW the composer got there. A same-page dialog,
 * a popup, a brand-new target, or the original page navigating are the same
 * question — which page is showing a composer — and guessing which one
 * Facebook uses is what produced three rounds of wrong fixes. Pages that
 * existed before the click are checked too, because a "new" surface is
 * sometimes a reused one.
 *
 * Null when nothing shows a composer within the budget. That is a real answer:
 * Facebook offers a private reply only for some comments and some people.
 */
/**
 * Fails a browser step on OUR clock rather than Puppeteer's.
 *
 * A call into a page whose execution context is being torn down does not
 * reject — it sits there until `protocolTimeout`, and the error it finally
 * raises names the CDP method, not the step. Both are useless to whoever reads
 * the CRM's error box, so every step that touches a page Facebook may have
 * just replaced gets its own deadline and its own name.
 */
/**
 * Waits for a public reply to be seen, then gives it one more look before
 * calling it a failure.
 *
 * 60 seconds, not 20. Confirmed live: a reply on a genuinely fresh post can
 * take longer than 20s for Facebook's own backend to publish and render —
 * the click, the type and the Enter all succeeded, the comment appeared on a
 * later, independent read, and the caller had already reported failure. That
 * is worse than a slow success: `'failed'` is a terminal status with no path
 * back for a public reply, so the CRM and Facebook disagreed about a reply
 * that had, in fact, gone out.
 *
 * A pure state machine over a `check` callback — no Page, no network — so the
 * three outcomes here (settles inside the window, settles only on the last
 * look, never settles) are each a plain unit test rather than something only
 * provable against the real site.
 *
 * `'final-recheck'` is a distinct outcome from `'settled'`, not a detail:
 * the poll loop can exit with the deadline crossed mid-sleep, which leaves a
 * window — at most one poll interval — where a reply that landed a moment too
 * late would otherwise never be looked at again.
 */
export async function confirmReplyWithFinalRecheck(
  check: () => Promise<boolean>, opts: { budgetMs: number; pollMs: number },
): Promise<'settled' | 'final-recheck' | 'not-confirmed'> {
  const deadline = Date.now() + opts.budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return 'settled';
    await sleep(opts.pollMs);
  }
  return (await check()) ? 'final-recheck' : 'not-confirmed';
}

export async function withDeadline<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CommentActionUnavailableError(
          `Facebook tidak merespons saat ${step} — kotak pesannya keburu ditutup`, 'private_reply_unavailable',
        )), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits until a page stops rewriting itself.
 *
 * Business Suite answers a thread URL by dropping `selected_item_id`,
 * redirecting to the plain inbox and re-rendering the conversation it picks —
 * and it is still doing that around three seconds in, which is exactly when a
 * first version typed and pressed Enter. Confirmed live: the message rendered,
 * the send was confirmed off that render, and the re-render threw it away. It
 * never reached Facebook, and the CRM recorded it as sent.
 *
 * So nothing is typed until two consecutive reads of the transcript come back
 * identical on the same URL. Returning false does not fail the send — a busy
 * inbox is not a broken one — but it is traced, and the confirmation that
 * follows is what actually decides whether anything was delivered.
 */
export async function settleSurface(page: Page, read: () => Promise<string>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let previous: string | null = null;
  let previousUrl = page.url();
  while (Date.now() < deadline) {
    const html = await read();
    const url = page.url();
    if (html !== '' && html === previous && url === previousUrl) return true;
    previous = html;
    previousUrl = url;
    await sleep(TRANSCRIPT_SETTLE_MS);
  }
  return false;
}

/** How long a message has to still be on screen before this service will call
 * it sent. Facebook renders a message the moment Enter is pressed, whether or
 * not the send behind it succeeds. */
const SEND_DWELL_MS = 6_000;

/**
 * Whether the transcript gained our message AND kept it.
 *
 * A single sighting is not delivery, confirmed live — the optimistic bubble
 * Facebook paints on Enter looks exactly like a delivered one and is what a
 * first version counted. The message therefore has to be there, and still be
 * there after a dwell, before this returns true.
 */
export async function deliveredAndStayed(
  count: () => Promise<number>, before: number, deadline: number, dwellMs = SEND_DWELL_MS,
): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await count() > before) {
      await sleep(dwellMs);
      if (await count() > before) return true;
      continue;
    }
    await sleep(500);
  }
  return false;
}

/** How many passes in a row a composer has to still be there, and how long
 * apart, before this service will type into it. */
const SURFACE_SETTLE_CHECKS = 3;
const SURFACE_SETTLE_MS = 400;
/** How often a page is re-read while waiting for it to stop rewriting itself,
 * and how long it gets to manage that. Slower than the composer's check
 * because a whole transcript re-render takes longer than a dialog's. */
const TRANSCRIPT_SETTLE_MS = 1_000;
const SURFACE_BUDGET_MS = 20_000;

/**
 * A composer that is not merely present but STILL present a moment later, on
 * the same document.
 *
 * Seeing one is not enough, confirmed live. Clicking "Send message" opens
 * Facebook's dialog and replaces the page's document underneath it, so a
 * single look finds a composer on a document that is already on its way out.
 * The `evaluate` that found it succeeds; the very next call — puppeteer's
 * `click`, which has to scroll the element into view — lands in a context that
 * no longer answers, and hangs until it is timed out from outside.
 *
 * So the question asked here is not "is there a composer" but "is there a
 * composer that survives being looked at three times". A dying document fails
 * on the next pass, the search moves on, and the composer is found again on
 * whatever document replaced it.
 */
async function composerHasSettled(page: Page, selectors: readonly string[]): Promise<boolean> {
  const url = page.url();
  for (let check = 0; check < SURFACE_SETTLE_CHECKS; check += 1) {
    if (check > 0) await sleep(SURFACE_SETTLE_MS);
    // A navigation is a new document even when the address is unchanged, and
    // either way what was measured no longer describes what is on screen.
    if (page.isClosed() || page.url() !== url) return false;
    if (!(await hasPrivateComposer(page, selectors))) return false;
  }
  return true;
}

export async function resolvePrivateReplySurface(
  browser: Browser, known: ReadonlySet<Page>, budgetMs: number,
): Promise<Page | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    // Re-read every pass: the set changes underneath, which is the point.
    const pages = (await browser.pages().catch(() => [] as Page[])).filter((page) => !page.isClosed());
    // Newest first — a surface Facebook just opened is the likeliest owner.
    const ordered = [...pages].reverse();
    // Facebook's own private-reply dialog, wherever it opened.
    for (const page of ordered) {
      if (await composerHasSettled(page, COMMENT_ACTIONS.messageEditor)) {
        trace('private-reply', () => `surface: dialog on ${known.has(page) ? 'a tab open before the click' : 'a new tab'} ${page.url().slice(0, 80)}`);
        return page;
      }
    }
    // Only Facebook's private-reply dialog, never a plain conversation tab —
    // whether it was open before the click (the bridge's own inbox) or opened
    // during it (another job's thread read or outbound send, which would pass
    // every identity check). Typing there sends an ordinary DM from someone
    // else's tab, unlinked from the comment. Measured live, the click opens its
    // dialog in the same tab; running out of time means nothing is typed.
    if (Date.now() >= deadline) return null;
    await sleep(400);
  }
}
