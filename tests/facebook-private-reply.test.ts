import { describe, it, expect } from 'vitest';
import { confirmReplyWithFinalRecheck, resolvePrivateReplySurface, withDeadline } from '../apps/fb-bridge/src/sessionManager.ts';
import {
  fireClick, focusComposer, hasPrivateComposer, validatePrivateMessageSurface,
  validateBusinessSuiteThreadSurface,
} from '../apps/fb-bridge/src/pageHtml.ts';
import { BIZ_COMPOSER, COMMENT_ACTIONS } from '../apps/fb-bridge/src/selectors.ts';
import {
  withTenant, recordFacebookComment, claimCommentForPublicReply, markCommentPublicReplyFailed,
  getFacebookComment,
} from '@kirana/db';
import { freshDb, makeTenant, TEST_KEK } from './helpers/db.ts';

/**
 * Where Facebook put the private-message composer, and nothing else.
 *
 * THE BUG THIS FILE EXISTS FOR. Clicking a comment's "Send message" tears down
 * the clicked page's execution context as Facebook opens its messaging surface.
 * A first version awaited that click's `evaluate`, which therefore never
 * resolved — it hung until the 180s protocol timeout and surfaced as an opaque
 * `Runtime.callFunctionOn timed out` three steps from the real cause. A second
 * version stopped awaiting the click but then assumed the composer was still on
 * the page that had been clicked, and died with `Target closed`. It is not
 * reliably there: the composer can end up on the same page after a navigation,
 * in a popup, on a brand-new target, on a target that existed before the click
 * and changed, or on the original page after all.
 *
 * The fix stops predicting. It asks every open page "do you show a composer?"
 * until one says yes or the budget runs out. So what has to be held to account
 * is exactly that: every shape of surface is found, no dead page derails the
 * search, and the search always ends.
 *
 * NO BROWSER RUNS HERE. The pages and the browser are plain objects cast to
 * puppeteer's types, because the resolver only ever calls `isClosed()`,
 * `evaluate()` and `browser.pages()` on them. A fake page whose `evaluate`
 * REJECTS is not an approximation of a dead target — `hasPrivateComposer` sends
 * its program as a string and catches the failure to `false`, so a rejection is
 * precisely what a torn-down execution context does.
 */

/* ------------------------------------------------------------- fakes */

/**
 * Puppeteer's `Browser` and `Page`, read off the function under test instead of
 * imported.
 *
 * This workspace has two copies of puppeteer's typings on disk — the bridge
 * resolves 23.x out of `apps/fb-bridge/node_modules`, while a plain
 * `import type { Page } from 'puppeteer'` in `tests/` resolves 24.x out of the
 * root — and each `Page` class carries its own `#private` brand, so the two are
 * not assignable to one another. A double built against the wrong copy fails
 * the typecheck for a reason that has nothing to do with this flow. Taking the
 * types from the resolver's own signature cannot drift that way, whichever copy
 * npm hoists next.
 */
type Browser = Parameters<typeof resolvePrivateReplySurface>[0];
type Page = NonNullable<Awaited<ReturnType<typeof resolvePrivateReplySurface>>>;

/** Which composer a fake page is showing, if any. */
type Composer = 'dialog' | 'business-suite' | null;

/** Which composer the resolver was asking about on one `evaluate`. */
type Question = 'dialog' | 'business-suite';

interface FakePage {
  /** The double, cast to puppeteer's `Page` for the resolver. */
  page: Page;
  /** What this page shows. Mutable on purpose: a surface painting *after* the
   * click is the behaviour under test, not an edge case. */
  shows: Composer;
  /** What `isClosed()` answers. */
  closed: boolean;
  /** An execution context that is gone: every `evaluate` rejects, exactly as
   * puppeteer's does with `Target closed`. Separate from `closed` because the
   * two are not the same thing — a target can stop answering well before
   * puppeteer reports it shut. */
  dead: boolean;
  /** Every question the resolver put to this page, in order. Recorded rather
   * than counted so a test can prove WHICH pass found the composer. */
  asked: Question[];
}

