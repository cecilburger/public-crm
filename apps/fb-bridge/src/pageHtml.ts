import type { Page } from 'puppeteer';
import {
  BIZ_COMPOSER, BIZ_CONVERSATION_ID_RE, BIZ_INBOX, BIZ_MESSENGER_THREAD_TYPE, BIZ_THREAD,
  BIZ_THREAD_TYPE_RE, COMMENT_ACTIONS, COMMENTS, DIRECTION_ATTR, POST_ID_RE,
} from './selectors.ts';
import { links, normaliseWhitespace, parseHtml, type El } from './parsers/dom.ts';
import { parseBusinessSuiteHeaderName } from './parsers/businessSuiteThread.ts';

/**
 * The in-page half of every scraper in this service.
 *
 * Its whole job is to hand one container's markup back to Node. No finding, no
 * filtering, no interpretation — all of that lives in `parsers/`, where it can
 * be tested against a fixture with no browser and no Facebook account.
 *
 * Both functions are sent as raw strings rather than function references on
 * purpose: `tsx`'s dev transform wraps named local functions in a `__name`
 * helper that exists only in this Node process, while `page.evaluate`
 * serialises a function argument with `.toString()` to run in the page's own
 * context where that helper was never defined. `apps/ig-bridge` confirmed live
 * that this breaks message detection outright.
 */
export async function readContainerHtml(page: Page, selectors: readonly string[]): Promise<string | null> {
  return await page.evaluate(`
    (function () {
      var selectors = ${JSON.stringify(selectors)};
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el) return el.outerHTML;
      }
      return null;
    })();
  `).catch(() => null) as string | null;
}

/**
 * Chooses the one rendered surface that proves it owns a requested Page post.
 *
 * A permalink can contain a modal for another Facebook operation as well as
 * the Page feed behind its post modal. Taking the first `role=dialog` (or
 * falling back to the first feed) makes a sweep ingest comments from a
 * different post while claiming they belong to this one. Post identity is
 * therefore the gate, not selector order: a candidate has to carry a link
 * whose Facebook post id is exactly the id we navigated to.
 *
 * This pure half exists for the fixture regression. The browser equivalent
 * below follows the same bounded rule without serialising the whole document
 * across CDP on every sweep.
 */
export function selectPostSurfaceHtml(html: string, postId: string): string | null {
  const root = parseHtml(html);
  for (const selector of COMMENTS.postSurface) {
    let surfaces: El[] = [];
    try {
      surfaces = root.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const surface of surfaces) {
      const post = targetPostWithin(surface, postId);
      if (post) return post.outerHTML;
      if (surfaceOwnsPost(surface, postId)) return surface.outerHTML;
    }
  }
  return null;
}

/**
 * Reads the actual post surface from a live permalink page.
 *
 * This intentionally returns null when Facebook has not rendered proof that
 * the candidate owns `postId`. A missed comment is observable and retried;
 * ingesting a comment from the feed behind the modal is silent data
 * corruption.
 */
export async function readPostSurfaceHtml(page: Page, postId: string): Promise<string | null> {
  return await page.evaluate(buildReadPostSurfaceScript(postId)).catch(() => null) as string | null;
}

/** Source run in Facebook's page context. Exported so the in-page rule stays
 * inspectable without running a browser in the test suite. */
export function buildReadPostSurfaceScript(postId: string): string {
  return `
    (function () {
      var postId = ${JSON.stringify(postId)};
      var selectors = ${JSON.stringify(COMMENTS.postSurface)};

      function ownsPost(el) {
        var anchors = el.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length; i++) {
          var href = anchors[i].getAttribute('href');
          if (!href) continue;
          try {
            var url = new URL(href, window.location.origin);
            if (url.searchParams.has('comment_id') || url.searchParams.has('comment_fbid')) continue;
            if (url.searchParams.get('story_fbid') === postId) return true;
            var path = /\\/(?:posts|videos)\\/([^/?#]+)/.exec(url.pathname);
            if (path && path[1] === postId) return true;
          } catch (_) {
            // One malformed href is not evidence that this surface is ours.
          }
        }
        return false;
      }

      function targetPostWithin(surface) {
        var articles = surface.querySelectorAll('div[role="article"], div[data-pagelet^="FeedUnit"]');
        for (var i = 0; i < articles.length; i++) {
          var label = articles[i].getAttribute('aria-label') || '';
          if (/omment|omentar/i.test(label)) continue;
          if (ownsPost(articles[i])) return articles[i];
        }
        return null;
      }

      for (var i = 0; i < selectors.length; i++) {
        var surfaces = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < surfaces.length; j++) {
          var post = targetPostWithin(surfaces[j]);
          if (post) return post.outerHTML;
          if (ownsPost(surfaces[j])) return surfaces[j].outerHTML;
        }
      }
      return null;
    })();
  `;
}

