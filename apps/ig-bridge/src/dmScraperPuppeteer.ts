import type { Page } from 'puppeteer';

export interface ScrapedMessage {
  senderUsername: string;
  text: string;
}

export interface InboxThread {
  /** NOT a real Instagram thread id — inbox/request rows carry no id of
   * their own (confirmed live). The row's own display name, confirmed live
   * as the first leaf text node inside it. See `discoverThreadId`. */
  key: string;
  signature: string;
}

/** Thrown when a page navigation lands back on the login form — the
 * persisted cookie jar has expired or been invalidated. */
export class SessionExpiredError extends Error {}

export function isSessionExpiredError(err: unknown): boolean {
  return err instanceof SessionExpiredError;
}

const THREAD_ID_RE = /\/direct\/t\/([^/?]+)/;

function assertLoggedIn(page: Page): void {
  if (page.url().includes('/accounts/login')) {
    throw new SessionExpiredError('Sesi Instagram sudah tidak aktif — silakan login ulang');
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Puppeteer has no `getByRole` the way Playwright does — this is the one
 * building block both this file and `sessionManager.ts` use instead: find a
 * `div[role="button"]`/`button` whose text matches, and click it via
 * `element.click()` inside the page rather than Puppeteer's own `page.click`
 * (which needs a CSS selector, and generated instagram.com class names are
 * not a stable way to reach "the button that says Accept").
 */
export async function clickButtonByText(page: Page, pattern: RegExp, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs in the page's own DOM context, not this project's
    const clicked: boolean = await page.evaluate((source: string, flags: string) => {
      const doc = (globalThis as any).document;
      const re = new RegExp(source, flags);
      const candidates = Array.from(doc.querySelectorAll('div[role="button"], button')) as any[];
      const el = candidates.find((c) => re.test((c.textContent || '').trim()));
      if (el) {
        el.click();
        return true;
      }
      return false;
    }, pattern.source, pattern.flags).catch(() => false);
    if (clicked) return true;
    await sleep(200);
  }
  return false;
}

/** Read-only diagnostic — what the headless page actually shows, useful
 * when a scan comes back empty and it's unclear whether that's genuinely
 * "no chats" or "this isn't really the inbox". */
export async function snapshotForDebug(page: Page): Promise<{ url: string; bodyTextSample: string }> {
  const bodyTextSample = await page.evaluate(`
    (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 800)
  `).catch((err) => `evaluate failed: ${err}`) as string;
  return { url: page.url(), bodyTextSample };
}

/**
 * Same building block every row-scanning function below shares: given a row
 * element, its contact name is the first text-bearing leaf node inside it —
 * confirmed live (`Muhammad Fattaah Al Rasyid` / `4+ new messages` / `·` /
 * `16m` / `Unread` all sit as separate sibling leaves, in that order, with
 * the name always first). Meta's class names are auto-generated noise,
 * useless as selectors, but this structural ordering held up across both
 * the Primary and Requests pages. Inlined into every injected string below
 * rather than shared, since each runs in its own isolated `page.evaluate`
 * string with no access to a Node-side import.
 */
const FIRST_LEAF_TEXT_JS = `
  function firstLeafText(el) {
    var kids = Array.prototype.slice.call(el.children);
    if (kids.length === 0) {
      var t = (el.textContent || '').trim();
      return t || null;
    }
    for (var i = 0; i < kids.length; i++) {
      var r = firstLeafText(kids[i]);
      if (r) return r;
    }
    return null;
  }
`;

/** Navigates a page to the Primary inbox and leaves it there — the page
 * `installInboxObserver` is installed on is meant to sit open indefinitely,
 * the way a person would leave the Instagram tab open, not be repeatedly
 * re-navigated. `domcontentloaded` fires once the HTML shell is parsed,
 * well before Instagram's own React app has fetched and rendered the
 * actual conversation list — the wait below gives that async render room
 * to actually finish, rather than assuming a fixed delay always will.
 *
 * That matters more here than almost anywhere else in this file:
 * `installInboxObserver`'s very first `scan()` runs immediately after this
 * returns, and a `MutationObserver` only fires on *future* DOM changes — if
 * this returns while the thread list is still the loading skeleton, that
 * first scan reports zero threads, and the observer then has nothing to
 * compare the next real scan against until some *other* unrelated mutation
 * happens to fire it. Confirmed live: a thread with a genuinely new message
 * sitting right there on Instagram's own page went completely unreported,
 * with no error anywhere, because the skeleton was still up when this used
 * to return after a flat 2s sleep. */
export async function gotoInbox(page: Page): Promise<void> {
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  assertLoggedIn(page);
  await page.waitForSelector('div[aria-label="Thread list"] div[role="button"]', { timeout: 15000 }).catch(() => {});
  await sleep(500);
}

/**
 * The alternative to polling: instead of re-opening the inbox every few
 * minutes (itself a repeating, scriptable pattern), this installs a
 * `MutationObserver` on a page that is opened once and never navigated
 * away from, and bridges its callbacks to Node via `page.exposeFunction` —
 * much closer to a person just leaving the Instagram tab open and glancing
 * at it, and far more responsive than any poll interval.
 *
 * Sent as a raw string, not a real JS function reference: `tsx`/esbuild's
 * dev-mode name-preserving transform wraps a named local (`function scan()
 * {...}`) in a call to a `__name` helper that only exists in this Node
 * process's module scope, and `page.evaluate` serialises a *function*
 * argument via `.toString()` to run in the page's own isolated context,
 * where that helper was never defined — confirmed live, this broke message
 * detection entirely. A string literal's contents are never touched by
 * that transform.
 *
 * Idempotent: calling this again on a page that already has the observer
 * installed is a no-op rather than a duplicate observer or a thrown
 * "already exposed" error.
 */
export async function installInboxObserver(
  page: Page, onChange: (threads: InboxThread[]) => void,
): Promise<void> {
  const callbackName = '__igOnInboxChange';
  try {
    await page.exposeFunction(callbackName, (json: string) => {
      try {
        onChange(JSON.parse(json) as InboxThread[]);
      } catch {
        // Malformed payload — drop it, the next mutation resends the full state.
      }
    });
  } catch {
    // Already exposed on this page — expected on a self-heal re-injection.
  }

  await page.evaluate(`
    (function () {
      if (window.__igObserverInstalled) return;
      window.__igObserverInstalled = true;
      ${FIRST_LEAF_TEXT_JS}

      // A row's visible text carries relative-time stamps ("4m", "16h",
      // "Active now", their Indonesian equivalents) that tick over on their
      // own as the clock advances, with no message ever having changed.
      // Confirmed live: left unstripped, this reads as "the row changed"
      // every time one of those ticks, re-triggering a full re-read of the
      // thread forever — a self-sustaining loop, not a one-off. Stripping
      // these known-volatile substrings before comparing is what makes the
      // signature track actual content instead of the clock.
      function normaliseSignature(text) {
        return text
          .replace(/\\bActive\\s+(now|\\d+\\s*[a-z]+\\s+ago)\\b/gi, '')
          .replace(/\\bAktif\\s+(sekarang|\\d+\\s*[a-z]+\\s+(yang\\s+)?lalu)\\b/gi, '')
          .replace(/\\b\\d+\\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|mnt|jam|hr|hari|mgg|minggu)\\b/gi, '')
          .replace(/\\s+/g, ' ')
          .trim();
      }

      var debounceTimer = null;
      function scan() {
        var list = document.querySelector('div[aria-label="Thread list"]');
        var rows = list ? Array.prototype.slice.call(list.querySelectorAll('div[role="button"]')) : [];
        var threads = rows.map(function (el) {
          var key = firstLeafText(el);
          return { key: key, signature: normaliseSignature((el.innerText || '').slice(0, 300)) };
        // A row with no readable name at all (an icon-only control like the
        // compose button, occasionally caught by the broad role="button"
        // query) has nothing to key or re-find it by later — skip it.
        }).filter(function (t) { return t.key; });
        window.${callbackName}(JSON.stringify(threads));
      }

      var observer = new MutationObserver(function () {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(scan, 1500);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      // Reported once immediately — otherwise a thread that never changes
      // after page load is never reported at all, even though it is a
      // real, existing conversation.
      scan();
    })();
  `);
}

/**
 * Rows carry no id of their own (confirmed live: zero `href` attributes
 * anywhere in the thread list, on either the Primary or Requests page — a
 * row is a `div[role="button"]` with a client-side click handler, nothing
 * else) — the only way to learn a thread's real `/direct/t/<id>/` id is to
 * click the row matching its `key` (the same first-leaf-text name
 * `installInboxObserver` reports) and read where that navigation actually
 * landed. Returns `null` rather than throwing when the row can't be found
 * (it may have scrolled out of the loaded list) — a miss here should not
 * take down a whole housekeeping cycle over one thread.
 */
export async function discoverThreadId(page: Page, key: string): Promise<string | null> {
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  assertLoggedIn(page);
  await sleep(1500);

  const clicked = await page.evaluate(`
    (function () {
      ${FIRST_LEAF_TEXT_JS}
      var list = document.querySelector('div[aria-label="Thread list"]');
      if (!list) return false;
      var rows = Array.prototype.slice.call(list.querySelectorAll('div[role="button"]'));
      var target = ${JSON.stringify(key)};
      for (var i = 0; i < rows.length; i++) {
        if (firstLeafText(rows[i]) === target) {
          rows[i].click();
          return true;
        }
      }
      return false;
    })();
  `) as boolean;
  if (!clicked) return null;

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (THREAD_ID_RE.test(page.url())) break;
    await sleep(300);
  }
  assertLoggedIn(page);
  return THREAD_ID_RE.exec(page.url())?.[1] ?? null;
}

