import type { Page } from 'puppeteer';
import { BIZ_COMPOSER, BIZ_CONVERSATION_ID_RE, BIZ_THREAD, BIZ_URLS } from '../selectors.ts';
import { readAnnotatedContainerHtml, readContainerHtml } from '../pageHtml.ts';
import { changeSignature, parseHtml, textOf } from '../parsers/dom.ts';
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
 *  - Conversation rows carry no id. Only the conversation Business Suite has
 *    already selected can be named, which is why `discoversConversations` is
 *    false and why this transport is explicit about being partial.
 */
export const businessSuiteTransport: ThreadTransport = {
  kind: 'business_suite',

  /**
   * FALSE, AND SAYING SO IS THE POINT.
   *
   * Business Suite's thread list renders no href and no id per row — confirmed
   * live; the only `selected_item_id` links on the page are the left-hand nav
   * tabs, which all reflect whichever conversation is currently open. So this
   * transport can reconcile conversations it already knows, and can name the
   * one Business Suite selects on load (the most recently active, which is
   * where a new enquiry lands), but it cannot enumerate an inbox.
   *
   * Enumerating it means clicking each row and reading the URL back — the same
   * dance `apps/ig-bridge` had to do — and the row selector for that has not
   * been probed against the live DOM. Guessing at it would produce a watcher
   * that looks like it works.
   */
  discoversConversations: false,

  inboxUrl: (ctx: TransportContext) => BIZ_URLS.inbox(requireAssetId(ctx)),
  threadUrl: (ctx: TransportContext, threadId: string) => BIZ_URLS.thread(requireAssetId(ctx), threadId),

  // Business Suite renders the whole inbox as one app; the transcript region
  // appearing is the signal that a conversation is actually on screen.
  inboxWaitSelectors: BIZ_THREAD.messageList,
  threadWaitSelectors: BIZ_THREAD.row,

  composerSelectors: BIZ_COMPOSER.box,
  composerWaitMs: BIZ_COMPOSER.waitMs,
  confirmMs: BIZ_COMPOSER.confirmMs,

  /**
   * The one conversation this surface can name: the selected one.
   *
   * Read from the page's own URL rather than from any element, because the URL
   * is the only place Business Suite states a conversation id that is not
   * contingent on a selector. The row's signature comes from the transcript it
   * leads to, which is the same thing the watcher diffs on for messenger.com.
   */
  async readInbox(page: Page): Promise<InboxReading | null> {
    const threadId = BIZ_CONVERSATION_ID_RE.exec(page.url())?.[1];
    if (!threadId) return { rows: [], rowCount: 0 };

    const transcript = await readContainerHtml(page, BIZ_THREAD.messageList);
    // The conversation id is known but nothing rendered for it. Reporting a row
    // with an empty signature would make the watcher believe the thread changed
    // on every pass; reporting no container is the truthful answer, and the
    // watcher already knows how to complain about that.
    if (!transcript) return null;

    const headerHtml = await readContainerHtml(page, BIZ_THREAD.header);
    const name = headerHtml ? parseBusinessSuiteHeaderName(headerHtml) : '';

    return {
      rows: [{ threadId, name, signature: changeSignature(textOf(parseHtml(transcript))) }],
      rowCount: 1,
    };
  },

  async readTranscriptHtml(page: Page): Promise<string | null> {
    // The annotating read, not the plain one. Everything downstream depends on
    // `data-kirana-direction` being present, and the plain read cannot produce
    // it — the fact it carries is a computed style, not markup.
    return await readAnnotatedContainerHtml(page, BIZ_THREAD.messageList, BIZ_THREAD.row[0]!);
  },

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