function targetPostWithin(surface: El, postId: string): El | null {
  for (const post of surface.querySelectorAll('div[role="article"], div[data-pagelet^="FeedUnit"]')) {
    const label = post.getAttribute('aria-label') ?? '';
    if (/omment|omentar/i.test(label)) continue;
    if (surfaceOwnsPost(post, postId)) return post;
  }
  return null;
}

function surfaceOwnsPost(surface: El, postId: string): boolean {
  for (const { href } of links(surface)) {
    if (/[?&](?:comment_id|comment_fbid)=/i.test(href)) continue;
    const found = POST_ID_RE.exec(href)?.slice(1).find((id) => id !== undefined);
    if (found === postId) return true;
  }
  return false;
}

/**
 * Selects one conversation row in the Business Suite list, by index.
 *
 * The only in-page ACTION in this module, and it lives here rather than in the
 * transport because it has to be a string for the same `tsx`/`__name` reason
 * as everything else in this file.
 *
 * Why a dispatched `.click()` and not a mouse click: confirmed live, a
 * synthetic mouse click at the row's centre does nothing, because an invisible
 * `a[role="row"]` hover grid ("Move to Done", "Mark as Follow up") overlays
 * the row and takes the event — and worse, those are destructive controls.
 * Calling `.click()` on the row's own `div[role="presentation"]` wrapper
 * reaches React's handler directly and selected the row in ~0.7s.
 *
 * Returns whether a row with that index was found. Whether the selection
 * actually changed is the caller's to confirm by reading the channel-selector
 * links afterwards — this function does not assert on what it cannot see.
 */
export async function selectBusinessSuiteRow(
  page: Page, rowSelector: string, rowIndexRe: RegExp, clickTarget: string, index: number,
): Promise<boolean> {
  return await page.evaluate(`
    (function () {
      var rows = document.querySelectorAll(${JSON.stringify(rowSelector)});
      var re = new RegExp(${JSON.stringify(rowIndexRe.source)});
      for (var i = 0; i < rows.length; i++) {
        var m = re.exec(rows[i].getAttribute('data-surface') || '');
        if (!m || Number(m[1]) !== ${JSON.stringify(index)}) continue;
        var target = rows[i].closest(${JSON.stringify(clickTarget)})
          || rows[i].querySelector(${JSON.stringify(clickTarget)});
        if (!target) return false;
        target.click();
        return true;
      }
      return false;
    })();
  `).catch(() => false) as boolean;
}

/**
 * Finds one comment on a post, by Facebook's own id for it.
 *
 * Two renderings, one function, because Facebook does not agree with itself.
 * On the Page timeline each comment sits in a `div[data-commentid]` wrapper;
 * on the post permalink that attribute does not exist AT ALL — confirmed live,
 * which is why a first version found nothing there and reported every comment
 * as deleted. What both renderings do carry is the comment's own permalink,
 * `…comment_id=<id>`, so the anchor is the handle and its enclosing
 * `div[role="article"]` is the comment.
 *
 * Returned as a selector-free in-page lookup rather than a CSS string because
 * the second path needs `closest`, which a selector cannot express.
 */
