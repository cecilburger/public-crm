import type { SessionManager } from './sessionManager.ts';
import {
  gotoInbox, installInboxObserver, discoverThreadId, readThreadMessages, acceptPendingRequests,
  isSessionExpiredError, type InboxThread,
} from './dmScraperPuppeteer.ts';

export type DmWatcherEvent =
  | {
      event: 'message'; tenantId: string;
      message: {
        threadId: string; participantUsername: string; senderUsername: string; text: string;
        direction: 'inbound' | 'outbound';
      };
    }
  | { event: 'session_error'; tenantId: string; error: string };

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
 * Every message the changed thread currently shows is re-emitted on each
 * change, not just the newest one — deliberately: there is no real
 * provider message id to key off while scraping, so `apps/api`'s webhook
 * route dedupes on a hash of (tenant, thread, sender, text) instead, and
 * expects to see the same message again on a later pass.
 */
export class DmWatcher {
  private observedTenants = new Set<string>();
  private knownThreadIds = new Map<string, Map<string, string>>();
  private lastSignatures = new Map<string, Map<string, string>>();
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
    const tenantIds = await this.sessions.knownTenantIds();
    for (const tenantId of tenantIds) {
      if (!this.observedTenants.has(tenantId)) {
        await this.attachTenant(tenantId).catch((err) =>
          this.log.warn({ err, tenantId }, 'ig-bridge: failed to attach tenant to dm watcher'));
      }
      // Requests never surface through the inbox observer (a separate tab
      // entirely) — checked once per housekeeping pass rather than its own
      // interval, since this cadence is already the "how often do we go
      // looking for things the observer can't see" knob.
      await this.checkRequests(tenantId).catch((err) =>
        this.log.warn({ err, tenantId }, 'ig-bridge: failed to check pending message requests'));
    }
  }

  /** Public so `main.ts` can attach a tenant immediately after a successful
   * login/challenge instead of waiting for the next housekeeping tick. */
  async attachTenant(tenantId: string): Promise<void> {
    if (this.observedTenants.has(tenantId)) return;
    const page = await this.sessions.getActivePage(tenantId);
    if (!page) return;

    this.observedTenants.add(tenantId);
    if (!this.knownThreadIds.has(tenantId)) this.knownThreadIds.set(tenantId, new Map());
    if (!this.lastSignatures.has(tenantId)) this.lastSignatures.set(tenantId, new Map());

    await gotoInbox(page);
    await installInboxObserver(page, (threads) => {
      void this.handleInboxChange(tenantId, threads).catch((err) =>
        this.log.warn({ err, tenantId }, 'ig-bridge: failed handling an inbox change'));
    });
    this.log.info({ tenantId }, 'ig-bridge: inbox observer attached');
  }

  private async handleInboxChange(tenantId: string, threads: InboxThread[]): Promise<void> {
    const signatures = this.lastSignatures.get(tenantId) ?? new Map<string, string>();
    this.lastSignatures.set(tenantId, signatures);

    for (const thread of threads) {
      if (signatures.get(thread.key) === thread.signature) continue;
      signatures.set(thread.key, thread.signature);
      await this.readChangedThread(tenantId, thread.key).catch((err) =>
        this.log.warn({ err, tenantId, key: thread.key }, 'ig-bridge: failed to read a changed thread'));
    }
  }

  private async resolveThreadId(tenantId: string, key: string): Promise<string | null> {
    const cache = this.knownThreadIds.get(tenantId) ?? new Map<string, string>();
    this.knownThreadIds.set(tenantId, cache);
    const cached = cache.get(key);
    if (cached) return cached;

    const page = await this.sessions.newPage(tenantId);
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
  markSentByUs(tenantId: string, threadId: string, text: string): void {
    const byThread = this.recentlySentByUs.get(tenantId) ?? new Map<string, { text: string; at: number }[]>();
    this.recentlySentByUs.set(tenantId, byThread);
    const list = byThread.get(threadId) ?? [];
    list.push({ text, at: Date.now() });
    byThread.set(threadId, list);
  }

  /** Consumes (at most once) a matching recent `markSentByUs` entry, so the
   * same console send can't absorb two separate phone-sent echoes later. */
  private consumeIfRecentlySentByUs(tenantId: string, threadId: string, text: string): boolean {
    const byThread = this.recentlySentByUs.get(tenantId);
    const list = byThread?.get(threadId);
    if (!list || list.length === 0) return false;

    const cutoff = Date.now() - RECENTLY_SENT_WINDOW_MS;
    const idx = list.findIndex((entry) => entry.text === text && entry.at >= cutoff);
    const fresh = list.filter((entry) => entry.at >= cutoff);
    if (idx === -1) {
      byThread!.set(threadId, fresh);
      return false;
    }
    byThread!.set(threadId, fresh.filter((entry) => !(entry.text === text && entry.at === list[idx]!.at)));
    return true;
  }

  private async readChangedThread(tenantId: string, key: string): Promise<void> {
    const threadId = await this.resolveThreadId(tenantId, key);
    if (!threadId) return;

    const ownUsername = await this.sessions.getOwnUsername(tenantId);
    const page = await this.sessions.newPage(tenantId);
    if (!page) return;
    try {
      const messages = await readThreadMessages(page, threadId);
      const contactMap = this.contactByThread.get(tenantId) ?? new Map<string, string>();
      this.contactByThread.set(tenantId, contactMap);

      // Learn (or refresh) this thread's contact identity from any inbound
      // message in this same batch before reporting anything, so an
      // outbound message later in the same batch can already use it.
      for (const message of messages) {
        const isOwn = ownUsername && message.senderUsername.toLowerCase() === ownUsername.toLowerCase();
        if (!isOwn) contactMap.set(threadId, message.senderUsername);
      }

      for (const message of messages) {
        const isOwn = ownUsername && message.senderUsername.toLowerCase() === ownUsername.toLowerCase();
        if (!isOwn) {
          this.onEvent({
            event: 'message', tenantId,
            message: {
              threadId, participantUsername: message.senderUsername, senderUsername: message.senderUsername,
              text: message.text, direction: 'inbound',
            },
          });
          continue;
        }

        // A console-driven send shows up here too on the next scrape —
        // recognised and absorbed rather than reported a second time.
        if (this.consumeIfRecentlySentByUs(tenantId, threadId, message.text)) continue;

        const participantUsername = contactMap.get(threadId);
        if (!participantUsername) continue; // never seen an inbound message on this thread — can't attribute it yet
        this.onEvent({
          event: 'message', tenantId,
          message: {
            threadId, participantUsername, senderUsername: message.senderUsername,
            text: message.text, direction: 'outbound',
          },
        });
      }
    } catch (err) {
      if (isSessionExpiredError(err)) {
        this.sessions.forgetSession(tenantId);
        this.observedTenants.delete(tenantId);
        this.onEvent({ event: 'session_error', tenantId, error: (err as Error).message });
      }
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async checkRequests(tenantId: string): Promise<void> {
    const page = await this.sessions.newPage(tenantId);
    if (!page) return;
    try {
      const acceptedKeys = await acceptPendingRequests(page);
      if (acceptedKeys.length) {
        this.log.info({ tenantId, count: acceptedKeys.length }, 'ig-bridge: accepted pending message requests');
      }
    } catch (err) {
      if (isSessionExpiredError(err)) {
        this.sessions.forgetSession(tenantId);
        this.observedTenants.delete(tenantId);
        this.onEvent({ event: 'session_error', tenantId, error: (err as Error).message });
      }
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  }
}
