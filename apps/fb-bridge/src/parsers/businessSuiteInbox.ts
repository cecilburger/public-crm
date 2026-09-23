import { BIZ_INBOX } from '../selectors.ts';
import { changeSignature, parseHtml, queryAll, queryFirst, textOf, type El } from './dom.ts';

export interface BusinessSuiteThreadRow {
  /** Position in the list, newest first — the `N` in `thread_rowN`. */
  index: number;
  /** The contact's display name as the row shows it. Not an identity. */
  title: string;
  /** Changes when the row changes (a new preview line, a new time). */
  signature: string;
}

export interface BusinessSuiteThreadList {
  rows: BusinessSuiteThreadRow[];
  /** How many row-shaped things the list held. Zero with a container present
   * means either an empty inbox or a stale selector, and the two cannot be
   * told apart from here — so it is reported, not swallowed. */
  rowCount: number;
}

/**
 * The Business Suite conversation list, as far as markup alone can read it.
 *
 * Pure, and exercised by `tests/fixtures/facebook/business-suite-inbox.html`.
 * What this deliberately does NOT return is a conversation id, because the
 * markup does not contain one: a row is a name, a preview and a time, and the
 * id exists only in the channel-selector links once the row is selected. The
 * transport does that selecting; this file only says which rows exist and
 * whether each has changed since last time.
 *
 * Rows are keyed by index rather than by title on purpose. Two customers can
 * share a display name, and the index is the one thing the list guarantees is
 * distinct. The title is carried alongside because the transport uses it — but
 * only when it is unique in the reading — to avoid re-clicking a row whose id
 * it already learned.
 */
export function parseBusinessSuiteThreadList(html: string): BusinessSuiteThreadList {
  const root = parseHtml(html);
  const container = queryFirst(root, BIZ_INBOX.list) ?? root;
  const candidates = queryAll(container, BIZ_INBOX.row);

  const rows: BusinessSuiteThreadRow[] = [];
  for (const row of candidates) {
    const index = indexOf(row);
    // `thread_title` surfaces also contain "thread_" and sit inside a row;
    // anything without a numeric row suffix is a descendant, not a row.
    if (index === null) continue;
    const title = textOf(queryFirst(row, BIZ_INBOX.rowTitle) ?? row).trim();
    rows.push({ index, title, signature: changeSignature(textOf(row)) });
  }

  rows.sort((a, b) => a.index - b.index);
  return { rows, rowCount: rows.length };
}

function indexOf(row: El): number | null {
  const surface = row.getAttribute('data-surface') ?? '';
  const match = BIZ_INBOX.rowIndexRe.exec(surface);
  return match ? Number(match[1]) : null;
}