/**
 * Which selector list the resolver is asking about, read off the program it
 * sends.
 *
 * Keyed on the real constants, interpolated exactly as `hasPrivateComposer`
 * interpolates them. A fake that pattern-matched on some hand-copied selector
 * string could keep passing after the product moved to a different one — the
 * test would then be checking its own copy of Facebook rather than the code.
 */
function asks(source: string, selectors: readonly string[]): boolean {
  return source.includes(JSON.stringify(selectors));
}

function fakePage(over: { shows?: Composer; closed?: boolean; dead?: boolean } = {}): FakePage {
  const state = {
    shows: over.shows ?? null,
    closed: over.closed ?? false,
    dead: over.dead ?? false,
    asked: [] as Question[],
  };

  const page = {
    isClosed: () => state.closed,
    url: () => 'https://www.facebook.com/fake',
    evaluate: async (source: string) => {
      if (state.dead) throw new Error('Protocol error: Target closed');
      if (asks(source, COMMENT_ACTIONS.messageEditor)) {
        state.asked.push('dialog');
        return state.shows === 'dialog';
      }
      if (asks(source, BIZ_COMPOSER.box)) {
        state.asked.push('business-suite');
        return state.shows === 'business-suite';
      }
      return false;
    },
  } as unknown as Page;

  return Object.assign(state, { page });
}

/**
 * A browser over a LIVE array of pages.
 *
 * `pages()` is re-read on every pass by design, so pushing onto this array
 * mid-search is how a test models a target Facebook opened after the click.
 */
function fakeBrowser(open: readonly FakePage[]): Browser {
  return {
    pages: async () => open.map((fake) => fake.page),
  } as unknown as Browser;
}

/** Everything the browser held before the click — what `privateReplyToComment`
 * passes as `known`. */
const knownSet = (fakes: readonly FakePage[]) => new Set(fakes.map((fake) => fake.page));

/** Long enough for several polls (the resolver sleeps 400ms between passes),
 * short enough that a regression fails the suite in seconds rather than
 * wedging it. */
const BUDGET_MS = 6_000;

/* -------------------------------------------- the evidence, on one page */

describe('asking one page whether it shows a private composer', () => {
  it('reads a dead target as "no composer" rather than throwing', async () => {
    // Arrange: the page the click landed on, whose context Facebook tore down.
    const torn = fakePage({ dead: true });

    // Act
    const shown = await hasPrivateComposer(torn.page, COMMENT_ACTIONS.messageEditor);

    // Assert: false, not a throw. The caller is asking precisely because it
    // does not know which page survived; a throw here is what made the second
    // version of this flow die with `Target closed` instead of looking further.
    expect(shown).toBe(false);
  });

  // Same page, same moment, same selector: `evaluate` answers and `click` does
  // not. Confirmed live on the post page Facebook opens its private-reply
  // dialog over, where puppeteer's handle-taking path hung until it was timed
  // out from outside while an in-page program kept returning in milliseconds.
  // So the composer is focused in the page and the text arrives through CDP's
  // `Input.insertText`, and neither of those may ever take a handle.
  it('focuses a composer without taking a handle on it', async () => {
    const live = fakePage({ shows: 'dialog' });

    const focused = await focusComposer(live.page, COMMENT_ACTIONS.messageEditor);

    expect(focused).toBe(true);
  });

  it('reports a composer it could not focus rather than typing into nothing', async () => {
    // A page that answers but has no composer. Typing anyway is how a private
    // reply gets recorded as sent while the words went nowhere.
    const composerless = fakePage({ shows: null });

    expect(await focusComposer(composerless.page, COMMENT_ACTIONS.messageEditor)).toBe(false);
    // And a torn-down context is a "no", not a throw — the caller is mid-flow
    // with a message still to place.
    expect(await focusComposer(fakePage({ dead: true }).page, COMMENT_ACTIONS.messageEditor)).toBe(false);
  });

  it('does not wait to hear how a send button click went', async () => {
    // The click tears down the surface it sits on, so awaiting it is the
    // original hang. Nothing is returned and nothing throws, including on a
    // target that is already gone.
    expect(fireClick(fakePage({ shows: 'dialog' }).page, COMMENT_ACTIONS.messageSendButton)).toBeUndefined();
    expect(() => fireClick(fakePage({ dead: true }).page, COMMENT_ACTIONS.messageSendButton)).not.toThrow();
  });
});

