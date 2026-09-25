import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer';
import type { SessionManager } from './sessionManager.ts';
import {
  gotoInbox, installInboxObserver, discoverThreadId, readThreadMessages, acceptPendingRequests,
  isSessionExpiredError, readInboxThreads, type InboxThread, type ScrapedMessage,
} from './dmScraperPuppeteer.ts';

export type DmWatcherEvent =
  | {
      event: 'message'; sessionKey: string;
      message: {
        threadId: string; participantUsername: string; senderUsername: string; text: string;
        direction: 'inbound' | 'outbound';
        /** A number that only ever goes up for a given thread, assigned by
         * `diffNewMessages` the moment a message is first recognised as
         * new — NOT its position in the DOM. Instagram's visible message
         * window doesn't always cover the same range of history on two
         * scrapes of the same thread, so a DOM-position index is unstable:
         * confirmed live, it made already-ingested messages reappear as
         * "new" whenever the visible window shifted. This counter is
         * stable because it is never recomputed from the DOM — only
         * handed out once per genuinely new message. The webhook route
         * hashes on (thread, sender, seq, text); without it, a repeated
         * short word ("halo", "oyy", ...) would hash identically to its
         * own earlier occurrence and be dropped as a false duplicate. */
        index: number;
      };
    }
  | { event: 'session_error'; sessionKey: string; error: string };

interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const HOUSEKEEPING_INTERVAL_MS = 10 * 60_000;
// How long a text sent through `markSentByUs` stays eligible to be matched
// against a scrape and silently absorbed — long enough to cover the delay
// between a send call returning and the next inbox-observer-triggered
// re-scan of that thread, short enough that a person genuinely re-sending
// the exact same words from their phone hours later is not mistaken for an
// echo of the earlier console send.
const RECENTLY_SENT_WINDOW_MS = 5 * 60_000;

/**
 * One long-lived page per tenant sits on `/direct/inbox/` forever with
 * `installInboxObserver`'s `MutationObserver` watching it — a row's `key`
 * changing signature is the only signal this watcher acts on. Reading the
 * changed thread and resolving a `key` to a real thread id both happen on a
 * short-lived fresh tab instead, so neither disturbs the long-lived
 * observer page (re-navigating it would tear the observer down).
 *
 * Each changed thread is diffed against the last full read of it
 * (`diffNewMessages`) so only genuinely new messages are ever emitted —
 * there is no real provider message id to key off while scraping, so
 * re-emitting the whole visible history on every change (the original
 * design here) relied entirely on downstream content hashing to catch
 * repeats, which broke in two different ways confirmed live: a person
 * repeating a short word ("halo", "oyy", ...) hashed identically to their
 * own earlier message and vanished as a false duplicate, and Instagram's
 * visible message window doesn't always cover the same range of history
 * between scrapes, so already-ingested messages could resurface as
 * "new". Diffing against a remembered anchor sidesteps both.
 */
export class DmWatcher {
  private observedTenants = new Set<string>();
  private knownThreadIds = new Map<string, Map<string, string>>();
  private lastSignatures = new Map<string, Map<string, string>>();
  // threadId -> the full message list as last scraped, oldest first — the
  // anchor `diffNewMessages` diffs the next scrape against.
  private lastMessageList = new Map<string, Map<string, { senderUsername: string; text: string }[]>>();
  // threadId -> next sequence number to hand out — see `DmWatcherEvent`.
  private nextSeq = new Map<string, Map<string, number>>();
  private housekeepingTimer: NodeJS.Timeout | null = null;
  // threadId -> the last-known contact identity for that thread, learned
  // from any inbound message seen there. An outbound (own) message carries
  // no recipient of its own in the DOM — a 1:1 DM's sender label is the only
  // identity Instagram exposes per bubble — so this is the only way to
  // attribute a self-sent message to a contact when the batch that reveals
  // it contains no inbound message to read the identity off directly.
  private contactByThread = new Map<string, Map<string, string>>();
  // threadId -> texts this process itself sent through `sendDm`, each
  // eligible once to be matched against a later scrape and absorbed rather
  // than re-reported — see `markSentByUs`.
  private recentlySentByUs = new Map<string, Map<string, { text: string; at: number }[]>>();
  // sessionKey -> the tail of this tenant's own processing queue. The
  // client-side observer debounces to one `scan()` per 1.5s of quiet, but
  // says nothing about how long *our* side takes to act on it — a scan
  // whose `handleInboxChange` is still mid-`readChangedThread` (a page
  // navigation, up to several seconds) when the next debounced scan lands
  // used to start a second, fully concurrent `handleInboxChange` on the
  // same tenant. Two concurrent reads of the same thread race on the same
  // anchor in `diffNewMessages` — confirmed live as both the "empty
  // scrape" spam (one read catches the thread page mid-navigation from the
  // other) and messages reported twice (each read computing its own
  // "what's new" against a `prev` the other hadn't finished updating yet).
  // Chaining every call for a tenant onto this promise makes them run one
  // at a time, same tenant, no exceptions.
  private processingChain = new Map<string, Promise<void>>();
  // sessionKey -> the long-lived page the inbox observer is installed on.
  // Kept so housekeeping can ping it directly — the whole-browser
  // `isConnected()` check doesn't catch this one dying on its own (its
  // renderer crashing or getting reclaimed under memory pressure while the
  // rest of the browser, and every short-lived tab `newPage()` opens for a
  // send or a read, stays completely fine). Confirmed live: a real message
  // sitting right there on Instagram's own page never reached the CRM
  // because this one tab had gone quiet — no error anywhere, since nothing
  // was polling it to notice.
  private observerPages = new Map<string, Page>();

