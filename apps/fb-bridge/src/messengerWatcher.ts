import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer';
import { selectBackfill, type ParsedMessage } from './parsers/messengerThread.ts';
import { CheckpointRequiredError, SessionExpiredError, type SessionManager } from './sessionManager.ts';
import { businessSuiteTransport } from './transport/businessSuite.ts';
import { messengerDotComTransport } from './transport/messengerDotCom.ts';
import type { ThreadTransport, TransportContext } from './transport/types.ts';
import type { FbBridgeEvent } from './events.ts';

// Moved to its own module so `transport/` can use it without importing this
// file, which imports `transport/`. Re-exported because `commentWatcher.ts` and
// `sessionManager.ts` already import it from here.
export { readContainerHtml } from './pageHtml.ts';

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * Reconciliation cadence. Deliberately slow: the `MutationObserver` below is
 * the real mechanism, and this exists only as a safety net for what an observer
 * structurally cannot see — a tab whose renderer died, a browser that crashed,
 * a session that expired while nothing was happening. Polling Facebook harder
 * than a person would use it is both pointless and the surest way to get an
 * account flagged.
 */
const RECONCILE_INTERVAL_MS = 10 * 60_000;
/** How long the observer waits for the DOM to settle before reading. */
const OBSERVER_DEBOUNCE_MS = 1_500;

interface Anchor {
  id: string | null;
  senderName: string;
  text: string;
}

/**
 * One long-lived page per tenant sits on the Messenger inbox with a
 * `MutationObserver` watching it; a conversation row changing signature is the
 * only signal this acts on. Reading a changed thread happens on a separate
 * short-lived tab, so it never navigates the observer page out from under
 * itself.
 *
 * Every message is diffed against the last full reading of its thread, so only
 * genuinely new ones are emitted. `apps/ig-bridge` proved both failure modes
 * this avoids, live: re-emitting the visible history on every change relied on
 * downstream content hashing, which dropped a customer repeating a short word
 * ("halo") as a false duplicate; and keying on DOM position made already-read
 * messages resurface whenever the rendered window shifted.
 *
 * INBOUND ONLY. Nothing here sends, and `parseMessengerThread` drops anything
 * it cannot prove came from the other party.
 */
