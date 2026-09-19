import { INBOX, THREAD_ID_RE } from '../selectors.ts';
import { changeSignature, closestRow, links, parseHtml, queryFirst, textOf, type El } from './dom.ts';

export interface InboxRow {
  /** The real thread id, straight out of the row's own link. */
  threadId: string;
  /** Whatever Facebook is currently rendering as the other party's name.
   * Display only — identity is the id in the thread URL, never this. */
  name: string;
  /**
   * The row's text with self-ticking parts removed. The watcher compares this
   * against the previous reading to decide whether a thread actually changed;
   * it is never stored or shown.
   */
  signature: string;
}

export interface ParsedInbox {
  rows: InboxRow[];
  /** How many `/t/` links were found in total, before deduplication. Zero on a
   * page that should have conversations is the signal that a selector went
   * stale, and the watcher raises it rather than reporting "no new messages". */
  linkCount: number;
}

/**
 * Reads the Messenger conversation list.
 *
 * The one genuinely easier thing about Facebook than Instagram: every row here
 * is an `<a href="/messages/t/<id>">`, so a thread's real id is readable
 * directly. `apps/ig-bridge` had to click each row and watch where the browser
 * navigated, because Instagram's rows carry no id at all — an expensive dance
 * with a page navigation per thread, which this does not need and must not
 * copy.
 *
 * Pure: give it the container's `outerHTML` and it answers. It never navigates,
 * never touches a page, and can be run against a fixture file.
 */
export function parseMessengerInbox(html: string): ParsedInbox {
  const root = parseHtml(html);
  const list = queryFirst(root, INBOX.list) ?? root;

  const found = links(list)
    .map(({ el, href }) => ({ el, threadId: THREAD_ID_RE.exec(href)?.[1] }))
    .filter((entry): entry is { el: El; threadId: string } => Boolean(entry.threadId));

  const rows = new Map<string, InboxRow>();
  for (const { el, threadId } of found) {
    // The signature is taken over this conversation's own row, found by walking
    // up to the nearest row role rather than by counting hops — a fixed number
    // of hops overshoots into the list container, which makes every row's
    // signature identical to every other's and hides the change entirely. When
    // no row ancestor exists the link itself is the scope, which on Messenger's
    // markup already holds the name, the preview and the timestamp.
    const scope = closestRow(el);
    const name = nameOf(el);
    const signature = changeSignature(textOf(scope));

    // First occurrence wins: a thread rendered twice (Facebook does this while
    // a list re-renders) is one conversation, and the first reading is the one
    // whose scope has not been torn down mid-read.
    if (!rows.has(threadId)) rows.set(threadId, { threadId, name, signature });
  }

  return { rows: [...rows.values()], linkCount: found.length };
}

/**
 * The row's accessible name, preferring the attributes Facebook puts it in over
 * the link's visible text — the visible text of a row is name plus preview plus
 * timestamp run together, which is not a name.
 */
function nameOf(el: El): string {
  for (const attr of INBOX.rowNameAttrs) {
    const value = el.getAttribute(attr)?.trim();
    if (value) return value;
  }
  // Nothing labelled: fall back to the first line of the link's own text, which
  // is the name in every layout seen so far.
  return textOf(el).split('\n')[0]?.trim() ?? '';
}