  constructor(
    private sessions: SessionManager,
    private onEvent: (ev: DmWatcherEvent) => void,
    private log: Logger,
  ) {}

  start(): void {
    void this.housekeeping();
    this.housekeepingTimer = setInterval(() => void this.housekeeping(), HOUSEKEEPING_INTERVAL_MS);
  }

  stop(): void {
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
  }

  private async housekeeping(): Promise<void> {
    const sessionKeys = await this.sessions.knownSessionKeys();
    for (const sessionKey of sessionKeys) {
      // A tenant marked "observed" sat on a browser whose CDP connection has
      // since died (crash, or the connection just dropped) — its inbox
      // `MutationObserver` died with that browser. `ensureBrowser` on the
      // session side already self-heals the browser itself on the next
      // `newPage()` call, but nothing makes a *new* observer land on the
      // *new* browser's page without this: `observedTenants` would keep
      // this tenant marked attached forever, so `attachTenant` below would
      // never run again and inbound messages would stay silently stuck.
      if (this.observedTenants.has(sessionKey) && !this.sessions.isConnected(sessionKey)) {
        this.log.warn({ sessionKey }, 'ig-bridge: observed tenant\'s browser connection died — re-attaching');
        this.observedTenants.delete(sessionKey);
        this.observerPages.delete(sessionKey);
      }
      // The browser-level check above only catches the *whole* browser
      // dying. The observer's own tab can go quiet on its own — its
      // renderer crashing, or getting reclaimed under memory pressure —
      // while the browser and every other tab stay completely healthy, so
      // `isConnected()` alone sees nothing wrong. A real message can then
      // sit visible on Instagram's own page indefinitely, never read,
      // with no error anywhere to notice by. A cheap ping catches that: a
      // hung or crashed page either rejects or never resolves, so it's
      // raced against a short timeout rather than trusted to reject on
      // its own.
      if (this.observedTenants.has(sessionKey)) {
        const page = this.observerPages.get(sessionKey);
        const alive = page && !page.isClosed() && await Promise.race([
          page.evaluate('1').then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ]).catch(() => false);
        if (!alive) {
          this.log.warn({ sessionKey }, 'ig-bridge: observed tenant\'s inbox tab went unresponsive — re-attaching');
          this.observedTenants.delete(sessionKey);
          this.observerPages.delete(sessionKey);
        } else if (page) {
          // The liveness ping above only proves the page can still run
          // arbitrary JS — it says nothing about whether the `MutationObserver`
          // installed on it is still actually firing. Confirmed live: a page
          // that passed this exact ping every 10 minutes for over an hour
          // still had a real inbound message sitting unreported the whole
          // time, no error anywhere. `readInboxThreads` reads the thread list
          // directly, the same way the observer's own `scan()` would, and
          // `handleInboxChange` already dedupes against `lastSignatures` — so
          // this is a no-op on every cycle the observer *did* keep up, and
          // the one catch that matters on a cycle it silently didn't.
          await this.readInboxThreadsAndReconcile(sessionKey, page).catch((err) =>
            this.log.warn({ err, sessionKey }, 'ig-bridge: fallback inbox poll failed'));
        }
      }
      if (!this.observedTenants.has(sessionKey)) {
        await this.attachTenant(sessionKey).catch((err) =>
          this.log.warn({ err, sessionKey }, 'ig-bridge: failed to attach tenant to dm watcher'));
      }
      // Requests never surface through the inbox observer (a separate tab
      // entirely) — checked once per housekeeping pass rather than its own
      // interval, since this cadence is already the "how often do we go
      // looking for things the observer can't see" knob.
      await this.checkRequests(sessionKey).catch((err) =>
        this.log.warn({ err, sessionKey }, 'ig-bridge: failed to check pending message requests'));
    }
  }

