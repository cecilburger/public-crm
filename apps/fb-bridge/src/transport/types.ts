import type { Page } from 'puppeteer';
import type { ParsedThread, ParsedTranscript } from '../parsers/messengerThread.ts';

/**
 * Which Facebook surface a tenant's conversations live on.
 *
 * Not a preference. A personal account's messages are on messenger.com and a
 * Page's are in Business Suite, and neither is reachable from the other — a
 * watcher pointed at the wrong one sweeps happily forever and delivers nothing,
 * with no error to notice. Confirmed live: after the session was switched to
 * the Page identity, facebook.com/messages/t/ still served the personal inbox
 * while a customer's message sat unanswered in Business Suite.
 */
export type TransportKind = 'messenger' | 'business_suite';

/** What a transport needs to know about the connection it is reading. */
export interface TransportContext {
  /** The connected Page's own name, used to recognise our own replies. */
  pageName: string | null;
  /**
   * The Business Suite asset id. NOT the Page id — confirmed live, the Page id
   * `61594393176093` and the asset id `1225922357281590` are different numbers
   * for the same Page, and every Business Suite URL wants the asset id. Null on
   * messenger.com, which has no such concept.
   */
  assetId: string | null;
}

export interface InboxRow {
  /** The conversation's own id, as its transport names it. */
  threadId: string;
  name: string;
  /** Changes when the row changes; the watcher diffs on this. */
  signature: string;
}

export interface InboxReading {
  rows: InboxRow[];
  /**
   * How many conversation-shaped things the container held, before any were
   * turned into rows. Zero with a container present means either a genuinely
   * empty inbox or a stale selector, and the two are indistinguishable from
   * here — so it is reported rather than swallowed.
   */
  rowCount: number;
}

export interface ParseOptions {
  /** The other party's display name, where the transport must supply it. */
  contactName?: string | null;
  selfName?: string | null;
}

/**
 * One Facebook surface, behind the single interface the watcher speaks.
 *
 * Everything that differs between messenger.com and Business Suite lives in an
 * implementation of this and nowhere else — URLs, selectors, how a transcript
 * is read out of the page, and which parser understands it. The watcher's
 * diffing, anchoring, backfill and idempotency stay shared, because those are
 * about conversations rather than about markup.
 */
export interface ThreadTransport {
  readonly kind: TransportKind;

  /**
   * Whether this transport can enumerate conversations it has not been told
   * about.
   *
   * messenger.com can: every inbox row carries an href to its own thread.
   * Business Suite's rows carry no id at all, so only the conversation it has
   * already selected is identifiable. A transport that cannot discover is not
   * broken — it still reconciles the conversations already known — but the
   * watcher has to say so out loud rather than look healthy while missing new
   * enquiries.
   */
  readonly discoversConversations: boolean;

  inboxUrl(ctx: TransportContext): string;
  threadUrl(ctx: TransportContext, threadId: string): string;

  /** Waited for after navigating, so a read never lands on a loading skeleton. */
  readonly inboxWaitSelectors: readonly string[];
  readonly threadWaitSelectors: readonly string[];

  readonly composerSelectors: readonly string[];
  readonly composerWaitMs: number;
  readonly confirmMs: number;

  /** Null when the inbox container itself was not found — a stale selector. */
  readInbox(page: Page): Promise<InboxReading | null>;

  /**
   * The transcript, as markup the matching parser understands. Business Suite
   * annotates it on the way out, because one fact it carries — direction — is a
   * computed style that no serialisation of the live markup contains.
   */
  readTranscriptHtml(page: Page): Promise<string | null>;

  /**
   * The same container, read plainly and cheaply.
   *
   * Used to tell whether the page has stopped rewriting itself, which needs
   * nothing but "is this markup the same as a second ago". Kept separate from
   * `readTranscriptHtml` because that one measures a computed style for every
   * message on screen, and doing that once a second while waiting is both
   * wasteful and where a live run once wedged past the protocol timeout.
   */
  readSurfaceHtml(page: Page): Promise<string | null>;

  parseTranscript(html: string, opts: ParseOptions): ParsedTranscript;
  parseThread(html: string, opts: ParseOptions): ParsedThread;

  /** How many of our own messages say exactly this — the proof a send landed. */
  countOwn(html: string, opts: { text: string; selfName?: string | null }): number;
}