/**
 * Confirmed live: every message bubble sits beside a
 * `div[aria-label="See more options for message from <username>"]`
 * trigger, the only place in the DOM that reliably exposes the sender's
 * username per-message. Walking up from that trigger to the nearest
 * ancestor with the most text finds the bubble's own message body.
 *
 * Done as one `page.evaluate` pass over every trigger, not a per-element
 * round trip — confirmed live that a per-index version goes stale and
 * times out on a thread with enough messages (18+) for the DOM to still be
 * settling between one round trip and the next.
 *
 * Whether the account's own bubbles carry this same trigger, letting a
 * self-sent message be mistaken for inbound, is defended against
 * separately (by comparing `senderUsername` against the connected
 * account's own username), not by anything here.
 */
/**
 * Shared with `sendThreadMessage`'s own post-send verification below — same
 * aria-label walk, so a message counts as "there" in exactly one place.
 */
const SCRAPE_MESSAGES_JS = `
  (function () {
    var out = [];
    var triggers = Array.prototype.slice.call(
      document.querySelectorAll('div[aria-label^="See more options for message from "]'));
    for (var i = 0; i < triggers.length; i++) {
      var trigger = triggers[i];
      var ariaLabel = trigger.getAttribute('aria-label') || '';
      var senderUsername = ariaLabel.replace('See more options for message from ', '').trim();
      if (!senderUsername) continue;

      var node = trigger;
      var text = '';
      for (var hop = 0; hop < 6 && node; hop++) {
        node = node.parentElement;
        var t = (node && node.innerText ? node.innerText : '').trim();
        if (t.length > text.length) text = t;
      }
      // Walking further up for a longer match than the immediate bubble
      // sometimes reaches far enough to also swallow the hover toolbar
      // next to it (React/Reply/"See more options", all labelled with
      // this same sender's name) — confirmed live on a thread with
      // several messages, where two bodies came back with these three
      // glued on. Stripped by exact substring rather than avoided by
      // walking fewer hops, since fewer hops was what originally
      // under-shot real message text.
      var chromePhrases = [
        'React to message from ' + senderUsername,
        'Reply to message from ' + senderUsername,
        'See more options for message from ' + senderUsername,
      ];
      for (var c = 0; c < chromePhrases.length; c++) {
        text = text.split(chromePhrases[c]).join('');
      }
      text = text.trim();
      if (text) out.push({ senderUsername: senderUsername, text: text });
    }
    return out;
  })();
`;