  /** Public so `main.ts` can attach a tenant immediately after a successful
   * login/challenge instead of waiting for the next housekeeping tick. */
  async attachTenant(sessionKey: string): Promise<void> {
    if (this.observedTenants.has(sessionKey)) return;
    // Reserved *before* the first await, not after — `getActivePage` below
    // can take a while (launching a browser), and a second caller for the
    // same tenant (the startup housekeeping pass racing a fresh `/login`
    // call, say) would otherwise pass this same `has()` check while the
    // first call is still mid-flight, then both go on to navigate and
    // install an observer on the same page: two `MutationObserver`s firing
    // on every mutation, reporting every change twice over. Confirmed live
    // by a flood of paired-duplicate webhook events.
    this.observedTenants.add(sessionKey);

    const page = await this.sessions.getActivePage(sessionKey);
    if (!page) {
      this.observedTenants.delete(sessionKey); // nothing attached — a later real attempt should still be allowed to try
      return;
    }

    if (!this.knownThreadIds.has(sessionKey)) this.knownThreadIds.set(sessionKey, new Map());
    if (!this.lastSignatures.has(sessionKey)) this.lastSignatures.set(sessionKey, new Map());
    if (!this.lastMessageList.has(sessionKey)) await this.loadAnchors(sessionKey);

    // `gotoInbox` throws `SessionExpiredError` when the session it just
    // resumed turns out to be dead — confirmed live, left uncaught here
    // this permanently stuck `observedTenants` on this tenant: every retry
    // after that (a fresh login included) saw it already marked attached
    // by the *failed* attempt above and silently did nothing, forever,
    // until the whole process was restarted. A tenant that fails to
    // attach must be allowed to try again on the very next call.
    try {
      await gotoInbox(page);
      await installInboxObserver(page, (threads) => {
        const prior = this.processingChain.get(sessionKey) ?? Promise.resolve();
        const next = prior
          .then(() => this.handleInboxChange(sessionKey, threads))
          .catch((err) => this.log.warn({ err, sessionKey }, 'ig-bridge: failed handling an inbox change'));
        this.processingChain.set(sessionKey, next);
      });
      this.observerPages.set(sessionKey, page);
      this.log.info({ sessionKey }, 'ig-bridge: inbox observer attached');
    } catch (err) {
      this.observedTenants.delete(sessionKey);
      this.observerPages.delete(sessionKey);
      if (isSessionExpiredError(err)) {
        this.sessions.forgetSession(sessionKey);
        this.onEvent({ event: 'session_error', sessionKey, error: (err as Error).message });
      }
      throw err;
    }
  }

  /** Housekeeping's poll-based backstop for `handleInboxChange` — same
   * dedup, same downstream path, just sourced from a direct read instead of
   * the observer's callback. Chained onto `processingChain` too, so a poll
   * landing mid-observer-callback (or the reverse) reads and writes
   * `lastSignatures` one at a time rather than racing it. */
  private async readInboxThreadsAndReconcile(sessionKey: string, page: Page): Promise<void> {
    const threads = await readInboxThreads(page);
    const prior = this.processingChain.get(sessionKey) ?? Promise.resolve();
    const next = prior.then(() => this.handleInboxChange(sessionKey, threads));
    this.processingChain.set(sessionKey, next);
    await next;
  }

  private async handleInboxChange(sessionKey: string, threads: InboxThread[]): Promise<void> {
    const signatures = this.lastSignatures.get(sessionKey) ?? new Map<string, string>();
    this.lastSignatures.set(sessionKey, signatures);

    for (const thread of threads) {
      if (signatures.get(thread.key) === thread.signature) continue;
      signatures.set(thread.key, thread.signature);
      await this.readChangedThread(sessionKey, thread.key).catch((err) =>
        this.log.warn({ err, sessionKey, key: thread.key }, 'ig-bridge: failed to read a changed thread'));
    }
  }