export class MessengerWatcher {
  private observed = new Set<string>();
  private observerPages = new Map<string, Page>();
  private signatures = new Map<string, Map<string, string>>();
  private anchors = new Map<string, Map<string, Anchor[]>>();
  private nextSeq = new Map<string, Map<string, number>>();
  /** Per tenant, per thread: who the conversation is with. Only Business Suite
   * needs it — messenger.com names the sender inside every message — but it is
   * kept for both so the watcher itself has no transport-shaped branches. */
  private contactNames = new Map<string, Map<string, string>>();
  private chain = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private sessions: SessionManager,
    private onEvent: (ev: FbBridgeEvent) => void,
    private log: Logger,
    /**
     * Asks the CRM which message ids it already holds. Injected rather than
     * built here so the bridge never reaches for a database of its own — the
     * CRM is the source of truth for what has been stored, and a second opinion
     * kept on this machine would drift the moment either side is restored.
     */
    private knownIds: (tenantId: string, externalIds: string[]) => Promise<Set<string>>,
    private maxBackfill = Number(process.env.FB_BACKFILL_MAX_MESSAGES ?? 50),
  ) {}

  start(): void {
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---------------------------------------------------------- attachment */

  /**
   * Re-attaches anything that has come adrift, and attaches anything new.
   *
   * Two liveness checks, because they catch different deaths. The browser-level
   * one catches the whole browser going away. The page ping catches the
   * observer's own tab going quiet on its own — its renderer crashing, or being
   * reclaimed under memory pressure — while the browser and every other tab
   * stay perfectly healthy. `apps/ig-bridge` hit exactly that: a real message
   * sat visible on the site for hours, unread, with no error anywhere, because
   * nothing was checking the one tab that mattered.
   */
  private async reconcile(): Promise<void> {
    for (const tenantId of await this.sessions.knownTenantIds()) {
      if (this.observed.has(tenantId) && !this.sessions.isConnected(tenantId)) {
        this.log.warn({ tenantId }, 'fb-bridge: browser connection died — re-attaching');
        this.detach(tenantId);
      }

      if (this.observed.has(tenantId) && !(await this.isObserverAlive(tenantId))) {
        this.log.warn({ tenantId }, 'fb-bridge: inbox tab went unresponsive — re-attaching');
        this.detach(tenantId);
      }

      if (!this.observed.has(tenantId)) {
        await this.attachTenant(tenantId).catch((err) =>
          this.log.warn({ err, tenantId }, 'fb-bridge: failed to attach tenant to the messenger watcher'));
        continue;
      }

      // Already attached and healthy: sweep the inbox once anyway. An observer
      // only fires on *future* mutations, so a thread that changed while the
      // browser was briefly wedged would otherwise never be noticed.
      this.enqueue(tenantId, () => this.sweepInbox(tenantId));
      // And reconcile history, which the observer cannot do at all: it reports
      // changes from now on, and says nothing about what happened while the
      // bridge was down.
      this.enqueue(tenantId, () => this.backfillTenant(tenantId));
    }
  }

  private async isObserverAlive(tenantId: string): Promise<boolean> {
    const page = this.observerPages.get(tenantId);
    if (!page || page.isClosed()) return false;
    // A hung page never rejects and never resolves, so this is raced against a
    // timeout rather than trusted to fail on its own.
    return await Promise.race([
      page.evaluate('1').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]).catch(() => false);
  }

  private detach(tenantId: string): void {
    this.observed.delete(tenantId);
    this.observerPages.delete(tenantId);
  }

  /**
   * Public so the connect route can attach immediately after a login lands,
   * instead of waiting up to ten minutes for the next reconciliation.
   */
  async attachTenant(tenantId: string): Promise<void> {
    if (this.observed.has(tenantId)) return;
    // Reserved before the first await, not after: `getActivePage` can take
    // seconds (launching a browser), and a second caller passing this same
    // check meanwhile would install a second `MutationObserver` on the same
    // page — every change reported twice. `apps/ig-bridge` confirmed that live,
    // as a flood of paired-duplicate webhook events.
    this.observed.add(tenantId);

    const page = await this.sessions.getActivePage(tenantId);
    if (!page) {
      this.observed.delete(tenantId);
      return;
    }

    const { transport, ctx } = await this.transportFor(tenantId);

    try {
      await page.goto(transport.inboxUrl(ctx), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.sessions.assertUsable(page);
      // The conversation list renders after the page has text in it, so
      // `assertUsable` passing is not the same as the list being there.
      // Confirmed live: the first sweep ran against a page whose body was
      // already full of Facebook chrome but whose thread grid had not appeared
      // yet, logged "inbox container not found", and — because a
      // `MutationObserver` only fires on *future* changes — nothing swept
      // again until the next reconciliation ten minutes later. `readThread`
      // already waits for its own marker this way.
      await page.waitForSelector(transport.inboxWaitSelectors.join(', '), { timeout: 15_000 }).catch(() => {});
      await installInboxObserver(page, () => this.enqueue(tenantId, () => this.sweepInbox(tenantId)));
      this.observerPages.set(tenantId, page);
      this.log.info({ tenantId, transport: transport.kind }, 'fb-bridge: inbox observer attached');
      if (!transport.discoversConversations) {
        // Said once, at attach, rather than never: this transport reconciles
        // what it already knows and reads whichever conversation the surface
        // has selected, but it cannot enumerate an inbox. An operator seeing a
        // healthy-looking bridge deserves to know which of those it is doing.
        this.log.warn(
          { tenantId, transport: transport.kind },
          'fb-bridge: this surface exposes no per-row conversation id — only the selected conversation and already-known threads are read',
        );
      }
      // The observer fires on future mutations only, so the first reading has
      // to be taken here or a thread that never changes again is never seen.
      this.enqueue(tenantId, () => this.sweepInbox(tenantId));
    } catch (err) {
      // A tenant that failed to attach must be free to try again on the next
      // tick. Left marked attached by a *failed* attempt, every later retry
      // silently does nothing — forever, until the process restarts.
      this.detach(tenantId);
      this.reportFailure(tenantId, err);
      throw err;
    }
  }

  /**
   * Runs work one-at-a-time per tenant.
   *
   * The observer debounces to one signal per quiet period, which says nothing
   * about how long *this* side takes to act on it. A sweep still mid-read when
   * the next signal lands used to start a second concurrent sweep on the same
   * tenant; two concurrent reads of one thread race on the same anchor, which
   * `apps/ig-bridge` saw live as both spurious "empty scrape" warnings and
   * messages reported twice.
   */
  private enqueue(tenantId: string, work: () => Promise<void>): void {
    const prior = this.chain.get(tenantId) ?? Promise.resolve();
    const next = prior
      .then(work)
      .catch((err) => this.log.warn({ err, tenantId }, 'fb-bridge: a watcher pass failed'));
    this.chain.set(tenantId, next);
  }

  /* ------------------------------------------------------------- sweeping */

  private async sweepInbox(tenantId: string): Promise<void> {
    const page = this.observerPages.get(tenantId);
    if (!page || page.isClosed()) return;

    const { transport } = await this.transportFor(tenantId);
    const reading = await transport.readInbox(page);
    if (!reading) {
      this.log.warn({ tenantId }, 'fb-bridge: inbox container not found — selectors may be stale');
      return;
    }

    const { rows, rowCount } = reading;
    if (rowCount === 0) {
      // The container rendered but holds no conversation links at all. That is
      // either a genuinely empty inbox or a stale selector, and the two are
      // indistinguishable from here — so it is logged rather than swallowed,
      // because the silent version of this is a bridge that looks healthy and
      // delivers nothing.
      this.log.warn({ tenantId }, 'fb-bridge: inbox rendered with no conversation links — empty inbox, or INBOX.rowLink is stale');
      return;
    }

    const seen = this.signatures.get(tenantId) ?? new Map<string, string>();
    this.signatures.set(tenantId, seen);

    // A row's name is not tracked here. The sender on each message comes from
    // the thread itself, where the markup names it per bubble; carrying the
    // inbox's idea of the name alongside would be a second source of truth for
    // the same fact, and the weaker of the two.
    for (const row of rows) {
      // Business Suite names nobody inside a message, so the row's name is the
      // only reading of who this conversation is with. Remembered rather than
      // passed through, because backfill reaches a thread without having just
      // read the inbox.
      this.rememberContactName(tenantId, row.threadId, row.name);
      if (seen.get(row.threadId) === row.signature) continue;
      seen.set(row.threadId, row.signature);
      await this.readThread(tenantId, row.threadId).catch((err) =>
        this.log.warn({ err, tenantId, threadId: row.threadId }, 'fb-bridge: failed to read a changed thread'));
    }
  }

  /**
   * Brings every visible thread's history into the CRM.
   *
   * One thread failing must not take the others with it. A conversation can be
   * unreadable for reasons that have nothing to do with the rest — it is a
   * message request, it renders slowly, its markup changed — and stopping there
   * would leave every thread behind it silently unreconciled, which is the
   * failure mode this whole pass exists to prevent.
   */
  private async backfillTenant(tenantId: string): Promise<void> {
    const page = this.observerPages.get(tenantId);
    if (!page || page.isClosed()) return;

    const { transport } = await this.transportFor(tenantId);
    const reading = await transport.readInbox(page);
    if (!reading) {
      this.log.warn({ tenantId }, 'fb-bridge: inbox container not found — cannot reconcile history');
      return;
    }

    // Threads seen in this reading, plus every thread already anchored. On a
    // surface that cannot enumerate its inbox, the anchors are the only memory
    // of which conversations exist at all — without them a reconnecting bridge
    // would reconcile one conversation and silently forget the rest.
    const rows = this.withKnownThreads(tenantId, reading.rows);
    let imported = 0;
    for (const row of rows) {
      try {
        imported += await this.backfillThread(tenantId, row.threadId);
      } catch (err) {
        // Named, not swallowed: an operator has to be able to see which
        // conversation is stuck and why.
        this.log.warn(
          { tenantId, threadId: row.threadId, err: (err as Error).message },
          'fb-bridge: could not reconcile a thread — continuing with the rest',
        );
        this.reportFailure(tenantId, err);
      }
    }
    if (imported > 0) this.log.info({ tenantId, imported }, 'fb-bridge: history reconciled');
  }

  /**
   * Imports whatever of one thread's history the CRM is missing.
   *
   * Discovery runs newest to oldest and stops at the first message the CRM
   * already holds — everything behind it is older and therefore already stored.
   * The messages are then emitted oldest to newest, because a conversation has
   * to arrive in the order it happened.
   *
   * Direction is carried through: our own past replies are reported as outbound
   * so the thread does not read as a customer talking to nobody, and the CRM
   * writes them straight in as sent rather than queueing them to be delivered
   * to a real person a second time.
   */
  private async backfillThread(tenantId: string, threadId: string): Promise<number> {
    const { transport, ctx } = await this.transportFor(tenantId);
    const page = await this.sessions.newPage(tenantId);
    if (!page) return 0;

    try {
      await page.goto(transport.threadUrl(ctx, threadId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.sessions.assertUsable(page);
      await page.waitForSelector(transport.threadWaitSelectors.join(', '), { timeout: 15_000 }).catch(() => {});

      const html = await transport.readTranscriptHtml(page);
      if (!html) throw new Error('message container not found — the transcript selectors may be stale');

      const parsed = transport.parseTranscript(html, {
        selfName: ctx.pageName, contactName: this.contactNameFor(tenantId, threadId),
      });
      const candidates = parsed.messages
        .map((m) => m.externalMessageId)
        .filter((id): id is string => Boolean(id))
        .map((id) => `fb_dm:${tenantId}:${id}`);

      const knownKeys = await this.knownIds(tenantId, candidates);
      const missing = selectBackfill(parsed.messages, {
        isKnown: (id) => knownKeys.has(`fb_dm:${tenantId}:${id}`),
        maxMessages: this.maxBackfill,
      });

      for (const message of missing) {
        this.onEvent({
          event: 'message',
          tenantId,
          at: new Date().toISOString(),
          message: {
            threadId,
            externalMessageId: message.externalMessageId,
            senderId: threadId,
            senderName: message.senderName,
            text: message.text,
            sentAt: message.sentAt,
            direction: message.direction,
            seq: this.takeSeq(tenantId, threadId),
          },
        });
      }
      return missing.length;
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async readThread(tenantId: string, threadId: string): Promise<void> {
    const { transport, ctx } = await this.transportFor(tenantId);
    const page = await this.sessions.newPage(tenantId);
    if (!page) return;

    try {
      await page.goto(transport.threadUrl(ctx, threadId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.sessions.assertUsable(page);
      // Waits for real message markup rather than a fixed sleep. A flat delay
      // lands on Facebook's loading skeleton often enough to be the actual
      // cause of "empty read", not a transient blip — worse under the CPU
      // pressure of several dev servers at once.
      await page.waitForSelector(transport.threadWaitSelectors.join(', '), { timeout: 15_000 }).catch(() => {});

      const html = await transport.readTranscriptHtml(page);
      if (!html) {
        this.log.warn(
          { tenantId, threadId, transport: transport.kind },
          'fb-bridge: message container not found — the transcript selectors may be stale',
        );
        return;
      }

      const parsed = transport.parseThread(html, {
        selfName: ctx.pageName, contactName: this.contactNameFor(tenantId, threadId),
      });

      if (parsed.matchedRows > 0 && parsed.unknownSenderRows === parsed.matchedRows) {
        // Every single row had text but no attributable sender. One such row is
        // ordinary; all of them means the sender selectors stopped matching, and
        // the correct response is to say so, not to quietly deliver nothing.
        this.log.error(
          { tenantId, threadId, rows: parsed.matchedRows },
          'fb-bridge: no message row had an identifiable sender — THREAD sender selectors are stale',
        );
      }

      for (const message of this.diffNew(tenantId, threadId, parsed.messages)) {
        this.onEvent({
          event: 'message',
          tenantId,
          at: new Date().toISOString(),
          message: {
            threadId,
            externalMessageId: message.externalMessageId,
            // The thread id *is* the other party's id on a 1:1 Messenger
            // thread, and it is the only identity the DOM offers that survives
            // a display-name change. A name is not an identity.
            senderId: threadId,
            senderName: message.senderName,
            text: message.text,
            sentAt: message.sentAt,
            direction: 'inbound',
            seq: this.takeSeq(tenantId, threadId),
          },
        });
      }
    } catch (err) {
      this.reportFailure(tenantId, err);
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /* ----------------------------------------------------------- diffing */

  /**
   * What is new since the last reading of this thread.
   *
   * Two strategies. When every message on both sides carries a real Facebook
   * id, the diff is an exact set difference — no heuristics, no ordering
   * assumptions. When ids are missing (a UI that does not expose them), it
   * falls back to anchoring on the previously-last-known message, which is what
   * `apps/ig-bridge` had to do for everything.
   */
  private diffNew(tenantId: string, threadId: string, current: ParsedMessage[]): ParsedMessage[] {
    const byThread = this.anchors.get(tenantId) ?? new Map<string, Anchor[]>();
    this.anchors.set(tenantId, byThread);
    const previous = byThread.get(threadId);

    // An empty read of a thread that had messages a moment ago is a hiccup —
    // the page caught mid-render — far more often than a conversation that
    // genuinely lost all its messages. Recording it as the new anchor wipes out
    // a real one, and the next successful read then finds no anchor and reports
    // the entire visible history as new. `apps/ig-bridge` hit this live.
    if (current.length === 0) {
      if (previous && previous.length > 0) {
        this.log.warn({ tenantId, threadId }, 'fb-bridge: empty read of a known thread — keeping the last good anchor');
      }
      return [];
    }

    const asAnchors: Anchor[] = current.map((m) => ({
      id: m.externalMessageId, senderName: m.senderName, text: m.text,
    }));
    byThread.set(threadId, asAnchors);
    void this.persistAnchors(tenantId);

    // No anchor at all — the first time this thread has ever been read.
    // Reporting the whole visible history once is correct rather than noisy:
    // it is how a conversation that predates the connection reaches the CRM.
    if (!previous || previous.length === 0) return current;

    const everyCurrentHasId = current.every((m) => m.externalMessageId);
    const everyPreviousHasId = previous.every((m) => m.id);
    if (everyCurrentHasId && everyPreviousHasId) {
      const known = new Set(previous.map((m) => m.id));
      return current.filter((m) => !known.has(m.externalMessageId));
    }

    const anchor = previous[previous.length - 1]!;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const m = current[i]!;
      if (m.senderName === anchor.senderName && m.text === anchor.text) return current.slice(i + 1);
    }

    // The anchor is nowhere in this reading — it scrolled out of the rendered
    // window. Reporting only the newest message under-reports by a message or
    // two in that rare case, which beats replaying an entire conversation.
    this.log.warn({ tenantId, threadId }, 'fb-bridge: anchor not found in this read — reporting only the newest message');
    return current.slice(-1);
  }

  /* --------------------------------------------------------- transports */

  /**
   * Which surface this tenant's conversations are on.
   *
   * Decided by whether the connection carries a Business Suite asset id, which
   * is the one fact that distinguishes a Page connection from a personal one.
   * It is read from the connection rather than configured globally, because two
   * tenants on the same bridge can legitimately be on different surfaces.
   */
  private async transportFor(tenantId: string): Promise<{ transport: ThreadTransport; ctx: TransportContext }> {
    const marker = await this.sessions.getPageMarker(tenantId);
    const ctx: TransportContext = {
      pageName: marker?.pageName ?? null,
      assetId: marker?.assetId ?? null,
    };
    return { transport: ctx.assetId ? businessSuiteTransport : messengerDotComTransport, ctx };
  }

  private rememberContactName(tenantId: string, threadId: string, name: string): void {
    if (!name.trim()) return;
    const byThread = this.contactNames.get(tenantId) ?? new Map<string, string>();
    this.contactNames.set(tenantId, byThread);
    byThread.set(threadId, name.trim());
  }

  private contactNameFor(tenantId: string, threadId: string): string | null {
    return this.contactNames.get(tenantId)?.get(threadId) ?? null;
  }

  /**
   * The inbox reading, plus every thread this tenant has an anchor for.
   *
   * On a surface that cannot enumerate its conversations, an inbox reading
   * names at most the selected one. The anchors are the only record that the
   * others exist, so reconciliation has to start from their union — otherwise
   * a bridge that restarts reconciles whichever conversation happened to be
   * open and leaves every other one behind, permanently and silently.
   */
  private withKnownThreads(
    tenantId: string, rows: { threadId: string; name: string; signature: string }[],
  ): { threadId: string; name: string; signature: string }[] {
    const merged = new Map(rows.map((row) => [row.threadId, row]));
    for (const threadId of this.anchors.get(tenantId)?.keys() ?? []) {
      if (merged.has(threadId)) continue;
      merged.set(threadId, { threadId, name: this.contactNameFor(tenantId, threadId) ?? '', signature: '' });
    }
    return [...merged.values()];
  }

  private takeSeq(tenantId: string, threadId: string): number {
    const byThread = this.nextSeq.get(tenantId) ?? new Map<string, number>();
    this.nextSeq.set(tenantId, byThread);
    const seq = byThread.get(threadId) ?? 0;
    byThread.set(threadId, seq + 1);
    return seq;
  }

  private anchorFile(tenantId: string): string {
    return path.join(this.sessions.getProfileDir(tenantId), '.thread-anchors.json');
  }

  /**
   * Anchors survive a restart, which under `tsx watch` happens on every save.
   * Without this, every restart would forget every thread and re-ingest each
   * conversation's whole visible history as new.
   */
  async loadAnchors(tenantId: string): Promise<void> {
    if (this.anchors.has(tenantId)) return;
    try {
      const raw = await fs.readFile(this.anchorFile(tenantId), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, Anchor[]>;
      this.anchors.set(tenantId, new Map(Object.entries(parsed)));
    } catch {
      // Nothing persisted yet — the first read reports everything once, the
      // same as a thread genuinely seen for the first time.
    }
  }

  private async persistAnchors(tenantId: string): Promise<void> {
    const byThread = this.anchors.get(tenantId);
    if (!byThread) return;
    await fs.writeFile(this.anchorFile(tenantId), JSON.stringify(Object.fromEntries(byThread)), 'utf8')
      .catch(() => {});
  }

  /**
   * Turns a thrown error into the one thing an operator can act on.
   *
   * Session expiry and checkpoints stop the tenant outright and emit
   * `session_error`, because no amount of retrying fixes either — a person has
   * to log in or answer Facebook's prompt. Anything else is left to the next
   * reconciliation pass.
   */
  private reportFailure(tenantId: string, err: unknown): void {
    const needsLogin = err instanceof SessionExpiredError || err instanceof CheckpointRequiredError;
    if (!needsLogin) return;

    const error = (err as Error).message;
    this.sessions.forgetSession(tenantId, error);
    this.detach(tenantId);
    this.onEvent({ event: 'session_error', tenantId, at: new Date().toISOString(), error, needsLogin: true });
  }
}

/* ------------------------------------------------------------- page glue */

/**
 * Watches the inbox for changes instead of re-opening it on a timer — much
 * closer to a person leaving the tab open, and far more responsive than any
 * poll interval could be without looking like a script.
 *
 * Sent as a raw string rather than a function reference on purpose: `tsx`'s
 * dev-mode transform wraps named local functions in a `__name` helper that
 * exists only in this Node process, and `page.evaluate` serialises a function
 * argument with `.toString()` to run in the page's own context, where that
 * helper was never defined. `apps/ig-bridge` confirmed live that this breaks
 * message detection outright. A string literal is never touched by that
 * transform.
 *
 * Idempotent — re-injecting on a page that already has the observer is a no-op
 * rather than a second observer or a thrown "already exposed".
 */
export async function installInboxObserver(page: Page, onChange: () => void): Promise<void> {
  const callbackName = '__fbOnInboxChange';
  try {
    await page.exposeFunction(callbackName, () => onChange());
  } catch {
    // Already exposed on this page — expected on a self-heal re-injection.
  }

  await page.evaluate(`
    (function () {
      if (window.__fbObserverInstalled) return;
      window.__fbObserverInstalled = true;
      var timer = null;
      var observer = new MutationObserver(function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { window.${callbackName}(); }, ${OBSERVER_DEBOUNCE_MS});
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    })();
  `);
}