export async function readThreadMessages(page: Page, threadId: string): Promise<ScrapedMessage[]> {
  await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  assertLoggedIn(page);
  // A flat 1.2s sleep here used to be the whole wait — confirmed live (a
  // debug screenshot caught mid-fail) that `domcontentloaded` plus 1.2s
  // still lands on Instagram's own loading skeleton (shimmer placeholder
  // bars, no real message text anywhere in the DOM) often enough to be the
  // actual cause of "empty scrape of a known thread", not a genuine
  // transient blip — worse under the CPU/memory pressure of several dev
  // servers running at once. Waiting for the same message-bubble marker
  // `SCRAPE_MESSAGES_JS` itself looks for, instead of a fixed clock, means
  // this returns as soon as real content is actually there — and still
  // gives it up to 8s before accepting a thread might genuinely have
  // nothing to show yet (a brand new, empty conversation).
  await page.waitForSelector('div[aria-label^="See more options for message from "]', { timeout: 8000 }).catch(() => {});

  return await page.evaluate(SCRAPE_MESSAGES_JS) as ScrapedMessage[];
}

/**
 * Instagram routes a first-time sender's message into a separate "Message
 * Requests" tab, invisible to the Primary inbox the `MutationObserver`
 * watches — confirmed live during development (a real request sat there,
 * reply box hidden, until accepted by hand). Most first contact from a new
 * lead will land there, so leaving it unhandled would mean most new
 * conversations never reach the CRM automatically. Same row shape as
 * Primary (confirmed live: no `href`, `div[role="button"]` rows inside the
 * same `div[aria-label="Thread list"]` container) — this clicks each real
 * row (filtering out the page's own "Back" / "Hidden Requests" / "Delete
 * all" chrome, none of which carry a contact name as their first leaf
 * text) to open it, then accepts it, moving it into Primary where the
 * observer picks it up like any other thread.
 *
 * The accept flow itself remains unverified against a real request end to
 * end (the button's presence and label were confirmed live; clicking it to
 * completion was not) — this runs on a long housekeeping interval, meaning
 * it will act on whatever request is sitting there without a person
 * reviewing it first.
 */
