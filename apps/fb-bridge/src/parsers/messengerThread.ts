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

export type Direction = 'inbound' | 'outbound';

export interface ParsedTranscriptMessage extends ParsedMessage {
  direction: Direction;
}

export interface ParsedTranscript {
  /** Every message the transcript showed, oldest first, with its direction. */
  messages: ParsedTranscriptMessage[];
  unknownSenderRows: number;
  matchedRows: number;
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
/**
 * Every message in the transcript, each labelled with its direction.
 *
 * `parseMessengerThread` reports only what the customer said, which is all the
 * live watcher needs. History reconciliation needs more: a conversation that
 * predates the bridge contains our own replies too, and importing it without
 * them would leave the CRM showing a customer talking to nobody. Those replies
 * are history, not work — they are written straight into the transcript, never
 * queued to be sent a second time.
 */
export function parseMessengerTranscript(html: string, opts: ParseThreadOptions = {}): ParsedTranscript {
  const root = parseHtml(html);
  const container = queryFirst(root, THREAD.messageList) ?? root;
  const rows = queryAll(container, THREAD.row);

  const selfName = opts.selfName?.trim().toLowerCase() || null;
  const messages: ParsedTranscriptMessage[] = [];
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
      const ownText = bodyOf(row, null);
      if (ownText) {
        messages.push({
          externalMessageId: messageIdOf(row),
          senderName: opts.selfName ?? '', text: ownText,
          sentAt: timestampFrom(row, THREAD.timeAttrs), direction: 'outbound',
        });
      }
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

    const senderName = sender.name;
    const text = encoded?.text.trim() || bodyOf(row, senderName);
    // A bubble that rendered as an attachment, a sticker or a reaction carries
    // no text. Ingesting an empty message would put a blank line in the
    // transcript and, worse, consume a `seq` — so it is skipped outright.
    if (!text) continue;

    messages.push({
      externalMessageId: messageIdOf(row),
      senderName,
      text,
      sentAt: timestampFrom(row, THREAD.timeAttrs),
      direction: sender.isSelf ? 'outbound' : 'inbound',
    });
  }

  return { messages, unknownSenderRows, matchedRows: candidates.length };
}

/**
 * What the customer said, and nothing else — the view the live watcher acts on.
 *
 * Kept as its own function so the inbound-only guarantee is stated in one
 * place: an inbound-only bridge that mistakes its own reply for a customer
 * message reports the operator's words back to them as a new enquiry.
 */
export function parseMessengerThread(html: string, opts: ParseThreadOptions = {}): ParsedThread {
  const parsed = parseMessengerTranscript(html, opts);
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
 * Facebook's own id for this message, or null.
 *
 * Read from the row itself first, then from a descendant of that row, and only
 * then by regex over the row's own markup. Every step is scoped to one row, so
 * a neighbouring message's id can never be attributed here — which matters,
 * because that id is the dedup key: borrowing one would make two different
 * messages collapse into a single CRM row and lose a customer's words.
 */
function messageIdOf(row: El): string | null {
  for (const attr of THREAD.messageIdAttrs) {
    const own = row.getAttribute(attr);
    const match = own ? MESSAGE_ID_RE.exec(own) : null;
    if (match) return match[0];
  }
  for (const attr of THREAD.messageIdAttrs) {
    for (const node of queryAll(row, [`[${attr}]`])) {
      const value = node.getAttribute(attr);
      const match = value ? MESSAGE_ID_RE.exec(value) : null;
      if (match) return match[0];
    }
  }
  // Last resort. Still scoped: this is the row's own outerHTML, so a sibling's
  // id is not in it. A nested row's would be, which is why `dropNestedRows`
  // runs before any of this.
  return MESSAGE_ID_RE.exec(row.toString())?.[0] ?? null;
}

/**
 * How many messages in this transcript are ours *and* say exactly this.
 *
 * This is the whole proof that a send worked. An emptied composer is not:
 * Facebook clears it optimistically, so a message the server rejected looks
 * identical to one it accepted — `apps/ig-bridge` confirmed that live on a
 * thread being silently rate-limited.
 *
 * It returns a count rather than a boolean because the caller compares before
 * and after. A customer service reply is frequently the same words twice
 * ("baik kak", "siap"), so "our text is present" would report success the
 * instant an earlier identical message was already on screen — including when
 * nothing was sent at all.
 *
 * Reads the same aria-label shape `parseMessengerThread` reads, so "sent" means
 * exactly what "received" means, and the same fixtures cover both.
 */
export function countOwnMessages(
  html: string, opts: { text: string; selfName?: string | null },
): number {
  const root = parseHtml(html);
  const container = queryFirst(root, THREAD.messageList) ?? root;
  const selfName = opts.selfName?.trim().toLowerCase() || null;
  const wanted = opts.text.trim();

  let count = 0;
  for (const row of dropNestedRows(queryAll(container, THREAD.row))) {
    const label = (row.getAttribute('aria-label') ?? '').trim();
    if (THREAD.rowChromeRe.test(label)) continue;

    const encoded = fromMessageLabel(label);
    if (encoded) {
      if (isSelfSender(encoded.sender, selfName) && encoded.text.trim() === wanted) count += 1;
      continue;
    }
    // The older shape: a row marked as ours, with the body in its text nodes.
    if (THREAD.selfLabelRe.test(label) && bodyOf(row, null).trim() === wanted) count += 1;
  }
  return count;
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

/**
 * Which messages from a rendered transcript still need to reach the CRM.
 *
 * Discovery walks newest to oldest and stops at the first message the CRM
 * already holds: everything behind it is necessarily older and therefore
 * already stored, so reading further is wasted work. The result is then
 * reversed, because a conversation has to arrive in the order it happened.
 *
 * `maxMessages` is the backstop for the other case — a thread whose known
 * anchor has scrolled out of the rendered window entirely, where without a
 * limit a long conversation would be re-imported wholesale.
 *
 * ONLY MESSAGES CARRYING A STABLE FACEBOOK ID ARE CONSIDERED. The fallback key
 * used elsewhere includes a per-thread sequence number that the bridge hands
 * out when it first sees a message; that number cannot be reconstructed after a
 * restart, so using it here would not deduplicate against what the CRM already
 * has — it would manufacture a second copy of every message on every
 * reconciliation. Messages without an id are left to the live watcher, which
 * does have the sequence.
 */
export function selectBackfill(
  messages: ParsedTranscriptMessage[],
  opts: { isKnown: (externalMessageId: string) => boolean; maxMessages: number },
): ParsedTranscriptMessage[] {
  const missing: ParsedTranscriptMessage[] = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (!message.externalMessageId) continue;
    if (opts.isKnown(message.externalMessageId)) break;
    if (missing.length >= opts.maxMessages) break;
    missing.push(message);
  }

  return missing.reverse();
}