const FIND_COMMENT = (commentId: string) => `
  (function () {
    var id = ${JSON.stringify(commentId)};
    var wrapper = document.querySelector('div[data-commentid="' + id + '"]');
    if (wrapper) {
      var inner = wrapper.querySelector('div[role="article"]');
      return inner || wrapper;
    }
    // A comment's own permalink can carry the id in either of two forms — see
    // COMMENT_ID_B64_RE's own comment for why. Matched here too: a comment
    // whose only in-page identification is the base64 form (no legacy numeric
    // self-link anywhere on the page) was previously unfindable by this
    // function even though the SAME id decoded correctly for the parser that
    // built the list this id came from.
    function decodeB64CommentId(encoded) {
      try {
        var plain = decodeURIComponent(atob(decodeURIComponent(encoded)));
        var m = /^comment:(\\d{6,})_(\\d{6,})$/.exec(plain);
        return m ? m[2] : null;
      } catch (e) { return null; }
    }
    var links = document.querySelectorAll('a[href*="comment_id="], a[href*="comment_fbid="]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var numeric = href.match(/(?:comment_id|comment_fbid)=(\\d{6,})/);
      var found = numeric ? numeric[1] : null;
      if (!found) {
        var encoded = href.match(/(?:comment_id|comment_fbid)=([A-Za-z0-9+/_%.-]{12,})/i);
        if (encoded) found = decodeB64CommentId(encoded[1]);
      }
      if (!found || found !== id) continue;
      var article = links[i].closest('div[role="article"]');
      if (article) return article;
    }
    return null;
  })()`;

/** That comment's markup, for the pure counter that confirms a reply landed. */
export async function readCommentHtml(page: Page, commentId: string): Promise<string | null> {
  return await page.evaluate(`
    (function () {
      var el = ${FIND_COMMENT(commentId)};
      return el ? el.outerHTML : null;
    })();
  `).catch(() => null) as string | null;
}

/**
 * Whether a comment offers one of its own controls — "Reply", "Send message".
 *
 * Matched by visible text because, confirmed live, these buttons carry no
 * aria-label at all. Buttons belonging to a NESTED article are skipped: once
 * the Page has replied, that reply is an article inside the comment with its
 * own Reply button, and acting on it would answer ourselves.
 */
export async function hasCommentControl(
  page: Page, commentId: string, textRe: RegExp,
): Promise<boolean> {
  return await page.evaluate(`
    (function () {
      var article = ${FIND_COMMENT(commentId)};
      if (!article) return false;
      var re = new RegExp(${JSON.stringify(textRe.source)}, ${JSON.stringify(textRe.flags)});
      var buttons = article.querySelectorAll('[role="button"]');
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].closest('div[role="article"]') !== article) continue;
        if (re.test((buttons[i].innerText || '').trim())) return true;
      }
      return false;
    })();
  `).catch(() => false) as boolean;
}

/**
 * Clicks that control, WITHOUT waiting for the click to report back.
 *
 * Deliberately fire-and-forget. Confirmed live by a per-step trace: clicking
 * "Send message" tears down the page's execution context as Facebook opens its
 * dialog, so the `evaluate` that performed the click never resolves — it hung
 * until the protocol timeout and surfaced two minutes later as an opaque
 * `Runtime.callFunctionOn timed out`, three steps away from the real cause.
 *
 * The click's return value was never the evidence anyway. The caller proves
 * the click landed by waiting for what it was supposed to open, which is both
 * what a person would look at and the only thing that survives the teardown.
 */
export function fireCommentControl(page: Page, commentId: string, textRe: RegExp): void {
  void page.evaluate(`
    (function () {
      var article = ${FIND_COMMENT(commentId)};
      if (!article) return false;
      var re = new RegExp(${JSON.stringify(textRe.source)}, ${JSON.stringify(textRe.flags)});
      var buttons = article.querySelectorAll('[role="button"]');
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].closest('div[role="article"]') !== article) continue;
        if (re.test((buttons[i].innerText || '').trim())) { buttons[i].click(); return true; }
      }
      return false;
    })();
  `).catch(() => {});
}

/**
 * The same, plus the one fact about a Business Suite message that markup alone
 * cannot carry: which way it went.
 *
 * Business Suite states direction purely as layout. The wrapper above an
 * inbound bubble computes `justify-content: flex-start`, an outbound one
 * `flex-end` — a computed style, resolved from a stylesheet, and therefore
 * absent from `outerHTML` no matter how much of it is serialised. So this
 * measures it here, where a browser exists, and stamps the answer onto the
 * clone. The parser then reads an ordinary attribute and stays pure.
 *
 * WHY NOT THE CLASS NAME. The two wrappers differ by exactly one atomic class
 * (`x1nhvcw1` inbound, `x13a6bvl` outbound, at the time of writing). Those
 * hashes are regenerated by Facebook's own build, and keying on one would fail
 * silently and catastrophically when it rotates: every agent reply would be
 * filed as something the customer said, then shown back to the next agent as an
 * unanswered enquiry.
 *
 * THE LIVE DOM IS NOT TOUCHED. Everything is stamped on a deep clone, which is
 * also why the two node lists line up by index — `cloneNode(true)` preserves
 * document order exactly, so the nth message in the clone is the nth message in
 * the page.
 *
 * A bubble whose ancestors report neither value is left unstamped, and the
 * parser drops and counts it. That is the safe direction: a dropped message is
 * visible in `unknownSenderRows`, a misattributed one is visible nowhere.
 */
