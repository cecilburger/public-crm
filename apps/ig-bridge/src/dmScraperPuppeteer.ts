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
 * A row's visible text carries relative-time stamps ("4m", "16h", "Active
 * now", their Indonesian equivalents) that tick over on their own as the
 * clock advances, with no message ever having changed. Confirmed live: left
 * unstripped, this reads as "the row changed" every time one of those ticks,
 * re-triggering a full re-read of the thread forever — a self-sustaining
 * loop, not a one-off. Stripping these known-volatile substrings before
 * comparing is what makes the signature track actual content instead of the
 * clock. Shared between the observer's inline scan and `readInboxThreads`'
 * standalone one, string-injected like `FIRST_LEAF_TEXT_JS` for the same
 * reason (see `installInboxObserver`'s own note on why these are strings,
 * not real functions).
 */
const NORMALISE_SIGNATURE_JS = `
  function normaliseSignature(text) {
    return text
      .replace(/\\bActive\\s+(now|\\d+\\s*[a-z]+\\s+ago)\\b/gi, '')
      .replace(/\\bAktif\\s+(sekarang|\\d+\\s*[a-z]+\\s+(yang\\s+)?lalu)\\b/gi, '')
      .replace(/\\b\\d+\\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|mnt|jam|hr|hari|mgg|minggu)\\b/gi, '')
      .replace(/\\s+/g, ' ')
      .trim();
  }
`;

/** Same row → `{key, signature}` reading the observer's `scan()` does,
 * shared so `readInboxThreads` below reads a row exactly the way the
 * observer would have. */
const SCAN_THREADS_JS = `
  function scanThreads() {
    var list = document.querySelector('div[aria-label="Thread list"]');
    var rows = list ? Array.prototype.slice.call(list.querySelectorAll('div[role="button"]')) : [];
    return rows.map(function (el) {
      var key = firstLeafText(el);
      return { key: key, signature: normaliseSignature((el.innerText || '').slice(0, 300)) };
    // A row with no readable name at all (an icon-only control like the
    // compose button, occasionally caught by the broad role="button" query)
    // has nothing to key or re-find it by later — skip it.
    }).filter(function (t) { return t.key; });
  }
`;

/**
 * Reads the inbox's current thread list directly, the same shape the
 * `MutationObserver` in `installInboxObserver` reports on change — a
 * poll-based second opinion for `dmWatcher`'s housekeeping to reconcile
 * against, so a thread the observer silently stopped reporting (its own
 * callback binding gone stale, the observed subtree swapped out from under
 * it by a React re-render, or any other reason a live, responsive page still
 * goes quiet) surfaces again within one housekeeping cycle instead of
 * staying invisible until someone notices and restarts the process by hand.
 * Confirmed live: exactly that happened for over an hour with no error
 * anywhere — the page passed every liveness check the whole time.
 */
export async function readInboxThreads(page: Page): Promise<InboxThread[]> {
  const json = await page.evaluate(`
    (function () {
      ${FIRST_LEAF_TEXT_JS}
      ${NORMALISE_SIGNATURE_JS}
      ${SCAN_THREADS_JS}
      return JSON.stringify(scanThreads());
    })();
  `) as string;
  return JSON.parse(json) as InboxThread[];
}

