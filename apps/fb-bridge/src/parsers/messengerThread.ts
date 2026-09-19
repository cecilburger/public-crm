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

/** Who a run of consecutive bubbles belongs to. */
interface RunSender {
  name: string;
  isSelf: boolean;
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
  let runSender: RunSender | null = null;

  // Which shape is this page using? On the real site every message carries its
  // sender and body in one aria-label, and the rows *without* such a label are
  // chrome: the thread header, a date break, a hover toolbar. Guessing at those
  // with the avatar-and-visible-text fallback produced exactly that mistake —
  // confirmed live, a date stamp was reported as a customer message reading
  // "01/03/24 10.51". So when any row speaks the labelled shape, unlabelled
  // rows are known to be chrome rather than messages we failed to read. The
  // fallback strategies stay for a build that exposes no such labels at all.
  const candidates = dropNestedRows(rows);
  const labelled = candidates.some((row) => fromMessageLabel((row.getAttribute('aria-label') ?? '').trim()));

  for (const row of candidates) {
    const label = (row.getAttribute('aria-label') ?? '').trim();

    // Buttons and toolbars live inside the transcript alongside the messages.
    // They carry labels too, so they have to be named and skipped rather than
    // counted as messages whose sender could not be read.
    if (THREAD.rowChromeRe.test(label)) continue;

    // The real site encodes sender and body together in the label, with no
    // separate node carrying either — see `THREAD.messageLabelRes`.
    const encoded = fromMessageLabel(label);
    if (labelled && !encoded) continue;

    if (!encoded && THREAD.selfLabelRe.test(label)) {
      runSender = { name: opts.selfName ?? '', isSelf: true };
      outboundRows += 1;
      continue;
    }

    const explicit = encoded?.sender ?? senderOf(row, label);
    const sender: RunSender | null = explicit
      ? { name: explicit, isSelf: isSelfSender(explicit, selfName) }
      : runSender;

    if (!sender) {
      // A row with no text at all is chrome (a typing indicator, a read
      // receipt), not a message whose sender we failed to read — counting it
      // as a failure would cry wolf on every healthy thread.
      if (encoded?.text || bodyOf(row, null)) unknownSenderRows += 1;
      continue;
    }
    runSender = sender;

    if (sender.isSelf) {
      outboundRows += 1;
      continue;
    }

    const senderName = sender.name;
    const text = encoded?.text.trim() || bodyOf(row, senderName);
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
 * Sender and body out of a single aria-label, or null when this label is not
 * a message at all.
 *
 * This is how the real site exposes a message: not as text in a child node,
 * but encoded in the label — "…pukul 1 Maret 2024 10.51 oleh Anda: <body>".
 * Reading it here rather than guessing which `dir="auto"` node holds the body
 * also avoids picking up the timestamp and the "Terkirim"/"Sent" receipt that
 * sit beside it.
 */
function fromMessageLabel(label: string): { sender: string; text: string } | null {
  if (!label) return null;
  for (const re of THREAD.messageLabelRes) {
    const m = re.exec(label);
    const sender = m?.[1]?.trim();
    const text = m?.[2]?.trim();
    if (sender && text) return { sender, text };
  }
  return null;
}

/**
 * Facebook writes the first person for our own messages ("Anda:", "You:")
 * rather than the Page's name, so matching only against the configured Page
 * name would never recognise our own replies — and an inbound-only bridge that
 * misses them reports the operator's own words as the customer's.
 */
function isSelfSender(sender: string, selfName: string | null): boolean {
  if (THREAD.selfSenderRe.test(sender.trim())) return true;
  return Boolean(selfName && sender.trim().toLowerCase() === selfName);
}

/**
 * Drops rows that sit inside another row.
 *
 * One message renders as a labelled container with a labelled button inside
 * it, both describing the same message. Whichever selector matched, taking
 * both would report the message twice — and each copy would consume its own
 * `seq`, so downstream deduplication could not collapse them either.
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
