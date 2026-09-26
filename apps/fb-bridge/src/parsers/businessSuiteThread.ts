import { BIZ_THREAD, DIRECTION_ATTR, MESSAGE_ID_RE } from '../selectors.ts';
import { normaliseWhitespace, parseHtml, queryAll, queryFirst, textOf, textRuns, type El } from './dom.ts';
import type {
  Direction, ParsedThread, ParsedTranscript, ParsedTranscriptMessage,
} from './messengerThread.ts';

export interface ParseBusinessSuiteOptions {
  /**
   * The other party's display name, read from the conversation header or the
   * inbox row. Business Suite bubbles never name a sender, so unlike
   * messenger.com there is nothing in the transcript itself to fall back on.
   */
  contactName?: string | null;
  /** The connected Page's own name, used for our own side of the history. */
  selfName?: string | null;
}

/**
 * A Business Suite transcript, every message labelled with its direction.
 *
 * Pure, and exercised entirely by `tests/fixtures/facebook/business-suite-*.html`
 * — no browser, no Facebook account. The same contract as the messenger.com
 * parser, and deliberately NOT the same implementation: the two surfaces encode
 * a message in opposite ways. messenger.com puts sender and body together in
 * one `aria-label` and leaves the markup bare; Business Suite puts the body in
 * the element's own text, names no sender anywhere, and states direction only
 * through layout. Forcing one parser to straddle both would make every rule in
 * it conditional, and the conditionals would be the bugs.
 *
 * DIRECTION IS NEVER INFERRED HERE. It arrives as `data-kirana-direction`,
 * stamped by the in-page measurement layer, which is the only place the
 * computed style carrying it can be read. A message without that attribute is
 * dropped and counted, never guessed at — a wrong guess files an agent's own
 * reply as something the customer said, which then reaches the inbox, the
 * unanswered count, and anything that answers messages.
 */
export function parseBusinessSuiteTranscript(
  html: string, opts: ParseBusinessSuiteOptions = {},
): ParsedTranscript {
  const root = parseHtml(html);
  const container = queryFirst(root, BIZ_THREAD.messageList) ?? root;
  const rows = dropNestedRows(queryAll(container, BIZ_THREAD.row));

  const messages: ParsedTranscriptMessage[] = [];
  let unknownSenderRows = 0;

  for (const row of rows) {
    const text = bodyOf(row);
    // A bubble that rendered as a sticker, an attachment or a reaction carries
    // no text. Ingesting it would put a blank line in the transcript and
    // consume a `seq`, so it is skipped rather than counted as a failure.
    if (!text) continue;

    const direction = directionOf(row);
    if (!direction) {
      unknownSenderRows += 1;
      continue;
    }

    messages.push({
      externalMessageId: messageIdOf(row),
      senderName: (direction === 'outbound' ? opts.selfName : opts.contactName)?.trim() || '',
      text,
      sentAt: utimeFrom(row, container),
      direction,
    });
  }

  return { messages, unknownSenderRows, matchedRows: rows.length };
}

/**
 * What the customer said, and nothing else — the view the live watcher acts on.
 *
 * Mirrors `parseMessengerThread` so both transports hand the watcher the same
 * shape, and so the inbound-only guarantee is stated once per surface.
 */
export function parseBusinessSuiteThread(
  html: string, opts: ParseBusinessSuiteOptions = {},
): ParsedThread {
  const parsed = parseBusinessSuiteTranscript(html, opts);
  const inbound = parsed.messages.filter((m) => m.direction === 'inbound');
  return {
    messages: inbound.map((m) => ({
      externalMessageId: m.externalMessageId, senderName: m.senderName, text: m.text, sentAt: m.sentAt,
    })),
    outboundRows: parsed.messages.length - inbound.length,
    unknownSenderRows: parsed.unknownSenderRows,
    matchedRows: parsed.matchedRows,
  };
}

/**
 * How many outbound messages in this transcript say exactly this.
 *
 * The proof that a send worked, for the same reason as on messenger.com: an
 * emptied composer proves nothing, because Facebook clears it optimistically
 * whether or not the server took the message. A count rather than a boolean,
 * because a support reply is frequently the same two words as an earlier one,
 * and "our text is on screen" would report success off a message from last
 * week — including when nothing was sent at all.
 *
 * Stricter here than on messenger.com, and able to afford it: direction is
 * measured from the layout rather than read off a display name.
 *
 * The words are compared, not the characters: the page shows a reply back with
 * each line in its own run and nothing between them, and an emoji as a picture
 * with no text at all, so a multi-line reply never read back equal to what was
 * typed — and was failed as unconfirmed after Facebook had delivered it.
 */
export function countOwnBusinessSuiteMessages(html: string, opts: { text: string }): number {
  const parsed = parseBusinessSuiteTranscript(html);
  const wanted = comparableText(opts.text);
  return parsed.messages.filter((m) => m.direction === 'outbound' && comparableText(m.text) === wanted).length;
}

/** Letters and digits only, lower-cased; a message with none keeps its collapsed text. */
function comparableText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') || normaliseWhitespace(text);
}

/**
 * The other party's display name, out of the conversation header.
 *
 * Business Suite states it in exactly one place. The bubbles name nobody, and
 * the inbox row is not reachable by id, so this header is the only reading of
 * who a conversation is with — which is why it is parsed rather than inferred
 * from the thread id.
 *
 * The header also holds its own chrome ("Assign this conversation", "See
 * contact"), so the name is taken as the first line of its text rather than the
 * whole of it. An empty string is an acceptable answer: a nameless contact is
 * still a contact, and the numeric id is the identity anyway.
 */