/**
 * The alternative to polling: instead of re-opening the inbox every few
 * minutes (itself a repeating, scriptable pattern), this installs a
 * `MutationObserver` on a page that is opened once and never navigated
 * away from, and bridges its callbacks to Node via `page.exposeFunction` —
 * much closer to a person just leaving the Instagram tab open and glancing
 * at it, and far more responsive than any poll interval. `dmWatcher`'s
 * housekeeping backs this with a periodic `readInboxThreads` poll, since
 * this alone has gone quiet on a page that never stopped responding.
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

  // A page that already carries an observer is the normal case now, not an
  // odd one: this process adopts a browser the previous one left running, so
  // the tab arrives with a live MutationObserver whose callback points into a
  // process that no longer exists. Confirmed live — the inbox tab looked
  // perfect, the flag said "installed", and not one message reached the CRM
  // for hours. Both halves therefore have to be torn down and rebuilt: the
  // page-side binding (or `exposeFunction` refuses the name, leaving this
  // process with no callback at all) and the observer itself (or two of them
  // end up running).
  await page.removeExposedFunction(callbackName).catch(() => {});
  await page.evaluate(`
    (function () {
      if (window.__igObserver) { try { window.__igObserver.disconnect(); } catch (e) {} }
      window.__igObserver = null;
      window.__igObserverInstalled = false;
      try { delete window.${callbackName}; } catch (e) { window.${callbackName} = undefined; }
    })();
  `).catch(() => {});

  await page.exposeFunction(callbackName, (json: string) => {
    try {
      onChange(JSON.parse(json) as InboxThread[]);
    } catch {
      // Malformed payload — drop it, the next mutation resends the full state.
    }
  });

  await page.evaluate(`
    (function () {
      if (window.__igObserverInstalled) return;
      window.__igObserverInstalled = true;
      ${FIRST_LEAF_TEXT_JS}
      ${NORMALISE_SIGNATURE_JS}
      ${SCAN_THREADS_JS}

      var debounceTimer = null;
      function scan() {
        window.${callbackName}(JSON.stringify(scanThreads()));
      }

      var observer = new MutationObserver(function () {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(scan, 1500);
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      // Kept reachable so the next process to adopt this browser can stop it
      // instead of leaving a second one running beside its own.
      window.__igObserver = observer;
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
/**
 * What a message looks like with the difference between "what we typed" and
 * "what the page renders it as" taken out.
 *
 * The two are not the same string. Confirmed live on a reply the bot really
 * did deliver: the sent copy carried an emoji and two newlines, the scrape
 * of that same bubble came back with the emoji gone and three — 110
 * characters against 109. Compared raw, the confirmation below therefore
 * never matched a message that was sitting right there on screen, so every
 * successful send was reported as `SendNotConfirmedError`, the queue retried
 * it, and the brand received the same paragraph three times.
 */
const sameMessage = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/[^a-z0-9]+/g, '') === b.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Not just the very last bubble: a contact who replies while we're still
 * polling for confirmation (very normal mid-chat — they keep typing) pushes
 * our own message up the thread. Checking only `messages[length - 1]` then
 * never matches, the 25s deadline is reached, and a message that really did
 * land on Instagram is reported as `SendNotConfirmedError` — the same tail
 * window the duplicate-scan above already uses, for the same reason.
 */
const lastMessageMatches = (messages: ScrapedMessage[], wanted: string, ownUsername: string | null): boolean =>
  messages.slice(-5).some((m) =>
    sameMessage(m.text, wanted)
    && (!ownUsername || m.senderUsername.toLowerCase() === ownUsername.toLowerCase()));

/**
 * Close whatever Instagram has put in front of the page before touching it.
 *
 * "Turn on Notifications" and its siblings are real modals: they sit over the
 * thread and swallow the click that should land in the message box, so the
 * text is typed into nothing, the send never happens, and the only symptom is
 * a confirmation that times out 25s later. Confirmed live — sending broke the
 * moment a fresh browser made Instagram ask again, while reading (which goes
 * through the page's own API, not the DOM) carried on working and hid the
 * cause.
 *
 * Locale-fragile like every other text match against instagram.com, so it
 * tries the usual wordings and then falls back to dismissing by position:
 * on these prompts the *last* button is consistently the decline.
 */