export async function readAnnotatedContainerHtml(
  page: Page, selectors: readonly string[], messageSelector: string,
): Promise<string | null> {
  return await page.evaluate(buildAnnotatorScript(selectors, messageSelector))
    .catch(() => null) as string | null;
}

/**
 * The measurement itself: which computed `justify-content` means which
 * direction.
 *
 * Kept as data rather than written into the script as two `if`s so a test can
 * assert both the mapping and the fact that the script really embeds this
 * table. The in-page half cannot import anything, so this is the only way the
 * rule is stated once instead of twice — and two copies of a rule like this one
 * drifting apart is exactly how an agent's reply ends up filed as the
 * customer's.
 *
 * Read off the live site: an inbound bubble's nearest laid-out ancestor
 * computes `flex-start`, an outbound one `flex-end`.
 */
export const JUSTIFY_DIRECTION = {
  'flex-start': 'inbound',
  'flex-end': 'outbound',
} as const;

/**
 * The in-page program, as source. Exported so it can be inspected in a test
 * without a browser: there is no other way to prove that what actually runs on
 * the page carries the mapping above.
 */
export function buildAnnotatorScript(selectors: readonly string[], messageSelector: string): string {
  return `
    (function () {
      var selectors = ${JSON.stringify(selectors)};
      var directions = ${JSON.stringify(JUSTIFY_DIRECTION)};
      var container = null;
      for (var i = 0; i < selectors.length; i++) {
        container = document.querySelector(selectors[i]);
        if (container) break;
      }
      if (!container) return null;

      var clone = container.cloneNode(true);
      var live = container.querySelectorAll(${JSON.stringify(messageSelector)});
      var copies = clone.querySelectorAll(${JSON.stringify(messageSelector)});

      for (var j = 0; j < live.length && j < copies.length; j++) {
        var direction = null;
        for (var node = live[j]; node && node !== document.body; node = node.parentElement) {
          var justify = window.getComputedStyle(node).justifyContent;
          if (directions[justify]) { direction = directions[justify]; break; }
        }
        if (direction) copies[j].setAttribute(${JSON.stringify(DIRECTION_ATTR)}, direction);
      }

      return clone.outerHTML;
    })();
  `;
}

/**
 * Whether this page currently shows a usable private-message composer.
 *
 * The one piece of evidence that matters after clicking "Send message". Not
 * that the old page survived, not that a dialog exists somewhere, not that a
 * target appeared — a composer we can actually type into, on a page we can
 * actually reach. Everything else about Facebook's lifecycle is allowed to
 * change underneath.
 *
 * Returns false rather than throwing for a page whose context is already gone,
 * because that is the ordinary case here: the caller is asking exactly because
 * it does not know which page survived.
 */
export async function hasPrivateComposer(page: Page, selectors: readonly string[]): Promise<boolean> {
  return await page.evaluate(`
    (function () {
      var selectors = ${JSON.stringify(selectors)};
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (!el) continue;
        var box = el.getBoundingClientRect();
        // Rendered and reachable, not a detached or zero-sized leftover.
        if (box.width > 0 && box.height > 0) return true;
      }
      return false;
    })();
  `).catch(() => false) as boolean;
}

/** The commenter a private-reply surface must prove it belongs to. */
export interface PrivateMessageSurfaceExpected {
  contactId: string;
  contactName: string;
}

/** One named Facebook dialog, with only controls inside that dialog counted. */
export interface PrivateMessageDialogEvidence {
  label: string;
  editor: boolean;
  sendControl: boolean;
}

/** A single, atomic DOM reading taken immediately before text can be entered. */
export interface PrivateMessageSurfaceEvidence {
  dialogs: readonly PrivateMessageDialogEvidence[];
  businessSuite: {
    detailView: boolean;
    editor: boolean;
    selectedThreadId: string | null;
    selectedThreadType: string | null;
    headerHtml: string | null;
  };
}

