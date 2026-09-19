import { MESSAGE_ID_RE, THREAD } from '../selectors.ts';
import {
  isTimestampish, parseHtml, queryAll, queryFirst, textOf, textRuns, timestampFrom, type El,
} from './dom.ts';

export interface ParsedMessage {
  /** Facebook's own `mid.$...`, when this row exposed one. Null is normal and
   * the caller has a documented fallback — it is not an error. */
  externalMessageId: string | null;
  senderName: string;
  text: string;
  /** ISO-8601 or null. */
  sentAt: string | null;
}

export interface ParsedThread {
  /** Inbound messages, oldest first, in the order the DOM rendered them. */
  messages: ParsedMessage[];
  /** Rows recognised as the connected Page's own replies. Counted rather than
   * returned: this bridge is inbound-only and has nothing to do with them. */
  outboundRows: number;
  /**
   * Rows that looked like messages but whose sender could not be established.
   *
   * These are dropped, never guessed at, and the count is what makes that
   * visible. An inbound-only bridge that guesses wrong ingests the operator's
   * own reply as though the customer had said it — which then reaches the
   * inbox, the unanswered-conversation count, and (once anything is wired to
   * it) whatever answers messages. Dropping is the safe direction; a non-zero
   * count here on every row is how the watcher knows a selector went stale
   * instead of reporting a quiet, wrong "no new messages".
   */
  unknownSenderRows: number;
  /** Total rows matched, so "the container changed but nothing inside it looks
   * like a message any more" is distinguishable from "an empty conversation". */
  matchedRows: number;
}

export interface ParseThreadOptions {
  /** The connected Page's own name. Anything sent by it is outbound. */
  selfName?: string | null;
}

/**
 * Turns a Messenger thread's rendered scrollback into inbound messages.
 *
 * Pure, and fully exercised by `tests/fixtures/facebook/*.html` — no browser and
 * no Facebook account. That is the whole reason the in-page half of this
 * scraper does nothing but hand over a container's `outerHTML`.
 *
 * DIRECTION IS DECIDED CONSERVATIVELY. A row is reported as inbound only when
 * a sender who is not us can be established — either named in the row itself,
 * or inherited from the bubble directly above it, which is how Messenger groups
 * a run of consecutive messages. Everything else — an explicit self-marker, a
 * sender matching the Page's own name, or a row with no attributable sender at
 * all — is excluded. See `unknownSenderRows`.
 */
export function parseMessengerThread(html: string, opts: ParseThreadOptions = {}): ParsedThread {
  const root = parseHtml(html);
  const container = queryFirst(root, THREAD.messageList) ?? root;
  const rows = queryAll(container, THREAD.row);

  const selfName = opts.selfName?.trim().toLowerCase() || null;
  const messages: ParsedMessage[] = [];
  let outboundRows = 0;
  let unknownSenderRows = 0;

  // Messenger groups a run of consecutive messages from one person, labelling
  // the first bubble and leaving the rest bare. So a bare bubble belongs to
  // whoever sent the bubble above it — which is a reading of how the UI works,
  // not a guess, and it resets the moment the other side speaks.
  //
  // An earlier version instead attributed every bare row to "the other party in
  // this thread". That is a different and much weaker claim, and it was wrong:
  // it swallowed a date divider — a row with real text and no sender — and
  // reported "19 September 2026" to the CRM as a customer message.
  let runSender: { name: string; isSelf: boolean } | null = null;

  for (const row of rows) {
    const label = (row.getAttribute('aria-label') ?? '').trim();

    if (THREAD.selfLabelRe.test(label)) {
      runSender = { name: opts.selfName ?? '', isSelf: true };
      outboundRows += 1;
      continue;
    }

    const explicit = senderOf(row, label);
    const sender = explicit
      ? { name: explicit, isSelf: Boolean(selfName && explicit.toLowerCase() === selfName) }
      : runSender;

    if (!sender) {
      // A row with no text at all is chrome (a typing indicator, a read
      // receipt), not a message whose sender we failed to read — counting it
      // as a failure would cry wolf on every healthy thread.
      if (bodyOf(row, null)) unknownSenderRows += 1;
      continue;
    }
    runSender = sender;

    if (sender.isSelf) {
      outboundRows += 1;
      continue;
    }

    const senderName = sender.name;
    const text = bodyOf(row, senderName);
    // A bubble that rendered as an attachment, a sticker or a reaction carries
    // no text. Ingesting an empty message would put a blank line in the
    // transcript and, worse, consume a `seq` — so it is skipped outright.
    if (!text) continue;

    messages.push({
      externalMessageId: MESSAGE_ID_RE.exec(row.toString())?.[0] ?? null,
      senderName,
      text,
      sentAt: timestampFrom(row, THREAD.timeAttrs),
    });
  }

  return { messages, outboundRows, unknownSenderRows, matchedRows: rows.length };
}

/**
 * Who this row explicitly says sent it, or null when nothing in it says.
 *
 * Only readings of what the markup actually states — never an inference. Two
 * shapes, most specific first, because each is a different way Facebook has
 * exposed the same fact and one of them still working is enough to keep the
 * bridge correct. Whether a null here can be filled in from the run above is
 * the caller's decision, not this function's.
 */
function senderOf(row: El, label: string): string | null {
  const fromLabel = THREAD.senderLabelRe.exec(label)?.[1]
    ?? THREAD.senderSentLabelRe.exec(label)?.[1];
  if (fromLabel?.trim()) return fromLabel.trim();

  const avatar = queryFirst(row, [THREAD.avatarAlt]);
  const alt = avatar?.getAttribute('alt')?.trim();
  if (alt) return alt;

  return null;
}

/**
 * The message body, with the chrome Facebook renders inside the same row
 * removed: the sender's own name, and anything that is only a timestamp.
 *
 * Runs are joined with newlines rather than spaces because a multi-line message
 * arrives as several nodes, and gluing them together would silently rewrite
 * what the customer typed.
 */
function bodyOf(row: El, senderName: string | null): string {
  const runs = textRuns(row, THREAD.textNode);
  const source = runs.length > 0 ? runs : [textOf(row)];

  return source
    .filter((run) => run && run !== senderName && !isTimestampish(run))
    .join('\n')
    .trim();
}