export async function dismissBlockingDialog(page: Page): Promise<void> {
  const hasDialog = await page.evaluate(
    `document.querySelectorAll('div[role="dialog"]').length > 0`,
  ).catch(() => false) as boolean;
  if (!hasDialog) return;

  const declined = await clickButtonByText(
    page, /^(not now|nanti saja|jangan sekarang|lain kali|cancel|tutup)$/i, 2500,
  );
  if (declined) return;

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

export async function sendThreadMessage(
  page: Page, threadId: string, text: string, ownUsername: string | null,
  opts: { skipDuplicateScan?: boolean } = {},
): Promise<void> {
  await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  assertLoggedIn(page);
  await dismissBlockingDialog(page);

  const wanted = text.trim();

  // A retry (BullMQ, or the caller's own backoff) lands here for the exact
  // same text — including one whose *previous* attempt actually reached
  // Instagram and only looked like it failed because the confirmation
  // below timed out first (confirmed live: a message reported as
  // unconfirmed showed up in the thread moments later). Re-typing and
  // re-pressing Enter in that case sends a real duplicate, not a retry.
  // Checking what's already there first is what makes a retry safe to
  // repeat as many times as the caller wants.
  // Not just the very last bubble: a brand who replies between our send and
  // the retry pushes our own message up the thread, and a check that only
  // looked at the bottom would conclude we never sent it and send it again.
  // The tail is far enough back to survive that without reaching so far
  // that a deliberately repeated line, sent much earlier, suppresses a real
  // one now.
  await page.waitForSelector('div[aria-label^="See more options for message from "]', { timeout: 8000 }).catch(() => {});
  // Skipped when the caller has already answered this question with a
  // timestamped source. This scan cannot: the DOM carries no clock, so it
  // cannot tell our retry from a line the bot legitimately said an hour ago.
  // Confirmed live — the bot greeted someone with the same sentence it had
  // used 85 minutes earlier, that older bubble was still within the last
  // five, and the send returned here without sending while the message was
  // recorded as delivered.
  if (!opts.skipDuplicateScan) {
    const onScreen = await page.evaluate(SCRAPE_MESSAGES_JS) as ScrapedMessage[];
    const alreadySent = onScreen.slice(-5).some((m) =>
      sameMessage(m.text, wanted)
      && (!ownUsername || m.senderUsername.toLowerCase() === ownUsername.toLowerCase()));
    if (alreadySent) return;
  }

  const selector = [
    'div[contenteditable="true"][aria-label="Message"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder="Message..."]',
  ].join(', ');
  await page.waitForSelector(selector, { timeout: 15_000 });
  // Confirmed live: Instagram's own "Turn on Notifications" prompt can pop
  // up on its own delay, any time after the check above — a dialog that
  // wasn't there yet when this function started can still be sitting over
  // the composer by now, and a click at the composer's coordinates lands on
  // the dialog instead. Nothing gets typed, Enter does nothing, and the
  // 25s confirmation wait below was always going to time out — not because
  // Instagram rejected a send, but because no send was ever made.
  await dismissBlockingDialog(page);
  await page.click(selector);
  await page.keyboard.sendCharacter(text);
  await page.keyboard.press('Enter');

  // Instagram's own render of a just-sent bubble is not instant, and is
  // slower still right after a session reconnects — confirmed live at
  // over 8s more than once, past the old deadline, with the message
  // landing anyway. 25s trades a slower failure report for far fewer
  // false ones; the pre-check above is what keeps a *false* one cheap to
  // retry instead of compounding into a real duplicate.
  const deadline = Date.now() + 25_000;
  let lastSeen: ScrapedMessage[] = [];
  while (Date.now() < deadline) {
    lastSeen = await page.evaluate(SCRAPE_MESSAGES_JS) as ScrapedMessage[];
    if (lastMessageMatches(lastSeen, wanted, ownUsername)) return;
    await sleep(500);
  }

  // TEMPORARY diagnostic — proof, not just a guess, of what Instagram
  // actually showed at the moment confirmation gave up: a screenshot (this
  // runs headless, so there is no window to look at directly) plus the
  // page's own visible text, which is where Instagram puts a restriction
  // banner ("You can't send messages right now...") if one is showing.
  // Remove once the question this exists to answer is settled.
  const debugDir = 'C:/Users/hp/AppData/Local/Temp/claude/D--project-PT-Miss-Spicy-Internatonal-public-crm/b5558765-9efa-4a2c-9e69-ab3b54b2197b/scratchpad';
  const stamp = Date.now();
  const screenshotPath = `${debugDir}/ig-send-fail-${stamp}.png`;
  await page.screenshot({ path: screenshotPath as `${string}.png`, fullPage: false }).catch((err) =>
    console.error('[ig-bridge] could not capture failure screenshot:', err));
  const bodyText = await page.evaluate(
    `(document.body && document.body.innerText ? document.body.innerText : '').slice(0, 2000)`,
  ).catch((err) => `evaluate failed: ${err}`);
  console.error('[ig-bridge] send not confirmed — diagnostic', {
    threadId, wanted, ownUsername, url: page.url(), screenshotPath,
    tail: lastSeen.slice(-5), bodyText,
  });

  throw new SendNotConfirmedError(
    'Pesan sudah diketik tapi tidak muncul sebagai pesan terkirim di thread — kemungkinan ditolak diam-diam oleh Instagram (mis. thread kena rate-limit)',
  );
}
