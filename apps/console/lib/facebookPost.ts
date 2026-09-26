import { t } from './copy';
import { dateOnly, dayMonth } from './format';
import type { CommentPost } from './inbox';

/**
 * How the inbox names a Facebook post: by its caption, the way the person who
 * wrote it remembers it — never by the `pfbid…` slug Facebook addresses it by.
 * The slug stays the post's identity everywhere else (grouping, links,
 * replies); it just is not something an agent can read.
 *
 * Pure, so the list row and the detail header name a post the same way and
 * the rules below are tested without a browser.
 */

/** Longest title, in characters: a list row is one line, the detail header has room for a sentence. */
export const POST_TITLE_MAX = { list: 60, detail: 110 } as const;

export interface PostHeading {
  /** The caption as one line, cut to fit — or "Postingan Facebook" when there is none. */
  title: string;
  hasCaption: boolean;
  /** True when the title had to be cut short. */
  truncated: boolean;
  /** The whole caption, its lines kept, for the detail view; null when there is none. */
  fullText: string | null;
  /** When the post went up, formatted: "26 Sep" in a list, "26 Sep 2026" in the detail. */
  date: string | null;
}

/**
 * A caption as a one-line title of at most `max` characters, or null when
 * there is no caption. Cut at the last space when one is near the end, so a
 * word is not halved, and marked with "…"; counted in characters, never
 * UTF-16 units, so an emoji is never split in two.
 */
export function captionTitle(text: string | null | undefined, max: number): { title: string; truncated: boolean } | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  if (chars.length <= max) return { title: flat, truncated: false };

  const room = chars.slice(0, max - 1);
  const atWordEnd = chars[max - 1] === ' ';
  const lastSpace = room.lastIndexOf(' ');
  const kept = atWordEnd || lastSpace < Math.floor(max * 0.6) ? room : room.slice(0, lastSpace);
  const body = kept.join('').replace(/[\s,.;:!?·\-–—]+$/u, '') || room.join('');
  return { title: `${body}…`, truncated: true };
}

export function postHeading(post: CommentPost, opts: { max: number; dateStyle: 'short' | 'long' }): PostHeading {
  const caption = captionTitle(post.text, opts.max);
  return {
    title: caption?.title ?? t.inbox.postFallbackTitle,
    hasCaption: caption !== null,
    truncated: caption?.truncated ?? false,
    fullText: caption ? (post.text ?? '').trim() : null,
    date: post.createdAt ? (opts.dateStyle === 'long' ? dateOnly(post.createdAt) : dayMonth(post.createdAt)) : null,
  };
}

/** The list row's second line: "9 komentar · 26 Sep". */
export function listMeta(heading: PostHeading, commentCount: number): string {
  return [t.inbox.commentCount(commentCount), heading.date].filter(Boolean).join(' · ');
}

/**
 * The detail header's second line: "Facebook · 26 Sep 2026 · 9 komentar".
 * The platform goes only beside a caption — a post with none is already
 * titled "Postingan Facebook".
 */
export function detailSubtitle(heading: PostHeading, commentCount: number): string {
  return [heading.hasCaption ? t.inbox.platformFacebook : null, heading.date, t.inbox.commentCount(commentCount)]
    .filter(Boolean).join(' · ');
}