/* ------------------------------------------------ fail-closed surface gate */

describe('asserting that a surface is private before any text is typed', () => {
  const expected = { contactId: '100036687631918', contactName: 'Gabe' };
  const noSuite = {
    detailView: false, editor: false, selectedThreadId: null, selectedThreadType: null, headerHtml: null,
  };

  it('rejects the exact post-modal incident even when its public editor is visible', () => {
    // THE INCIDENT: the post itself is a `role=dialog`, and its public Reply
    // composer is a Lexical textbox. Treating either fact as a DM surface led
    // to private text being typed here and Enter publishing it publicly.
    const result = validatePrivateMessageSurface({
      dialogs: [{ label: "Red Panda Test's post", editor: true, sendControl: true }],
      businessSuite: noSuite,
    }, expected);

    expect(result).toBeNull();
  });

  it('accepts only a named private dialog with its own editor and send control', () => {
    const accepted = validatePrivateMessageSurface({
      dialogs: [{ label: 'Kirim pesan Gabe', editor: true, sendControl: true }],
      businessSuite: noSuite,
    }, expected);
    const wrongContact = validatePrivateMessageSurface({
      dialogs: [{ label: 'Message Sinta', editor: true, sendControl: true }],
      businessSuite: noSuite,
    }, expected);
    const noButton = validatePrivateMessageSurface({
      dialogs: [{ label: 'Message Gabe', editor: true, sendControl: false }],
      businessSuite: noSuite,
    }, expected);

    expect(accepted).toBe('dialog');
    expect(wrongContact).toBeNull();
    expect(noButton).toBeNull();
  });

  it('allows Enter only for a verified Facebook Messenger Business Suite thread', () => {
    const accepted = validatePrivateMessageSurface({
      dialogs: [],
      businessSuite: {
        detailView: true, editor: true, selectedThreadId: expected.contactId,
        selectedThreadType: 'FB_MESSAGE',
        headerHtml: '<span data-surface="bizweb_inbox:detail_view_header"><div>Gabe</div><div>Assign this conversation</div></span>',
      },
    }, expected);
    const wrongThread = validatePrivateMessageSurface({
      dialogs: [],
      businessSuite: {
        detailView: true, editor: true, selectedThreadId: '100000000000999',
        selectedThreadType: 'FB_MESSAGE',
        headerHtml: '<span data-surface="bizweb_inbox:detail_view_header"><div>Gabe</div></span>',
      },
    }, expected);
    const instagram = validatePrivateMessageSurface({
      dialogs: [],
      businessSuite: {
        detailView: true, editor: true, selectedThreadId: expected.contactId,
        selectedThreadType: 'IG_MESSAGE',
        headerHtml: '<span data-surface="bizweb_inbox:detail_view_header"><div>Gabe</div></span>',
      },
    }, expected);

    expect(accepted).toBe('business_suite');
    expect(wrongThread).toBeNull();
    expect(instagram).toBeNull();
  });

  it('proves the exact Business Suite destination before a normal CRM DM may type', () => {
    const evidence = {
      dialogs: [],
      businessSuite: {
        detailView: true, editor: true, selectedThreadId: expected.contactId,
        selectedThreadType: 'FB_MESSAGE',
        headerHtml: '<span data-surface="bizweb_inbox:detail_view_header"><div>Gabe</div></span>',
      },
    };

    expect(validateBusinessSuiteThreadSurface(evidence, expected.contactId)).toBe(true);
    expect(validateBusinessSuiteThreadSurface({
      ...evidence,
      businessSuite: { ...evidence.businessSuite, selectedThreadId: '100000000000999' },
    }, expected.contactId)).toBe(false);
    expect(validateBusinessSuiteThreadSurface({
      ...evidence,
      businessSuite: { ...evidence.businessSuite, selectedThreadType: 'IG_MESSAGE' },
    }, expected.contactId)).toBe(false);
  });
});

