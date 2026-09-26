import { COMMENTS, POST_ID_RE } from '../selectors.ts';
import { links, parseHtml, textOf, type El } from './dom.ts';

/**
 * What a post IS, for a person reading the CRM inbox: its caption and its age.
 *
 * The inbox names a comment group after its post with these, instead of the
 * `pfbid…` slug no agent can read. Read off markup the watcher already holds —
 * the Page timeline it reloads every minute, and a post's own permalink when a
 * sweep opens it — so this costs no extra page load.
 *
 * Confirmed live, 2026-09-26, on both surfaces: the caption sits in the post's
 * own `data-ad-rendering-role="story_message"`, and the post's age appears
 * only as the text of its own permalink link ("2 days ago"). Nothing in the
 * markup carries an absolute date, and the image is a signed CDN URL that
 * expires within days, so no thumbnail is taken.
 */

/** The longest caption kept: far past anything a title or the detail view shows, and a bound on one reading. */
export const POST_CAPTION_MAX = 2_000;

export interface PostDetails {
  /** The caption, one line per paragraph; null when the post has none (a photo-only post). */
  text: string | null;
  /** When the post went up, as ISO-8601, derived from the age Facebook shows; null when unreadable. */
  createdAt: string | null;
}

export interface PostDetailsUpdate extends PostDetails {
  postId: string;
}

export function postDetailsOf(post: El, now: Date): PostDetails {
  return { text: captionOf(post), createdAt: ageOf(post, now) };
}

/* --------------------------------------------------------------- caption */

/**
 * The post's own caption. Only its OWN: a comment under the post is itself an
 * article with a message node of its own, and a customer's words must never
 * become the name of the Page's post.
 */
function captionOf(post: El): string | null {
  const message = ownFirst(post, COMMENTS.postMessage);
  if (!message) return null;
  // A private copy to read from, so the page's own tree is left as it was:
  // an emoji is an <img> whose alt is the emoji, and "See more" is a control
  // inside the caption, not part of it.
  const copy = parseHtml(message.innerHTML.replace(EMOJI_IMG_RE, (_tag, alt: string) => emojiText(alt)));
  const cutControls = copy.querySelectorAll('[role="button"]');
  for (const control of cutControls) control.remove();

  const blocks = copy.querySelectorAll('div[dir="auto"]').filter((el) => el.querySelectorAll('div[dir="auto"]').length === 0);
  let text = (blocks.length > 0 ? blocks : [copy]).map(textOf).filter((line) => line !== '').join('\n');
  // Cut behind "See more" on the timeline: what shows ends in an ellipsis that is not the Page's.
  if (cutControls.length > 0) text = text.replace(/\s*(?:…|\.{3})$/u, '');
  text = text.trim();
  return text ? Array.from(text).slice(0, POST_CAPTION_MAX).join('') : null;
}

const EMOJI_IMG_RE = /<img\b[^>]*?\balt="([^"]*)"[^>]*>/g;

/** An emoji's alt text, and nothing that is not plainly one: markup never goes back into the copy. */
function emojiText(alt: string): string {
  return Array.from(alt).length <= 8 && !/[<>&]/.test(alt) ? alt : '';
}

/* ------------------------------------------------------------------- age */

