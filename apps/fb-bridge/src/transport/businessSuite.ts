import type { Page } from 'puppeteer';
import { trace } from '../debug.ts';
import {
  BIZ_COMPOSER, BIZ_CONVERSATION_ID_RE, BIZ_INBOX, BIZ_MESSENGER_THREAD_TYPE, BIZ_THREAD,
  BIZ_THREAD_TYPE_RE, BIZ_URLS,
} from '../selectors.ts';
import { readAnnotatedContainerHtml, readContainerHtml, selectBusinessSuiteRow } from '../pageHtml.ts';
import { links, parseHtml } from '../parsers/dom.ts';
import { parseBusinessSuiteThreadList } from '../parsers/businessSuiteInbox.ts';
import {
  countOwnBusinessSuiteMessages, parseBusinessSuiteHeaderName, parseBusinessSuiteThread,
  parseBusinessSuiteTranscript,
} from '../parsers/businessSuiteThread.ts';
import type { InboxReading, ParseOptions, ThreadTransport, TransportContext } from './types.ts';

/**
 * business.facebook.com/latest/inbox — a Page's own inbox.
 *
 * Three things differ from messenger.com deeply enough that they are the whole
 * reason this file exists rather than a flag on the other one:
 *
 *  - URLs need an `asset_id`, which is a different number from the Page id.
 *  - Direction is stated only as layout, so the transcript has to be measured
 *    on the way out of the page (see `readAnnotatedContainerHtml`).
 *  - Conversation rows carry no id. Each is selected in turn and its id read
 *    off the channel-selector links — click-to-reveal, with a per-asset cache
 *    so a stable inbox costs no clicks at all.
 *  - The same inbox lists the Page's Instagram conversations. Only
 *    `thread_type=FB_MESSAGE` rows are admitted; Instagram is another bridge's.
 */