/* ------------------------------------------------ where the composer lands */

describe('finding the surface Facebook opened for a private reply', () => {
  it('returns the clicked page itself when the dialog opened on it', async () => {
    // Arrange: the ordinary case — Facebook renders its "Message <name>" modal
    // straight onto the post page. A fix that only ever looked at NEW targets
    // would report "Facebook did not open a message box" for a dialog that is
    // sitting right there.
    const postPage = fakePage({ shows: 'dialog' });
    const browser = fakeBrowser([postPage]);

    // Act
    const surface = await resolvePrivateReplySurface(browser, knownSet([postPage]), BUDGET_MS);

    // Assert
    expect(surface).toBe(postPage.page);
  });

  it('returns a popup that did not exist before the click', async () => {
    // Arrange: the failure that produced `Target closed`. The composer is in a
    // window Facebook opened, and the earlier fix typed into the post page
    // regardless — into a page that by then had no composer and, moments later,
    // no execution context either.
    const postPage = fakePage({ shows: null });
    const known = knownSet([postPage]);
    const popup = fakePage({ shows: 'dialog' });
    const browser = fakeBrowser([postPage, popup]);

    // Act
    const surface = await resolvePrivateReplySurface(browser, known, BUDGET_MS);

    // Assert
    expect(surface).toBe(popup.page);
    expect(surface).not.toBe(postPage.page);
  });

  it('waits for a brand-new target that paints its composer a beat later', async () => {
    // Arrange: the target arrives after the click, and its React tree paints
    // the composer later still. A resolver that answered off a single pass —
    // or that watched only for `targetcreated` and then asked once — reports
    // "private reply unavailable" for a comment Facebook was perfectly willing
    // to answer, and the CRM records that permanent-sounding refusal on the
    // comment forever.
    const postPage = fakePage({ shows: null });
    const known = knownSet([postPage]);
    const open: FakePage[] = [postPage];
    const browser = fakeBrowser(open);

    const late = fakePage({ shows: null });
    const appears = setTimeout(() => { open.push(late); }, 600);
    const paints = setTimeout(() => { late.shows = 'dialog'; }, 2_000);

    // Act
    const startedAt = Date.now();
    const surface = await resolvePrivateReplySurface(browser, known, BUDGET_MS);
    const elapsed = Date.now() - startedAt;
    clearTimeout(appears);
    clearTimeout(paints);

    // Assert: found, within the budget, and only after the page had answered
    // "no" at least once — which is the pass that used to end the search.
    expect(surface).toBe(late.page);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    expect(late.asked.length).toBeGreaterThan(1);
  });

  it('never falls back to a conversation tab that was open before the click', async () => {
    // Arrange: the post page never shows the dialog, and a Business Suite tab
    // that existed before the click has a composer. That tab is the bridge's
    // own long-lived inbox (or one it opened itself): typing into it sends an
    // ordinary DM from a watcher's tab, unlinked from the comment. Measured
    // live 2026-09-26, the click opens its dialog in the same tab — so a
    // dialog that never appears means nothing is typed, not a fallback.
    const postPage = fakePage({ shows: null });
    const inboxTab = fakePage({ shows: 'business-suite' });
    const known = knownSet([postPage, inboxTab]);
    const browser = fakeBrowser([postPage, inboxTab]);

    // Act
    const surface = await resolvePrivateReplySurface(browser, known, BUDGET_MS);

    // Assert: nothing, after asking every page about the dialog until the budget ran out.
    expect(surface).toBeNull();
    expect(postPage.asked.filter((q) => q === 'dialog').length).toBeGreaterThan(1);
    expect(inboxTab.asked).not.toContain('business-suite');
  });

  // THE THIRD BUG THIS FILE EXISTS FOR, found live. Clicking "Send message"
  // opens Facebook's dialog AND replaces the post page's document underneath
  // it. A resolver that returned the first page to show a composer handed back
  // a document already on its way out: the `evaluate` that found the composer
  // succeeded, and the very next call — puppeteer's `click`, which scrolls the
  // element into view — landed in a context that no longer answered and hung
  // until it was timed out from outside.
  it('ignores a composer on a document that is already going away', async () => {
    // Arrange: a page showing the dialog right now whose context dies a beat
    // later, and a second page that then shows the real one.
    const dying = fakePage({ shows: 'dialog' });
    const replacement = fakePage({ shows: null });
    const browser = fakeBrowser([dying, replacement]);
    setTimeout(() => { dying.dead = true; replacement.shows = 'dialog'; }, 300);

    // Act
    const surface = await resolvePrivateReplySurface(browser, knownSet([dying]), BUDGET_MS);

    // Assert
    expect(surface).toBe(replacement.page);
    expect(surface).not.toBe(dying.page);
  });

  // THE SECOND BUG THIS FILE EXISTS FOR, found live. `privateReplyToComment`
  // opens the commenter's Messenger thread BEFORE the click, to take the
  // baseline its confirmation is measured against. That tab is a Business
  // Suite conversation, so it always has a composer — and an earlier resolver
  // offered the already-open tabs a Business Suite composer on every pass,
  // which meant that tab was chosen 81ms after the click, long before Facebook
  // could paint its dialog. The private reply then went out through the plain
  // thread composer, unlinked from the comment, and for a commenter with no
  // thread yet there would have been nothing to type into at all.
  it('does not take an already-open conversation while the dialog is still coming', async () => {
    // Arrange: the live shape — the post page, the thread this service opened
    // itself, and a dialog that paints 1.2s after the click.
    const postPage = fakePage({ shows: null });
    const ownThread = fakePage({ shows: 'business-suite' });
    const known = knownSet([postPage, ownThread]);
    const browser = fakeBrowser([postPage, ownThread]);
    setTimeout(() => { postPage.shows = 'dialog'; }, 1_200);

    // Act
    const surface = await resolvePrivateReplySurface(browser, known, BUDGET_MS);

    // Assert: the dialog, not the tab that was there all along.
    expect(surface).toBe(postPage.page);
    expect(ownThread.asked).not.toContain('business-suite');
  });

  it('takes no plain conversation tab at all, whoever opened it', async () => {
    // Arrange: both show a Business Suite composer — one from before the click,
    // one that appeared during it. The second may be another job's thread read
    // or outbound send on this same customer, which passes every identity
    // check; typing there sends an ordinary DM from someone else's tab. Only
    // the private-reply dialog is a private reply (measured live 2026-09-26).
    const ownThread = fakePage({ shows: 'business-suite' });
    const known = knownSet([ownThread]);
    const opened = fakePage({ shows: 'business-suite' });
    const browser = fakeBrowser([ownThread, opened]);

    // Act
    const surface = await resolvePrivateReplySurface(browser, known, BUDGET_MS);

    // Assert
    expect(surface).toBeNull();
  });

  it('keeps searching past a page whose target died rather than aborting on it', async () => {
    // Arrange: the exact shape of the live failure. The clicked page is gone —
    // `isClosed()` true and every `evaluate` on it rejecting — while a second,
    // still-open target has quietly stopped answering too. The composer is on a
    // third. One unhandled rejection from either corpse and the whole private
    // reply fails with `Target closed`, which is what happened live.
    const postPage = fakePage({ closed: true, dead: true });
    const known = knownSet([postPage]);
    const popup = fakePage({ shows: 'dialog' });
    const zombie = fakePage({ dead: true });
    const browser = fakeBrowser([postPage, popup, zombie]);

    // Act
    const surface = await resolvePrivateReplySurface(browser, known, BUDGET_MS);

    // Assert
    expect(surface).toBe(popup.page);
    // A closed page is never even asked — puppeteer would reject on it, and
    // there is nothing to learn from a target that has reported itself shut.
    expect(postPage.asked).toEqual([]);
  });

  it('prefers the most recently opened page when two of them show a composer', async () => {
    // Arrange: an older tab left over from an earlier private reply still has
    // its composer on screen. Typing this customer's message into THAT one
    // sends it to the wrong person — the single worst outcome this whole flow
    // can produce, and invisible from the CRM side, which would record a
    // delivery that reached someone else.
    const stale = fakePage({ shows: 'dialog' });
    const known = knownSet([stale]);
    const fresh = fakePage({ shows: 'dialog' });
    const browser = fakeBrowser([stale, fresh]);

    // Act
    const surface = await resolvePrivateReplySurface(browser, known, BUDGET_MS);

    // Assert: the newest wins, and the stale one is not even consulted — so
    // this is the ordering rule holding, not two right answers and luck.
    expect(surface).toBe(fresh.page);
    expect(stale.asked).toEqual([]);
  });
});