  private async resolveThreadId(sessionKey: string, key: string): Promise<string | null> {
    const cache = this.knownThreadIds.get(sessionKey) ?? new Map<string, string>();
    this.knownThreadIds.set(sessionKey, cache);
    const cached = cache.get(key);
    if (cached) return cached;

    const page = await this.sessions.newPage(sessionKey);
    if (!page) return null;
    try {
      const id = await discoverThreadId(page, key);
      if (id) cache.set(key, id);
      return id;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Called right after `sessionManager.sendDm` succeeds for a console-driven
   * reply — lets a later scrape of this thread recognise that exact text as
   * one it already knows about (see `consumeIfRecentlySentByUs`) instead of
   * reporting it a second time as though it had just arrived from the phone.
   */
  markSentByUs(sessionKey: string, threadId: string, text: string): void {
    const byThread = this.recentlySentByUs.get(sessionKey) ?? new Map<string, { text: string; at: number }[]>();
    this.recentlySentByUs.set(sessionKey, byThread);
    const list = byThread.get(threadId) ?? [];
    list.push({ text, at: Date.now() });
    byThread.set(threadId, list);
    this.persistRecentlySentByUs(sessionKey);
  }

  /** Consumes (at most once) a matching recent `markSentByUs` entry, so the
   * same console send can't absorb two separate phone-sent echoes later. */
  private consumeIfRecentlySentByUs(sessionKey: string, threadId: string, text: string): boolean {
    const byThread = this.recentlySentByUs.get(sessionKey);
    const list = byThread?.get(threadId);
    if (!list || list.length === 0) return false;

    const cutoff = Date.now() - RECENTLY_SENT_WINDOW_MS;
    const idx = list.findIndex((entry) => entry.text === text && entry.at >= cutoff);
    const fresh = list.filter((entry) => entry.at >= cutoff);
    if (idx === -1) {
      byThread!.set(threadId, fresh);
      this.persistRecentlySentByUs(sessionKey);
      return false;
    }
    byThread!.set(threadId, fresh.filter((entry) => !(entry.text === text && entry.at === list[idx]!.at)));
    this.persistRecentlySentByUs(sessionKey);
    return true;
  }

  private anchorsFile(sessionKey: string): string {
    return path.join(this.sessions.getProfileDir(sessionKey), '.thread-anchors.json');
  }

  private recentlySentFile(sessionKey: string): string {
    return path.join(this.sessions.getProfileDir(sessionKey), '.recently-sent-by-us.json');
  }

  /**
   * Kept across restarts for the same reason the anchors are — the window
   * is only 5 minutes long anyway, so this is a small, short-lived file, but
   * without it a restart mid-window (routine under `tsx watch`) wipes the
   * "we just sent this through the console" memory entirely. The very next
   * scrape then reads that same send as a fresh reply from the phone and
   * records it a second time — confirmed live, right after an `ig-bridge`
   * restart during this session, as a duplicate "Anda / Tim" bubble sitting
   * next to the real "Dijawab Otomatis" one for the exact same reply.
   */
  private async loadRecentlySentByUs(sessionKey: string): Promise<void> {
    try {
      const raw = await fs.readFile(this.recentlySentFile(sessionKey), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, { text: string; at: number }[]>;
      const cutoff = Date.now() - RECENTLY_SENT_WINDOW_MS;
      const fresh = new Map(
        Object.entries(parsed).map(([threadId, list]) => [threadId, list.filter((e) => e.at >= cutoff)]),
      );
      this.recentlySentByUs.set(sessionKey, fresh);
    } catch {
      // No persisted entries yet.
    }
  }

  private persistRecentlySentByUs(sessionKey: string): void {
    const byThread = this.recentlySentByUs.get(sessionKey);
    if (!byThread) return;
    void fs.writeFile(this.recentlySentFile(sessionKey), JSON.stringify(Object.fromEntries(byThread)), 'utf8')
      .catch(() => {});
  }

  /** Loaded once per tenant, right before the observer starts scanning —
   * without this, every `ig-bridge` restart (routine under `tsx watch`,
   * which fires on every save) would forget every thread's anchor and
   * `diffNewMessages` would treat the whole visible history as new again,
   * re-ingesting it. Best-effort: a missing or unreadable file just means
   * the very first scan after this attach reports everything once, same
   * as a thread this tenant has genuinely never had attached before. */
  private async loadAnchors(sessionKey: string): Promise<void> {
    try {
      const raw = await fs.readFile(this.anchorsFile(sessionKey), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, { senderUsername: string; text: string }[]>;
      this.lastMessageList.set(sessionKey, new Map(Object.entries(parsed)));
    } catch {
      // No persisted anchors yet.
    }
    await this.loadSequences(sessionKey);
    await this.loadRecentlySentByUs(sessionKey);
  }

  private sequencesFile(sessionKey: string): string {
    return path.join(this.sessions.getProfileDir(sessionKey), '.thread-sequences.json');
  }

  /**
   * The counter that makes a repeated message distinguishable, kept across
   * restarts for the same reason the anchors are.
   *
   * It was held only in memory, so every restart handed the next message
   * index 0 again — and the webhook keys on
   * `(thread, sender, index, text)`. The first message after a restart
   * therefore hashed identically to the first one ever ingested from that
   * person in that thread, and was dropped as a duplicate. Confirmed live:
   * three messages in a row vanished this way, each one posted by the bridge
   * and silently discarded by the API, with nothing anywhere saying so.
   */
  private async loadSequences(sessionKey: string): Promise<void> {
    try {
      const raw = await fs.readFile(this.sequencesFile(sessionKey), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, number>;
      this.nextSeq.set(sessionKey, new Map(Object.entries(parsed)));
    } catch {
      // No persisted sequences yet.
    }
  }

  private persistAnchors(sessionKey: string): void {
    const byThread = this.lastMessageList.get(sessionKey);
    if (!byThread) return;
    void fs.writeFile(this.anchorsFile(sessionKey), JSON.stringify(Object.fromEntries(byThread)), 'utf8').catch(() => {});

    const seqs = this.nextSeq.get(sessionKey);
    if (seqs) {
      void fs.writeFile(this.sequencesFile(sessionKey), JSON.stringify(Object.fromEntries(seqs)), 'utf8').catch(() => {});
    }
  }

  /**
   * Diffs this scrape's full message list against the last one read for
   * this thread, returning only what's genuinely new since — anchored on
   * the previously-last-known message rather than on raw position, so a
   * shift in which range of history Instagram happens to have rendered
   * this time doesn't make old messages look new again. If that anchor
   * message isn't found at all (it scrolled out of the loaded range, or
   * this is the first read of the thread), falls back to treating only
   * the single newest message as new — under-reporting by a message or
   * two in that rare case beats flooding the thread with its entire
   * visible history again.
   */
  private diffNewMessages(
    sessionKey: string, threadId: string, current: { senderUsername: string; text: string }[],
  ): { senderUsername: string; text: string }[] {
    const byThread = this.lastMessageList.get(sessionKey) ?? new Map<string, { senderUsername: string; text: string }[]>();
    this.lastMessageList.set(sessionKey, byThread);
    const prev = byThread.get(threadId);

    // Confirmed live: `readThreadMessages` occasionally comes back empty on
    // a transient scrape failure (the thread page caught mid-render, most
    // often right after this same thread was just navigated to for a
    // send). Recording that as the new anchor wiped out a real, populated
    // one — the very next successful scrape then found no anchor at all
    // and reported the thread's entire visible history as new. An empty
    // scrape is far more likely a hiccup than a thread that just lost all
    // its messages, so it leaves the last good anchor alone rather than
    // overwriting it, and is treated as "nothing new" either way.
    if (current.length === 0) {
      if (prev && prev.length > 0) {
        this.log.warn({ threadId }, 'ig-bridge: empty scrape of a known thread — keeping the last good anchor');
      }
      return [];
    }

    byThread.set(threadId, current);
    this.persistAnchors(sessionKey);

    // No prior anchor at all — genuinely the first time this thread has
    // ever been read (or `loadAnchors` found nothing persisted for it
    // either). Reporting the full visible history once here is correct,
    // not noise: it's how a conversation that already existed before this
    // tenant was first attached ever reaches the CRM at all.
    if (!prev) {
      this.log.warn({ threadId, currentLen: current.length }, 'ig-bridge DEBUG: diffNewMessages — no prior anchor, reporting everything');
      return current;
    }

    const anchor = prev[prev.length - 1];
    if (!anchor) {
      this.log.warn({ threadId }, 'ig-bridge DEBUG: diffNewMessages — prev array empty');
      return current;
    }

    // Matching on the last known message alone cannot tell that message apart
    // from an identical one sent right after it — and people repeat
    // themselves constantly ("halo", "iya", "ok"). Confirmed live: a second
    // "Halo kak" from the same person was swallowed, because the backwards
    // scan found the *new* message first and read it as the anchor, so
    // "everything after the anchor" was nothing at all.
    //
    // A short run of trailing messages is matched instead. Repeated text
    // stops being ambiguous once what came before it has to line up too, and
    // scanning from the end still prefers the most recent position — which is
    // what keeps an old, long-scrolled-past repeat of the same words from
    // re-reporting a whole thread.
    const tail = prev.slice(-Math.min(prev.length, 3));
    const same = (a: ScrapedMessage, b: ScrapedMessage) =>
      a.senderUsername === b.senderUsername && a.text === b.text;

    for (let end = current.length - 1; end >= tail.length - 1; end--) {
      let matched = true;
      for (let k = 0; k < tail.length; k++) {
        if (!same(current[end - tail.length + 1 + k]!, tail[k]!)) { matched = false; break; }
      }
      if (matched) return current.slice(end + 1);
    }

    this.log.warn(
      { threadId, anchor, currentTail: current.slice(-3) },
      'ig-bridge DEBUG: diffNewMessages — anchor not found in current scrape',
    );
    return current.length > 0 ? [current[current.length - 1]!] : [];
  }

  private nextSequenceFor(sessionKey: string, threadId: string): number {
    const byThread = this.nextSeq.get(sessionKey) ?? new Map<string, number>();
    this.nextSeq.set(sessionKey, byThread);
    const seq = byThread.get(threadId) ?? 0;
    byThread.set(threadId, seq + 1);
    return seq;
  }

  private async readChangedThread(sessionKey: string, key: string): Promise<void> {
    const threadId = await this.resolveThreadId(sessionKey, key);
    if (!threadId) return;

    const ownUsername = await this.sessions.getOwnUsername(sessionKey);
    const page = await this.sessions.newPage(sessionKey);
    if (!page) return;
    try {
      const messages = await readThreadMessages(page, threadId);
      const contactMap = this.contactByThread.get(sessionKey) ?? new Map<string, string>();
      this.contactByThread.set(sessionKey, contactMap);

      // Learn (or refresh) this thread's contact identity from every
      // currently-visible inbound message, not just the new ones — keeps
      // this correct even on a pass where only an outbound message is new.
      for (const message of messages) {
        const isOwn = ownUsername && message.senderUsername.toLowerCase() === ownUsername.toLowerCase();
        if (!isOwn) contactMap.set(threadId, message.senderUsername);
      }

      const freshMessages = this.diffNewMessages(sessionKey, threadId, messages);
      for (const message of freshMessages) {
        const isOwn = ownUsername && message.senderUsername.toLowerCase() === ownUsername.toLowerCase();
        if (!isOwn) {
          this.onEvent({
            event: 'message', sessionKey,
            message: {
              threadId, participantUsername: message.senderUsername, senderUsername: message.senderUsername,
              text: message.text, direction: 'inbound', index: this.nextSequenceFor(sessionKey, threadId),
            },
          });
          continue;
        }

        // A console-driven send shows up here too on the next scrape —
        // recognised and absorbed rather than reported a second time.
        if (this.consumeIfRecentlySentByUs(sessionKey, threadId, message.text)) continue;

        const participantUsername = contactMap.get(threadId);
        if (!participantUsername) continue; // never seen an inbound message on this thread — can't attribute it yet
        this.onEvent({
          event: 'message', sessionKey,
          message: {
            threadId, participantUsername, senderUsername: message.senderUsername,
            text: message.text, direction: 'outbound', index: this.nextSequenceFor(sessionKey, threadId),
          },
        });
      }
    } catch (err) {
      if (isSessionExpiredError(err)) {
        this.sessions.forgetSession(sessionKey);
        this.observedTenants.delete(sessionKey);
        this.onEvent({ event: 'session_error', sessionKey, error: (err as Error).message });
      }
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async checkRequests(sessionKey: string): Promise<void> {
    const page = await this.sessions.newPage(sessionKey);
    if (!page) return;
    try {
      const acceptedKeys = await acceptPendingRequests(page);
      if (acceptedKeys.length) {
        this.log.info({ sessionKey, count: acceptedKeys.length }, 'ig-bridge: accepted pending message requests');
      }
    } catch (err) {
      if (isSessionExpiredError(err)) {
        this.sessions.forgetSession(sessionKey);
        this.observedTenants.delete(sessionKey);
        this.onEvent({ event: 'session_error', sessionKey, error: (err as Error).message });
      }
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