export const businessSuiteTransport: ThreadTransport = {
  kind: 'business_suite',

  /**
   * True — by click-to-reveal, the same dance `apps/ig-bridge` does.
   *
   * Business Suite's rows carry no href and no id. The id of the SELECTED
   * conversation is stated in the channel-selector tab links, so `readInbox`
   * selects each row it does not yet know and reads the id off those links.
   * Confirmed live: the links update ~0.7s after the row's wrapper is clicked.
   */
  discoversConversations: true,

  inboxUrl: (ctx: TransportContext) => BIZ_URLS.inbox(requireAssetId(ctx)),
  /**
   * Prefers the exact href Business Suite itself offered for this conversation
   * when the row was revealed, and falls back to a rebuilt Messenger URL for a
   * thread known only from a previous run's anchors. The rebuilt form assumes
   * `thread_type=FB_MESSAGE`, which is the only kind this transport admits —
   * see `revealConversationId`.
   */
  threadUrl: (ctx: TransportContext, threadId: string) => {
    const assetId = requireAssetId(ctx);
    const known = HREF_CACHES.get(assetId)?.get(threadId);
    return known ? `https://business.facebook.com${known}` : BIZ_URLS.thread(assetId, threadId);
  },

  // Business Suite renders the whole inbox as one app; the transcript region
  // appearing is the signal that a conversation is actually on screen.
  inboxWaitSelectors: BIZ_THREAD.messageList,
  threadWaitSelectors: BIZ_THREAD.row,

  composerSelectors: BIZ_COMPOSER.box,
  composerWaitMs: BIZ_COMPOSER.waitMs,
  confirmMs: BIZ_COMPOSER.confirmMs,

  /**
   * Every conversation in the list, each with its id.
   *
   * The list itself says only who and when; the id has to be revealed by
   * selecting the row and reading the channel-selector links. That click is
   * spent only on rows whose id is not already known: a title→id cache, kept
   * per asset for the life of the process, means a stable inbox costs zero
   * clicks per sweep and a new conversation costs exactly one.
   *
   * The cache is trusted ONLY for a title that is unique in this reading. Two
   * customers named "Andi" are two rows with one title, and a cached id would
   * hand one of them the other's conversation — so duplicate titles are
   * revealed by click every time, which is slower and correct.
   *
   * Selecting a row is a visible change to the operator's inbox and marks the
   * conversation read on Facebook's side. That is accepted: it is the Page's
   * own inbox, the read receipt is the Page's, and the alternative is an inbox
   * the CRM cannot see into.
   */
  async readInbox(page: Page): Promise<InboxReading | null> {
    const listHtml = await readContainerHtml(page, BIZ_INBOX.list);
    if (!listHtml) return null;

    const { rows, rowCount } = parseBusinessSuiteThreadList(listHtml);
    const cache = idCacheFor(page.url());
    const titleCounts = new Map<string, number>();
    for (const row of rows) titleCounts.set(row.title, (titleCounts.get(row.title) ?? 0) + 1);

    const out: InboxReading['rows'] = [];
    for (const row of rows) {
      const unique = row.title !== '' && titleCounts.get(row.title) === 1;
      let threadId = unique ? cache.get(row.title) ?? null : null;
      if (!threadId) {
        threadId = await revealConversationId(page, row.index, row.title);
        if (threadId && unique) cache.set(row.title, threadId);
      }
      // A row whose id could not be revealed is skipped, not guessed. It is
      // logged by count upstream ("rendered N, read M"), and the next sweep
      // tries again.
      if (threadId) out.push({ threadId, name: row.title, signature: row.signature });
    }

    return { rows: out, rowCount };
  },

  async readTranscriptHtml(page: Page): Promise<string | null> {
    // The annotating read, not the plain one. Everything downstream depends on
    // `data-kirana-direction` being present, and the plain read cannot produce
    // it — the fact it carries is a computed style, not markup.
    return await readAnnotatedContainerHtml(page, BIZ_THREAD.messageList, BIZ_THREAD.row[0]!);
  },

  readSurfaceHtml: (page: Page) => readContainerHtml(page, BIZ_THREAD.messageList),

  parseTranscript: (html: string, opts: ParseOptions) =>
    parseBusinessSuiteTranscript(html, {
      contactName: opts.contactName ?? null, selfName: opts.selfName ?? null,
    }),

  parseThread: (html: string, opts: ParseOptions) =>
    parseBusinessSuiteThread(html, {
      contactName: opts.contactName ?? null, selfName: opts.selfName ?? null,
    }),

  // No `selfName` here, unlike messenger.com: "ours" is whatever the layout
  // said was ours, which is a stronger claim than a display name matching.
  countOwn: (html: string, opts: { text: string }) =>
    countOwnBusinessSuiteMessages(html, { text: opts.text }),
};

/**
 * The id of whichever conversation is currently selected, or null.
 *
 * Read off the channel-selector tab links, which are the only place Business
 * Suite states it — the address bar never carries `selected_item_id`, which is
 * exactly the assumption a first version of this transport got wrong.
 */
interface SelectedConversation {
  id: string;
  threadType: string | null;
  /** The link's own href, path and query, exactly as Business Suite wrote it. */
  href: string;
}

async function readSelectedConversation(page: Page): Promise<SelectedConversation | null> {
  const html = await readContainerHtml(page, BIZ_INBOX.selectedLinkContainer);
  if (!html) return null;
  const root = parseHtml(html);
  const candidates = links(root).filter((l) => BIZ_CONVERSATION_ID_RE.test(l.href));
  // The Messenger tab first: every tab carries an id, but only its own
  // platform's. The Instagram tab's id belongs to an Instagram conversation
  // and taking it would hand this transport a thread it must never read.
  const link = candidates.find((l) => BIZ_INBOX.selectedLinkPreferredRe.test(l.href))
    ?? candidates.find((l) => BIZ_THREAD_TYPE_RE.exec(l.href)?.[1] === BIZ_MESSENGER_THREAD_TYPE);
  if (!link) return null;
  return {
    id: BIZ_CONVERSATION_ID_RE.exec(link.href)![1]!,
    threadType: BIZ_THREAD_TYPE_RE.exec(link.href)?.[1] ?? null,
    href: link.href,
  };
}