/* ------------------------------------------------------- when nothing opens */

describe('a comment Facebook offers no private reply for', () => {
  it('answers null rather than throwing when every page is dead or composerless', async () => {
    // Arrange: Facebook offers a private reply only for some comments and some
    // people, so "nothing opened" is a real answer, not an error. The caller
    // turns null into a typed `private_reply_unavailable` the agent can read;
    // a throw from here would surface as an unexplained bridge failure and be
    // retried forever against a comment that will never accept one.
    const torn = fakePage({ dead: true });
    const empty = fakePage({ shows: null });
    const browser = fakeBrowser([torn, empty]);

    // Act
    const surface = await resolvePrivateReplySurface(browser, knownSet([torn, empty]), 1_000);

    // Assert
    expect(surface).toBeNull();
  });

  it('gives up at the budget rather than hanging the way the first version did', async () => {
    // Arrange: nothing will ever appear. The original bug was not a wrong
    // answer, it was NO answer — an awaited in-page call that never resolved
    // and held one comment action for 188 seconds, past every budget in the
    // bridge and long enough for the queue to look stuck. The budget existing
    // is the whole guarantee, so it is asserted rather than assumed.
    const empty = fakePage({ shows: null });
    const browser = fakeBrowser([empty]);
    const budgetMs = 1_200;

    // Act
    const startedAt = Date.now();
    const surface = await resolvePrivateReplySurface(browser, knownSet([empty]), budgetMs);
    const elapsed = Date.now() - startedAt;

    // Assert: it ends, roughly on time. Loose on purpose — the claim is "this
    // returns", not "this returns at millisecond N", and a timing-exact
    // assertion would fail on a loaded CI box while the code was perfect.
    expect(surface).toBeNull();
    expect(elapsed).toBeLessThan(budgetMs + 2_000);
    // And it really did poll rather than answer once and sit out the budget.
    expect(empty.asked.length).toBeGreaterThan(1);
  });
});