/** The post's age, from its own permalink link — never from a comment's permalink under it. */
function ageOf(post: El, now: Date): string | null {
  for (const { el, href } of links(post)) {
    if (!POST_ID_RE.test(href) || /[?&](?:comment_id|reply_comment_id)=/.test(href)) continue;
    if (!belongsTo(el, post)) continue;
    const at = postTimeFromLabel(el.getAttribute('aria-label')?.trim() || textOf(el), now);
    if (at) return at;
  }
  return null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNITS: Record<string, number> = {
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE, mnt: MINUTE, menit: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR, j: HOUR, jam: HOUR,
  d: DAY, day: DAY, days: DAY, hari: DAY,
  w: 7 * DAY, wk: 7 * DAY, wks: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY, mgg: 7 * DAY, minggu: 7 * DAY,
};
const MONTHS: Record<string, number> = {
  january: 0, januari: 0, jan: 0, february: 1, februari: 1, feb: 1, march: 2, maret: 2, mar: 2,
  april: 3, apr: 3, may: 4, mei: 4, june: 5, juni: 5, jun: 5, july: 6, juli: 6, jul: 6,
  august: 7, agustus: 7, aug: 7, agu: 7, agt: 7, ags: 7, september: 8, sept: 8, sep: 8,
  october: 9, oktober: 9, oct: 9, okt: 9, november: 10, nov: 10, december: 11, desember: 11, dec: 11, des: 11,
};

const JUST_NOW_RE = /^(?:just now|a few seconds ago|baru saja)$/;
const RELATIVE_RE = /^(\d{1,3}|an?)\s*([a-z]+)(?:\s+(?:ago|yang lalu|lalu))?$/;
const TIME = String.raw`(?:\s+(?:at|pukul)\s+(\d{1,2})[:.](\d{2})\s*(am|pm)?)?`;
const YESTERDAY_RE = new RegExp(String.raw`^(?:yesterday|kemarin)${TIME}$`);
const MONTH_FIRST_RE = new RegExp(String.raw`^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?${TIME}$`);
const DAY_FIRST_RE = new RegExp(String.raw`^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?${TIME}$`);

type ClockTime = Array<string | undefined>;

/**
 * When a post went up, from the words Facebook shows for its age, in English
 * or Indonesian. Relative ages count back from `now`; a date without a time is
 * taken at noon, so it names the same calendar day in any nearby time zone;
 * a date without a year that would lie in the future is last year's.
 *
 * Bounded on purpose: anything it does not recognise is null, never a guess —
 * a wrong date on a post is worse than none. Indonesian's short "2 h" (hari)
 * is not read, because in English the same "2 h" is hours.
 */
export function postTimeFromLabel(label: string, now: Date): string | null {
  const text = label.toLowerCase().replace(/[\s ]+/g, ' ').trim();
  if (!text) return null;
  if (JUST_NOW_RE.test(text)) return now.toISOString();

  // "20 September" has the same shape as "20 minutes": only a unit of time
  // makes it an age; anything else goes on to be read as a date below.
  const relative = RELATIVE_RE.exec(text);
  const unit = relative ? UNITS[relative[2]!] : undefined;
  if (relative && unit) {
    const count = /^an?$/.test(relative[1]!) ? 1 : Number(relative[1]);
    return new Date(now.getTime() - count * unit).toISOString();
  }

  const yesterday = YESTERDAY_RE.exec(text);
  if (yesterday) {
    // Day 0 rolls back into the previous month, which is exactly "yesterday" on the 1st.
    return wallClock(now.getFullYear(), now.getMonth(), now.getDate() - 1, yesterday.slice(1, 4))?.toISOString() ?? null;
  }

  const monthFirst = MONTH_FIRST_RE.exec(text);
  const monthOfFirst = monthFirst ? MONTHS[monthFirst[1]!] : undefined;
  if (monthFirst && monthOfFirst !== undefined) {
    return calendarDate(Number(monthFirst[3] ?? 0), monthOfFirst, Number(monthFirst[2]), monthFirst.slice(4, 7), now);
  }
  const dayFirst = DAY_FIRST_RE.exec(text);
  const monthOfDay = dayFirst ? MONTHS[dayFirst[2]!] : undefined;
  if (dayFirst && monthOfDay !== undefined) {
    return calendarDate(Number(dayFirst[3] ?? 0), monthOfDay, Number(dayFirst[1]), dayFirst.slice(4, 7), now);
  }
  return null;
}

/** A named date — year 0 when none was given — or null when no such day exists ("31 Februari"). */
function calendarDate(year: number, month: number, day: number, time: ClockTime, now: Date): string | null {
  const on = (y: number): Date | null => {
    const at = wallClock(y, month, day, time);
    // `new Date(2026, 1, 31)` quietly rolls into March instead of failing.
    return at && at.getMonth() === month && at.getDate() === day ? at : null;
  };
  if (year) return on(year)?.toISOString() ?? null;
  const thisYear = on(now.getFullYear());
  if (thisYear && thisYear.getTime() <= now.getTime() + DAY) return thisYear.toISOString();
  return on(now.getFullYear() - 1)?.toISOString() ?? null;
}

/**
 * A local wall-clock time on the bridge's machine — the zone Facebook renders
 * this session's dates in — at noon when no time was given, or null for a
 * time that cannot be one.
 */
function wallClock(year: number, month: number, day: number, time: ClockTime): Date | null {
  const [hh, mm, meridiem] = time;
  if (hh === undefined || mm === undefined) return new Date(year, month, day, 12, 0);
  let hours = Number(hh);
  const minutes = Number(mm);
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  if (hours > 23 || minutes > 59) return null;
  return new Date(year, month, day, hours, minutes);
}

/* ------------------------------------------------------------------ scope */

/** The first element matching any of these, in order, that belongs to this post and not to a comment inside it. */
function ownFirst(post: El, selectors: readonly string[]): El | null {
  for (const selector of selectors) {
    let found: El[];
    try {
      found = post.querySelectorAll(selector);
    } catch {
      continue;
    }
    const own = found.find((el) => belongsTo(el, post));
    if (own) return own;
  }
  return null;
}

/** Whether the nearest article around this element is the post itself. */
function belongsTo(el: El, post: El): boolean {
  let node = el.parentNode as El | null;
  while (node && node !== post) {
    if (node.getAttribute?.('role') === 'article') return false;
    node = node.parentNode as El | null;
  }
  return node === post;
}
