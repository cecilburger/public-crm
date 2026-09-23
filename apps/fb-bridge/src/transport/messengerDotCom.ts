import type { Page } from 'puppeteer';
import { COMPOSER, INBOX, THREAD, URLS } from '../selectors.ts';
import { readContainerHtml } from '../pageHtml.ts';
import { parseMessengerInbox } from '../parsers/messengerInbox.ts';
import { countOwnMessages, parseMessengerThread, parseMessengerTranscript } from '../parsers/messengerThread.ts';
import type { InboxReading, ParseOptions, ThreadTransport } from './types.ts';

/**
 * facebook.com/messages/t/ — a personal account's own inbox.
 *
 * This is the surface the bridge was built against, and it is deliberately left
 * exactly as it was. It is still the right transport for a personal account,
 * and the Page work must not be allowed to regress it: every selector, parser
 * and timing here is the result of repairing guesses against the live DOM, and
 * none of that knowledge transfers to Business Suite or back.
 */
export const messengerDotComTransport: ThreadTransport = {
  kind: 'messenger',

  /** Every row carries an href to its own thread — see `INBOX.rowLink`. */
  discoversConversations: true,

  inboxUrl: () => URLS.inbox,
  threadUrl: (_ctx, threadId) => URLS.thread(threadId),

  inboxWaitSelectors: INBOX.list,
  threadWaitSelectors: THREAD.row,

  composerSelectors: COMPOSER.box,
  composerWaitMs: COMPOSER.waitMs,
  confirmMs: COMPOSER.confirmMs,

  async readInbox(page: Page): Promise<InboxReading | null> {
    const html = await readContainerHtml(page, INBOX.list);
    if (!html) return null;
    const { rows, linkCount } = parseMessengerInbox(html);
    return { rows, rowCount: linkCount };
  },

  async readTranscriptHtml(page: Page): Promise<string | null> {
    return await readContainerHtml(page, THREAD.messageList);
  },

  // The contact's name is ignored on purpose: messenger.com names the sender
  // inside every message, and carrying the inbox's idea of the name alongside
  // would be a second source of truth for the same fact — the weaker of the two.
  parseTranscript: (html: string, opts: ParseOptions) =>
    parseMessengerTranscript(html, { selfName: opts.selfName ?? null }),

  parseThread: (html: string, opts: ParseOptions) =>
    parseMessengerThread(html, { selfName: opts.selfName ?? null }),

  countOwn: (html: string, opts: { text: string; selfName?: string | null }) =>
    countOwnMessages(html, { text: opts.text, selfName: opts.selfName ?? null }),
};