/* --------------------------------------------------- our own clock, not CDP's */

/**
 * `withDeadline` — the reason a call into a page whose execution context is
 * being torn down fails in seconds, not at puppeteer's own `protocolTimeout`
 * (180s by default). Confirmed live: the first version of every step here
 * awaited puppeteer directly, and a torn-down page hung until that timeout and
 * surfaced an error naming the CDP method, not the step a person could act on.
 */
describe('bounding a browser call on our own clock', () => {
  it('resolves with the work\'s value when it finishes first', async () => {
    const value = await withDeadline(Promise.resolve('selesai'), 1_000, 'contoh');

    expect(value).toBe('selesai');
  });

  it('times out with a message naming the step, not the underlying error', async () => {
    const hung = new Promise<never>(() => {}); // never settles, as a torn-down page's evaluate does not

    await expect(withDeadline(hung, 50, 'mengetik pesan')).rejects.toThrow(/mengetik pesan/);
  });

  it('propagates the work\'s own rejection rather than a timeout, when the work fails first', async () => {
    const failed = Promise.reject(new Error('gagal duluan'));

    await expect(withDeadline(failed, 1_000, 'contoh')).rejects.toThrow('gagal duluan');
  });

  it('clears its timer on the fast path, so a resolved call leaves nothing pending', async () => {
    // Not directly observable from outside, but a leaked timer is exactly what
    // would keep the test process alive past this file — vitest's own process
    // exit is the check.
    await withDeadline(Promise.resolve(1), 10_000, 'contoh');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(true).toBe(true);
  });
});