export function parseBusinessSuiteHeaderName(html: string): string {
  const root = parseHtml(html);
  const header = queryFirst(root, BIZ_THREAD.header) ?? root;
  // Taken as separate text runs rather than by splitting the header's whole
  // text. `textContent` concatenates sibling blocks with no separator at all,
  // so "Sinta" beside an "Assign this conversation" button reads back as one
  // word — which is what a split on whitespace would hand the CRM as a
  // customer's name.
  const runs = textRuns(header, HEADER_TEXT_NODES);
  return runs.find((run) => run && !HEADER_CHROME_RE.test(run)) ?? '';
}

/** The header's own controls render as siblings of the name. */
const HEADER_TEXT_NODES = ['div', 'span', 'h1', 'h2'] as const;

/** Header controls that render before the name when a conversation is busy. */
const HEADER_CHROME_RE = /^(?:assign this conversation|open|drop-down|see contact|tetapkan)/i;

/* ----------------------------------------------------------------- parts */

/**
 * The direction the measurement layer recorded, or null when it recorded none.
 *
 * Read from the message element, then from an ancestor, because the stamp is
 * applied per `[data-message-id]` but a future layout may nest one inside an
 * already-stamped group. Never from a descendant: a quoted reply renders the
 * message it quotes inside the bubble, and borrowing that one's direction would
 * flip the reply itself.
 */
function directionOf(row: El): Direction | null {
  for (let node: El | null = row; node; node = node.parentNode as El | null) {
    const value = node.getAttribute?.(DIRECTION_ATTR)?.trim();
    if (value === 'inbound' || value === 'outbound') return value;
  }
  return null;
}

/**
 * Facebook's own id for this message, or null.
 *
 * Business Suite puts `data-message-id` on the message element itself — the
 * same `mid.$...` value messenger.com uses, confirmed live. That shared shape
 * is what lets both transports feed one idempotency key, so the same
 * conversation read from either surface cannot be stored twice.
 */
function messageIdOf(row: El): string | null {
  for (const attr of BIZ_THREAD.messageIdAttrs) {
    const own = row.getAttribute(attr);
    const match = own ? MESSAGE_ID_RE.exec(own) : null;
    if (match) return match[0];
  }
  return null;
}

/**
 * The message body.
 *
 * Business Suite renders the body as the message element's own text, with no
 * timestamp or delivery receipt inside it — those live in the surrounding
 * group. So unlike messenger.com there is nothing to strip here, and stripping
 * speculatively would risk deleting part of what the customer typed.
 */
function bodyOf(row: El): string {
  return textOf(row).trim();
}

/**
 * The message's own timestamp, as ISO-8601, or null.
 *
 * `data-utime` sits on a group wrapper rather than on the bubble, so this walks
 * upward — checking each ancestor's OWN attribute only, and stopping at the
 * transcript container. Searching downward from an ancestor instead would sweep
 * in a neighbouring message's stamp, and a wrong timestamp is worse than a
 * missing one: it silently reorders the conversation. Null is a good answer;
 * the CRM falls back to arrival time.
 */
function utimeFrom(row: El, container: El): string | null {
  for (let node: El | null = row; node && node !== container; node = node.parentNode as El | null) {
    for (const attr of BIZ_THREAD.timeAttrs) {
      const raw = node.getAttribute?.(attr)?.trim();
      if (!raw || !/^\d{9,11}$/.test(raw)) continue;
      const ms = Number(raw) * 1000;
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  return null;
}

/**
 * Drops message elements nested inside another message element.
 *
 * A quoted reply renders the quoted message inside the replying one, both
 * carrying `data-message-id`. Taking both would report the quoted message a
 * second time, and each copy would consume its own `seq` so nothing downstream
 * could collapse them.
 */
function dropNestedRows(rows: El[]): El[] {
  const set = new Set(rows);
  return rows.filter((row) => {
    let parent = row.parentNode as El | null;
    while (parent) {
      if (set.has(parent)) return false;
      parent = parent.parentNode as El | null;
    }
    return true;
  });
}

/**
 * Facebook's own id of every transcript row that says exactly this text, read
 * through `messageIdOf` — the same reading the inbox watcher keys on — so a
 * sent message can be recorded under the key the watcher will later read it
 * back as, and reconciliation finds it already there.
 */
export function messageIdsWithText(html: string, text: string): string[] {
  const root = parseHtml(html);
  const container = queryFirst(root, BIZ_THREAD.messageList) ?? root;
  const wanted = text.trim();
  return queryAll(container, BIZ_THREAD.row)
    .filter((row) => textOf(row).trim() === wanted)
    .map(messageIdOf)
    .filter((id): id is string => id !== null);
}

/**
 * How many messages in this transcript say exactly this, whichever way they
 * went.
 *
 * The cheap confirmation. `countOwnBusinessSuiteMessages` is the strict one —
 * it knows which side a bubble is on — but it needs the ANNOTATED read, and
 * that read walks every message's ancestors calling `getComputedStyle`, which
 * on a long thread is where a live run wedged past a sixty-second protocol
 * timeout. This reads the plain markup instead.
 *
 * Used only as a before/after DELTA on text the CRM itself just sent, so the
 * one thing it cannot tell apart — the customer happening to send the very
 * same words in the same few seconds — would take a coincidence to produce and
 * costs a false "delivered" rather than a false failure.
 */
export function countMessagesWithText(html: string, text: string): number {
  const root = parseHtml(html);
  const container = queryFirst(root, BIZ_THREAD.messageList) ?? root;
  const wanted = text.trim();
  let count = 0;
  for (const row of queryAll(container, BIZ_THREAD.row)) {
    if (textOf(row).trim() === wanted) count += 1;
  }
  return count;
}