export async function acceptPendingRequests(page: Page): Promise<string[]> {
  const accepted: string[] = [];

  // Each accept navigates away and changes the list, so this re-reads the
  // list fresh every pass rather than working off one stale snapshot — a
  // bounded number of passes keeps a request that can't be accepted (a
  // network hiccup, an already-actioned row) from looping forever.
  for (let pass = 0; pass < 10; pass++) {
    await page.goto('https://www.instagram.com/direct/requests/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    assertLoggedIn(page);
    await sleep(1000);

    const key = await page.evaluate(`
      (function () {
        ${FIRST_LEAF_TEXT_JS}
        var chrome = { 'Back': true, 'Delete all': true };
        var list = document.querySelector('div[aria-label="Thread list"]');
        if (!list) return null;
        var rows = Array.prototype.slice.call(list.querySelectorAll('div[role="button"]'));
        for (var i = 0; i < rows.length; i++) {
          var name = firstLeafText(rows[i]);
          if (name && !chrome[name] && name.indexOf('Hidden Requests') !== 0) {
            rows[i].click();
            return name;
          }
        }
        return null;
      })();
    `) as string | null;
    if (!key) break;

    try {
      const clicked = await clickButtonByText(page, /^Accept$/, 8000);
      if (!clicked) break;
      await sleep(800);
      accepted.push(key);
    } catch {
      // No "Accept" found, or the page errored — stop rather than risk
      // clicking the same unrecognised row forever.
      break;
    }
  }
  return accepted;
}

/** Thrown when the composer still holds the typed text well after Enter, or
 * when the composer cleared but the message never actually showed up as a
 * new bubble from our own account — either way, this text never reached the
 * other side. Distinguished from a network/navigation failure so callers can
 * tell "definitely never reached Instagram" apart from "sent, response
 * unclear". */
export class SendNotConfirmedError extends Error {}

/**
 * Best-effort composer selectors, confirmed reachable only once a request
 * is accepted (Instagram hides the composer entirely on an unaccepted
 * one).
 *
 * Confirmed live (inspected the real composer directly): it's a Meta
 * Lexical editor (`data-lexical-editor="true"`), not a plain
 * `<textarea>`. Lexical keeps its own internal editor-state tree built
 * from `beforeinput` events, so `page.type()`'s character-by-character
 * synthetic `keydown`/`keypress` sequence can land in the visible DOM
 * without Lexical's own state ever registering it — the box looked
 * typed-into and Enter cleared it, yet nothing was ever actually sent, on
 * several confirmed live attempts. `page.keyboard.sendCharacter()`
 * instead issues a single CDP `Input.insertText` call with the *whole*
 * string at once (despite the name, it isn't limited to one character —
 * confirmed by reading puppeteer-core's own implementation), the same
 * primitive a real paste uses — confirmed live (typed through the
 * browser extension, which goes through this same insertText path) that
 * this *does* register with Lexical and arms the send button, where the
 * same text via `page.type()`'s per-character `keydown`/`keypress` loop
 * did not.
 *
 * Typing and pressing Enter alone is still not proof of delivery even
 * with `insertText` — confirmed live, several `page.type()`-based sends
 * reported success (no exception, no rejected promise) yet never
 * appeared in the real conversation on Instagram's own side. Worse,
 * confirmed live again after switching to `sendCharacter()`: a thread
 * Instagram had started silently rate-limiting (heavy back-and-forth spam
 * during testing) still cleared the composer on every Enter — the client
 * optimistically empties it regardless of whether the server actually
 * accepted the message — so a composer-emptiness check alone still
 * reports "sent" for a message that never left. The only thing that
 * actually proves delivery is the same signal `readThreadMessages` (and
 * therefore the real inbox) would see: a new bubble from our own account
 * whose text matches what was typed. That's what's polled for below,
 * using the identical `SCRAPE_MESSAGES_JS` walk so "sent" here means the
 * exact same thing "received" means when reading a thread.
 */
export async function sendThreadMessage(
  page: Page, threadId: string, text: string, ownUsername: string | null,
): Promise<void> {
  await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  assertLoggedIn(page);

  const selector = [
    'div[contenteditable="true"][aria-label="Message"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder="Message..."]',
  ].join(', ');
  await page.waitForSelector(selector, { timeout: 15_000 });
  await page.click(selector);
  await page.keyboard.sendCharacter(text);
  await page.keyboard.press('Enter');

  const wanted = text.trim();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const messages = await page.evaluate(SCRAPE_MESSAGES_JS) as ScrapedMessage[];
    const last = messages[messages.length - 1];
    if (last && last.text === wanted
        && (!ownUsername || last.senderUsername.toLowerCase() === ownUsername.toLowerCase())) {
      return;
    }
    await sleep(400);
  }
  throw new SendNotConfirmedError(
    'Pesan sudah diketik tapi tidak muncul sebagai pesan terkirim di thread — kemungkinan ditolak diam-diam oleh Instagram (mis. thread kena rate-limit)',
  );
}