/* ------------------------------------------- surviving a delayed publish */

/**
 * `confirmReplyWithFinalRecheck` — the fix for a live incident, not a
 * defensive guess.
 *
 * A public reply on a genuinely FRESH post was typed once, Enter was pressed
 * once, and the 20-second window this replaced gave up before Facebook's own
 * backend had finished publishing the comment. The reply was there — a later,
 * independent read found it, correctly attributed to the Page, under the
 * right post — but the CRM had already recorded the row as `'failed'`, a
 * status this codebase treats as terminal for a public reply. Facebook and
 * the CRM disagreed about a reply that had, in fact, gone out, and nothing
 * short of a person reading Facebook by hand would ever have noticed.
 */
describe('confirming a public reply that Facebook publishes late', () => {
  /** A `check` that starts false and flips true after `afterMs` — the shape
   * of a reply that lands, just later than an impatient window would wait. */
  const flipsAfter = (afterMs: number) => {
    const t0 = Date.now();
    return async () => Date.now() - t0 >= afterMs;
  };

  it('confirms a reply that appears after 20s — the exact delay observed live', async () => {
    // The window this replaces would already have given up by the time this
    // reply appears; the one under test is wide enough not to.
    const seen = flipsAfter(2_500);

    const outcome = await confirmReplyWithFinalRecheck(seen, { budgetMs: 6_000, pollMs: 200 });

    expect(outcome).toBe('settled');
  });

  it('still confirms a reply that only appears in the final recheck, after the budget runs out', async () => {
    // The exact race the final recheck exists for: the poll loop's last
    // iteration runs before the reply lands, and the deadline is crossed
    // asleep — everything in between the last poll and the deadline would be
    // invisible without one more look taken after the loop gives up.
    let checks = 0;
    const seen = async () => {
      checks += 1;
      return checks > 3; // false for every in-loop poll, true only afterwards
    };

    const outcome = await confirmReplyWithFinalRecheck(seen, { budgetMs: 300, pollMs: 100 });

    expect(outcome).toBe('final-recheck');
  });

  it('reports not-confirmed only once neither the loop nor the final recheck ever sees it — a true failure', async () => {
    const neverSeen = async () => false;

    const outcome = await confirmReplyWithFinalRecheck(neverSeen, { budgetMs: 300, pollMs: 100 });

    expect(outcome).toBe('not-confirmed');
  });

  it('does not call the check again once it has settled — nothing after success re-touches the page', async () => {
    let calls = 0;
    const seen = async () => { calls += 1; return calls === 1; };

    const outcome = await confirmReplyWithFinalRecheck(seen, { budgetMs: 1_000, pollMs: 50 });

    expect(outcome).toBe('settled');
    expect(calls).toBe(1);
  });

  it('polls read-only at the given interval — never faster, never a reload', async () => {
    const calls: number[] = [];
    const t0 = Date.now();
    const seen = async () => { calls.push(Date.now() - t0); return false; };

    await confirmReplyWithFinalRecheck(seen, { budgetMs: 260, pollMs: 100 });

    // Three or four reads over ~260ms at a 100ms interval, not a busy loop.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(5);
  });
});

