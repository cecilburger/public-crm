import { parse, type HTMLElement } from 'node-html-parser';
import { VOLATILE_TEXT_RES } from '../selectors.ts';

/**
 * The small set of DOM operations every parser needs, so none of them has to
 * care that the HTML came from a string rather than a live page.
 *
 * WHY PARSE HTML IN NODE AT ALL, instead of `page.evaluate` the way
 * `apps/ig-bridge` does: a `page.evaluate` that both finds elements and
 * interprets them cannot be tested without a browser and a logged-in Facebook
 * account, which is exactly the thing that must never be required to run this
 * project's test suite. Splitting it means the in-page half shrinks to one
 * expression — "give me this container's outerHTML" — and every rule about what
 * that markup *means* lives in a pure function with HTML fixtures next to it.
 *
 * The cost is parsing a chunk of HTML per read. It is bounded by taking the
 * message container's `outerHTML` rather than the whole document, and these
 * reads happen a handful of times a minute at most, so it buys full
 * testability for an amount of CPU nobody will ever notice.
 */

export type El = HTMLElement;

export function parseHtml(html: string): El {
  return parse(html, { blockTextElements: { script: false, style: false } });
}

/**
 * Tries each selector in order and returns the first that matches anything.
 *
 * `node-html-parser` implements its own CSS matcher and throws on syntax it
 * does not support, so every attempt is guarded: an unsupported selector in the
 * list must degrade to "this variant did not match" and let the next one try,
 * never take down the whole read.
 */
export function queryAll(root: El, selectors: readonly string[]): El[] {
  for (const selector of selectors) {
    try {
      const found = root.querySelectorAll(selector);
      if (found.length > 0) return found;
    } catch {
      // Unsupported selector syntax — treated as "no match", next variant.
    }
  }
  return [];
}

export function queryFirst(root: El, selectors: readonly string[]): El | null {
  return queryAll(root, selectors)[0] ?? null;
}

/**
 * Every `<a href>` under this element. Done by tag and filtered in JavaScript
 * rather than with an attribute selector like `a[href*="/t/"]`: substring and
 * prefix operators are the corners of CSS support most likely to be missing or
 * subtly different in a lightweight parser, and a regex over the href is both
 * more expressive and impossible to get silently wrong.
 */
export function links(root: El): { el: El; href: string }[] {
  const out: { el: El; href: string }[] = [];
  for (const el of root.querySelectorAll('a')) {
    const href = el.getAttribute('href');
    if (href) out.push({ el, href });
  }
  return out;
}

/** The first capture group of the first href that matches, or null. */
export function firstHrefMatch(root: El, re: RegExp): string | null {
  for (const { href } of links(root)) {
    const m = re.exec(href);
    if (!m) continue;
    const captured = m.slice(1).find((g) => g);
    if (captured) return captured;
  }
  return null;
}

/**
 * The nearest ancestor that is a real row, or the element itself.
 *
 * Counting a fixed number of hops up the tree (the first version of this)
 * looked reasonable and was wrong in exactly the way that matters: on the real
 * markup two hops from a conversation link lands on the *whole list*, so every
 * row's change-signature became the entire inbox and no single conversation
 * could ever be seen to change on its own. Walking until an actual row role
 * appears asks the question the code means to ask.
 */
export function closestRow(el: El, maxHops = 6): El {
  let node: El | null = el;
  for (let hop = 0; hop < maxHops && node; hop += 1) {
    const role = node.getAttribute?.('role');
    if (hop > 0 && (role === 'row' || role === 'listitem' || role === 'gridcell' || role === 'article')) return node;
    node = (node.parentNode as El | null) ?? null;
  }
  return el;
}

/** Collapses whitespace so two readings of the same text compare equal. */
export function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A row's text with the parts that change on their own removed — relative
 * timestamps, "Active now", and friends. Used for change detection, never for
 * the message body itself: stripping "2 jam" out of what a customer actually
 * typed would be corrupting their message.
 */
export function changeSignature(text: string): string {
  let out = text;
  for (const re of VOLATILE_TEXT_RES) out = out.replace(re, ' ');
  return normaliseWhitespace(out);
}

/** Visible text of an element, whitespace-collapsed. */
export function textOf(el: El): string {
  return normaliseWhitespace(el.textContent ?? '');
}

/**
 * The distinct text runs inside an element, in document order — Facebook splits
 * a single message across several `dir="auto"` nodes (one per line, per emoji
 * run, per link), so taking only the first or only the longest loses part of
 * what the customer wrote. Duplicates are dropped because outer nodes repeat
 * their children's text.
 */
export function textRuns(el: El, selectors: readonly string[]): string[] {
  const nodes = queryAll(el, selectors);
  const runs: string[] = [];
  const seen = new Set<string>();
  // Walked deepest-first so an ancestor that merely repeats its children's text
  // is recognised as a duplicate and dropped, rather than swallowing them.
  for (const node of [...nodes].reverse()) {
    const text = textOf(node);
    if (!text || seen.has(text)) continue;
    if (runs.some((existing) => existing.includes(text))) continue;
    seen.add(text);
    runs.unshift(text);
  }
  return runs;
}

/** True when the string is nothing but a relative or short timestamp. */
export function isTimestampish(text: string): boolean {
  return changeSignature(text) === '';
}

/**
 * A timestamp from whichever attribute carries one, as ISO-8601, or null.
 *
 * Null is a perfectly good answer and the callers treat it as one: the CRM
 * falls back to arrival time. Guessing at a half-parsed human-formatted string
 * would put a wrong `provider_ts` on a message, and a wrong timestamp is worse
 * than a missing one — it silently reorders a conversation.
 */
export function timestampFrom(el: El, attrs: readonly string[]): string | null {
  for (const node of [el, ...el.querySelectorAll('*')]) {
    for (const attr of attrs) {
      const raw = node.getAttribute(attr);
      if (!raw) continue;

      // `data-utime` is unix seconds, and is the only variant that is
      // unambiguous enough to trust without further checking.
      if (/^\d{9,11}$/.test(raw.trim())) {
        const ms = Number(raw.trim()) * 1000;
        if (Number.isFinite(ms)) return new Date(ms).toISOString();
        continue;
      }

      const parsed = Date.parse(raw);
      // A bare "12:30" parses in some runtimes as today at 12:30, which would
      // invent a date out of nothing — a usable timestamp has to name at least
      // a month or a year somewhere in it.
      if (Number.isFinite(parsed) && /\d{4}|[A-Za-z]{3}/.test(raw)) {
        return new Date(parsed).toISOString();
      }
    }
  }
  return null;
}