export type PrivateMessageSurface = 'dialog' | 'business_suite';

/**
 * Decides whether DOM evidence positively identifies a private Messenger
 * surface for this exact commenter.
 *
 * This is deliberately a validator rather than a heuristic. A post permalink
 * is also a modal and contains a public Lexical reply composer, so neither a
 * dialog nor a textbox alone proves private messaging. The only accepted
 * shapes are a named message dialog with its own explicit send control, or the
 * Page's selected FB_MESSAGE Business Suite thread with the same contact id
 * and header. Everything else is a no.
 */
export function validatePrivateMessageSurface(
  evidence: PrivateMessageSurfaceEvidence, expected: PrivateMessageSurfaceExpected,
): PrivateMessageSurface | null {
  const contactName = normaliseWhitespace(expected.contactName).toLocaleLowerCase();
  if (!expected.contactId || !contactName) return null;

  for (const dialog of evidence.dialogs) {
    if (!dialogIsForContact(dialog.label, contactName)) continue;
    if (dialog.editor && dialog.sendControl) return 'dialog';
  }

  const suite = evidence.businessSuite;
  const headerName = suite.headerHtml ? parseBusinessSuiteHeaderName(suite.headerHtml) : '';
  if (
    suite.detailView
    && suite.editor
    && suite.selectedThreadId === expected.contactId
    && suite.selectedThreadType === BIZ_MESSENGER_THREAD_TYPE
    && normaliseWhitespace(headerName).toLocaleLowerCase() === contactName
  ) return 'business_suite';

  return null;
}

/**
 * Asserts the only precondition that permits private-message text to be typed.
 *
 * Kept as one in-page observation so the dialog, composer, send control and
 * selected Business Suite thread describe one DOM instant. An execution-context
 * failure becomes null: uncertain is unsafe, so callers do not type.
 */
export async function assertPrivateMessageSurface(
  page: Page, expected: PrivateMessageSurfaceExpected,
): Promise<PrivateMessageSurface | null> {
  const evidence = await page.evaluate(buildPrivateMessageSurfaceEvidenceScript())
    .catch(() => null) as PrivateMessageSurfaceEvidence | null;
  return evidence ? validatePrivateMessageSurface(evidence, expected) : null;
}

/** True only when the Business Suite detail pane still names the exact
 * FB_MESSAGE conversation the CRM asked to send to. */
export function validateBusinessSuiteThreadSurface(
  evidence: PrivateMessageSurfaceEvidence, threadId: string,
): boolean {
  const suite = evidence.businessSuite;
  return Boolean(threadId)
    && suite.detailView
    && suite.editor
    && suite.selectedThreadId === threadId
    && suite.selectedThreadType === BIZ_MESSENGER_THREAD_TYPE;
}

/**
 * Destination evidence for normal CRM → Messenger sends.
 *
 * Business Suite can silently drop `selected_item_id` while it hydrates. A
 * composer and even a stable transcript are not enough: without this exact id
 * check, Enter can send to whichever conversation Facebook selected instead.
 */
export async function assertBusinessSuiteThreadSurface(page: Page, threadId: string): Promise<boolean> {
  const evidence = await page.evaluate(buildPrivateMessageSurfaceEvidenceScript())
    .catch(() => null) as PrivateMessageSurfaceEvidence | null;
  return evidence ? validateBusinessSuiteThreadSurface(evidence, threadId) : false;
}

/** The private-reply dialog's composer and send control, as seen inside the dialog. */
const PRIVATE_MESSAGE_EDITOR = 'div[role="textbox"][data-lexical-editor="true"]';
const PRIVATE_SEND_CONTROLS = [
  '[role="button"][aria-label="Send Message"]',
  '[role="button"][aria-label="Send message"]',
  '[role="button"][aria-label="Kirim Pesan"]',
  '[role="button"][aria-label="Kirim pesan"]',
] as const;

/**
 * The private-message dialogs in a piece of markup — the same reading the
 * in-page evidence script takes, over HTML instead of a live document, so the
 * selectors are held to Facebook's real markup by a fixture. (Visibility is a
 * layout fact HTML does not carry; the in-page script checks it.)
 */