/**
 * Selects a row and waits for Business Suite to say which conversation it is.
 *
 * "Says" means the channel-selector links now carry a different id than before
 * the click — or, when the clicked row was already the selection, the detail
 * header now names this row's contact. Both are checked because the first
 * alone cannot tell "already selected" from "click did nothing", and the
 * second alone cannot tell two contacts with the same name apart.
 *
 * Null when nothing changed within the budget. That is a row the caller skips
 * this pass, not an error: a slow tab is not a broken inbox.
 */
async function revealConversationId(page: Page, index: number, title: string): Promise<string | null> {
  const before = await readSelectedConversation(page);
  const clicked = await selectBusinessSuiteRow(
    page, BIZ_INBOX.row[0], BIZ_INBOX.rowIndexRe, BIZ_INBOX.rowClickTarget, index,
  );
  if (!clicked) {
    trace('reveal', `row ${index} ("${title}") has no clickable wrapper`);
    return null;
  }

  const deadline = Date.now() + BIZ_INBOX.revealMs;
  let last = 'nothing selected';
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = await readSelectedConversation(page);
    if (!now) continue;
    let settled = now.id !== before?.id;
    let shown = '';
    if (!settled && title) {
      const headerHtml = await readContainerHtml(page, BIZ_THREAD.header);
      shown = headerHtml ? parseBusinessSuiteHeaderName(headerHtml) : '';
      settled = Boolean(shown) && shown === title;
    }
    last = `id=${now.id} type=${now.threadType} header=${JSON.stringify(shown)}`;
    if (!settled) continue;

    // NOT OURS. Business Suite can list the Page's Instagram conversations in
    // the same inbox (`thread_type=IG_MESSAGE`), and one was read into the CRM
    // as a Facebook DM before this check existed. Instagram belongs to another
    // bridge; a row of any other type is skipped and never cached, so it can
    // never be reconciled or replied to from here either.
    if (now.threadType !== BIZ_MESSENGER_THREAD_TYPE) {
      trace('reveal', `row ${index} ("${title}") is ${now.threadType}, not Messenger — skipped`);
      return null;
    }

    hrefCacheFor(page.url()).set(now.id, now.href);
    return now.id;
  }
  trace('reveal', `row ${index} ("${title}") never settled; last seen ${last}`);
  return null;
}

/** conversation id → the exact href Business Suite offered for it, per asset. */
const HREF_CACHES = new Map<string, Map<string, string>>();

function hrefCacheFor(pageUrl: string): Map<string, string> {
  const asset = /[?&]asset_id=(\d+)/.exec(pageUrl)?.[1] ?? 'unknown';
  const existing = HREF_CACHES.get(asset);
  if (existing) return existing;
  const fresh = new Map<string, string>();
  HREF_CACHES.set(asset, fresh);
  return fresh;
}

/** title → conversation id, per asset, for the life of the process. */
const ID_CACHES = new Map<string, Map<string, string>>();

function idCacheFor(pageUrl: string): Map<string, string> {
  const asset = /[?&]asset_id=(\d+)/.exec(pageUrl)?.[1] ?? 'unknown';
  const existing = ID_CACHES.get(asset);
  if (existing) return existing;
  const fresh = new Map<string, string>();
  ID_CACHES.set(asset, fresh);
  return fresh;
}

/**
 * Every Business Suite URL needs the asset id, and there is no default worth
 * guessing. Failing loudly turns a misconfigured connection into one clear
 * error at the first navigation, instead of a browser sitting on a generic
 * Business Suite page that quietly contains none of this tenant's messages.
 */
function requireAssetId(ctx: TransportContext): string {
  const assetId = ctx.assetId?.trim();
  if (!assetId) {
    throw new Error('business suite transport needs an asset id — reconnect the Page so it is stored');
  }
  return assetId;
}