/**
 * The state-machine side of the same incident: a job that reports
 * `SendNotConfirmedError` never gets a second real send, and a comment that
 * genuinely never went through stays `'failed'` — recorded here against the
 * actual transition rules rather than assumed from the trace.
 */
describe('what a failed public reply is allowed to do next', () => {
  it('is never claimable again once markCommentPublicReplyFailed has run — the retry path is structurally a no-op', async () => {
    const db = await freshDb();
    try {
      const t = await makeTenant(db, 'fbreplyretry');
      const id = await withTenant(db, t.tenantId, (tx) =>
        recordFacebookComment({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          pageId: '900000000000001', pageName: 'Toko Demo', postId: '998877665544',
          commentId: '700000000000001', authorExternalId: '600000000000001', authorName: 'Siti',
          body: 'harganya berapa?', commentedAt: null,
        }).then((row) => row.id));

      const ctx = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => ({ tx, tenantId: t.tenantId, kek: TEST_KEK });
      const claimed = await withTenant(db, t.tenantId, (tx) => claimCommentForPublicReply(ctx(tx), { id }));
      expect(claimed).toBe(true);

      // What `failPublicReply` does BEFORE it ever rethrows the transient
      // error that lets BullMQ schedule a retry — this is the guard that
      // makes that retry a no-op, and the whole reason a delayed-publish
      // false negative is not also a double-send risk.
      await withTenant(db, t.tenantId, (tx) =>
        markCommentPublicReplyFailed(ctx(tx), { id, reason: 'Balasan sudah diketik tapi tidak muncul di bawah komentar' }));

      const retryClaim = await withTenant(db, t.tenantId, (tx) => claimCommentForPublicReply(ctx(tx), { id }));

      expect(retryClaim).toBe(false);
      const after = await withTenant(db, t.tenantId, (tx) => getFacebookComment(ctx(tx), { id }));
      expect(after?.status).toBe('failed');
    } finally {
      await db.close();
    }
  });

  it('marks a reply that truly never landed as failed, with the explicit reason on the row', async () => {
    const db = await freshDb();
    try {
      const t = await makeTenant(db, 'fbreplytruefail');
      const id = await withTenant(db, t.tenantId, (tx) =>
        recordFacebookComment({ tx, tenantId: t.tenantId, kek: TEST_KEK }, {
          pageId: '900000000000001', pageName: 'Toko Demo', postId: '998877665544',
          commentId: '700000000000002', authorExternalId: '600000000000002', authorName: 'Budi',
          body: 'ready kak?', commentedAt: null,
        }).then((row) => row.id));

      const ctx = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => ({ tx, tenantId: t.tenantId, kek: TEST_KEK });
      await withTenant(db, t.tenantId, (tx) => claimCommentForPublicReply(ctx(tx), { id }));

      const reason = 'Balasan sudah diketik tapi tidak muncul di bawah komentar setelah 60 detik — '
        + 'kemungkinan ditolak diam-diam oleh Facebook';
      await withTenant(db, t.tenantId, (tx) => markCommentPublicReplyFailed(ctx(tx), { id, reason }));

      const after = await withTenant(db, t.tenantId, (tx) => getFacebookComment(ctx(tx), { id }));
      expect(after?.status).toBe('failed');
      expect(after?.publicReplyError).toBe(reason);
    } finally {
      await db.close();
    }
  });
});