export function privateMessageDialogsFromHtml(html: string): PrivateMessageDialogEvidence[] {
  const root = parseHtml(html);
  const found: El[] = [];
  for (const selector of COMMENT_ACTIONS.messageDialog) {
    for (const node of root.querySelectorAll(selector)) if (!found.includes(node)) found.push(node);
  }
  return found.map((dialog) => ({
    label: dialog.getAttribute('aria-label') ?? '',
    editor: dialog.querySelector(PRIVATE_MESSAGE_EDITOR) !== null,
    sendControl: PRIVATE_SEND_CONTROLS.some((selector) => dialog.querySelector(selector) !== null),
  }));
}

/**
 * The private-reply dialog's "Send Message": enabled, still disabled, or not
 * rendered. Facebook marks it `aria-disabled="true"` until the typed text has
 * registered; a click before that is silently ignored.
 */
export async function readPrivateSendState(page: Page): Promise<'enabled' | 'disabled' | 'missing' | null> {
  return await page.evaluate(`
    (function () {
      var selectors = ${JSON.stringify(COMMENT_ACTIONS.messageSendButton)};
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (!el) continue;
        var box = el.getBoundingClientRect();
        if (!box || box.width <= 0 || box.height <= 0) continue;
        return el.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled';
      }
      return 'missing';
    })();
  `).catch(() => null) as 'enabled' | 'disabled' | 'missing' | null;
}

/** The raw page program used by {@link assertPrivateMessageSurface}. */
export function buildPrivateMessageSurfaceEvidenceScript(): string {
  return `
    (function () {
      var messageDialogs = ${JSON.stringify(COMMENT_ACTIONS.messageDialog)};
      var messageEditor = ${JSON.stringify(PRIVATE_MESSAGE_EDITOR)};
      var messageSendControls = ${JSON.stringify(PRIVATE_SEND_CONTROLS)};
      var detailSelectors = ${JSON.stringify(BIZ_THREAD.detailView)};
      var businessEditors = ${JSON.stringify(BIZ_COMPOSER.box)};
      var selectedContainers = ${JSON.stringify(BIZ_INBOX.selectedLinkContainer)};
      var headerSelectors = ${JSON.stringify(BIZ_THREAD.header)};

      function first(selectors, root) {
        root = root || document;
        for (var i = 0; i < selectors.length; i++) {
          var found = root.querySelector(selectors[i]);
          if (found) return found;
        }
        return null;
      }
      function visible(el) {
        if (!el) return false;
        var box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }
      // Business Suite's own \`data-surface\` instrumentation wraps sections in a
      // marker span styled \`display: contents\` — laid out as if the wrapper
      // were not there at all, so it never has a box of its own. \`visible()\`
      // reports one of these as invisible even while its content fills the
      // screen. Confirmed live: the detail pane's wrapper matched, its composer
      // was a visible descendant, and the wrapper's own rect was still 0x0.
      function surfacePresent(el) {
        if (!el) return false;
        if (window.getComputedStyle(el).display === 'contents') return true;
        return visible(el);
      }
      function visibleDescendant(root, selectors) {
        for (var i = 0; i < selectors.length; i++) {
          var nodes = root.querySelectorAll(selectors[i]);
          for (var j = 0; j < nodes.length; j++) if (visible(nodes[j])) return true;
        }
        return false;
      }
      function selectedConversation() {
        var container = first(selectedContainers);
        if (!container) return { id: null, type: null };
        var anchors = container.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length; i++) {
          var href = anchors[i].getAttribute('href') || '';
          try {
            var url = new URL(href, window.location.origin);
            var id = url.searchParams.get('selected_item_id');
            var type = url.searchParams.get('thread_type');
            if (id && type === ${JSON.stringify(BIZ_MESSENGER_THREAD_TYPE)}) return { id: id, type: type };
          } catch (_) {
            // A malformed link cannot establish a private destination.
          }
        }
        return { id: null, type: null };
      }

      var dialogs = [];
      var seen = [];
      for (var i = 0; i < messageDialogs.length; i++) {
        var nodes = document.querySelectorAll(messageDialogs[i]);
        for (var j = 0; j < nodes.length; j++) {
          if (!visible(nodes[j]) || seen.indexOf(nodes[j]) !== -1) continue;
          seen.push(nodes[j]);
          dialogs.push({
            label: nodes[j].getAttribute('aria-label') || '',
            editor: visibleDescendant(nodes[j], [messageEditor]),
            sendControl: visibleDescendant(nodes[j], messageSendControls)
          });
        }
      }

      var detail = first(detailSelectors);
      var selected = selectedConversation();
      var header = first(headerSelectors);
      return {
        dialogs: dialogs,
        businessSuite: {
          detailView: surfacePresent(detail),
          editor: detail ? visibleDescendant(detail, businessEditors) : false,
          selectedThreadId: selected.id,
          selectedThreadType: selected.type,
          headerHtml: header ? header.outerHTML : null
        }
      };
    })();
  `;
}

function dialogIsForContact(label: string, contactName: string): boolean {
  const normalised = normaliseWhitespace(label).toLocaleLowerCase();
  return normalised === `message ${contactName}` || normalised === `kirim pesan ${contactName}`;
}

/**
 * Puts the caret in a composer without going through an ElementHandle.
 *
 * Confirmed live, and the reason this exists: on the post page that Facebook's
 * private-reply dialog opens over, `page.evaluate` keeps answering
 * indefinitely while `page.click` — which has to take a handle on the element
 * and scroll it into view in puppeteer's isolated world — never returns at
 * all. Same page, same moment, same selector. So the composer is focused by
 * the half that still works, and the text then arrives through CDP's
 * `Input.insertText`, which types into whatever has focus and needs no handle.
 *
 * `click()` as well as `focus()` because a Lexical editor mounts its selection
 * on the pointer event, and focus alone can leave the caret nowhere.
 */
export async function focusComposer(page: Page, selectors: readonly string[]): Promise<boolean> {
  return await page.evaluate(`
    (function () {
      var selectors = ${JSON.stringify(selectors)};
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (!el) continue;
        var box = el.getBoundingClientRect();
        if (!box || box.width <= 0 || box.height <= 0) continue;
        el.scrollIntoView({ block: 'center' });
        el.click();
        el.focus();
        return document.activeElement === el || el.contains(document.activeElement);
      }
      return false;
    })();
  `).catch(() => false) as boolean;
}

/**
 * Clicks a control and does not wait to hear how it went.
 *
 * The same fire-and-forget as `fireCommentControl`, for the same reason: a
 * send button tears down the surface it sits on, so the `evaluate` that
 * clicked it may never resolve. What was sent is confirmed by reading the
 * conversation, never by this call returning.
 */
export function fireClick(page: Page, selectors: readonly string[]): void {
  void page.evaluate(`
    (function () {
      var selectors = ${JSON.stringify(selectors)};
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (!el) continue;
        var box = el.getBoundingClientRect();
        if (!box || box.width <= 0 || box.height <= 0) continue;
        el.click();
        return true;
      }
      return false;
    })();
  `).catch(() => {});
}

/**
 * What is actually in a composer right now.
 *
 * Reading back what was typed is the only way to tell "Facebook ignored the
 * text" from "Facebook ignored the send": both end with nothing delivered and
 * no error anywhere. Used for tracing, never as proof of delivery — text
 * sitting in a box has not been sent to anyone.
 */
export async function readComposerText(page: Page, selectors: readonly string[]): Promise<string | null> {
  return await page.evaluate(`
    (function () {
      var selectors = ${JSON.stringify(selectors)};
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el) return (el.innerText || el.textContent || '').trim();
      }
      return null;
    })();
  `).catch(() => null) as string | null;
}

/**
 * The visible buttons on a page, by the label a screen reader would read.
 *
 * Tracing only, and only when asked for: it is how a surface Facebook has
 * moved gets re-learned from the running site instead of guessed at, which is
 * how every selector in this service has had to be found.
 */
export async function listButtonLabels(page: Page): Promise<string[]> {
  return await page.evaluate(`
    (function () {
      var out = [];
      var nodes = document.querySelectorAll('[role="button"][aria-label], button[aria-label]');
      for (var i = 0; i < nodes.length && out.length < 40; i++) {
        var box = nodes[i].getBoundingClientRect();
        if (!box || box.width <= 0 || box.height <= 0) continue;
        var label = (nodes[i].getAttribute('aria-label') || '').trim();
        if (label && out.indexOf(label) === -1) out.push(label);
      }
      return out;
    })();
  `).catch(() => []) as string[];
}
