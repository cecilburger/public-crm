import type { SessionManager } from './sessionManager.ts';
import { readRecentComments, ThrottledError, type ScrapedComment } from './commentScraper.ts';
import { isSessionExpiredError } from './dmScraperPuppeteer.ts';

export interface IgCommentEvent {
  event: 'comment';
  sessionKey: string;
  comment: {
    postRef: string; commentRef: string; commenter: string; text: string; at: string;
    parentRef: string | null;
  };
}

interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MAX_INTERVAL_MS = 60 * 60_000;
// The first look after a start is much sooner than the steady cadence, but
// not immediate. Waiting a full interval means a restart leaves comments
// that already exist invisible for five minutes, which reads as "the feature
// is broken" — while polling the instant the process boots would hammer
// Instagram once per save under `tsx watch`.
const FIRST_POLL_DELAY_MS = 60_000;

/**
 * Comments arrive by polling, not by watching.
 *
 * DMs get a `MutationObserver` on a page that stays open, because the inbox
 * is one page that changes in place. Posts are not: there is no single page
 * that shows every comment on every post, so seeing them means going and
 * looking. Every look is a request against an account Instagram has already
 * throttled once, so this is deliberately slow and gets slower when told to
 * back off. A comment that waits five minutes is fine; a session that gets
 * locked out is not.
 *
 * Nothing is remembered between polls on purpose. The webhook keys on
 * `(tenant, commentRef)` and drops anything it has already spooled, so the
 * same comment being read on every cycle is a no-op after the first — which
 * makes this watcher stateless, and therefore correct across restarts
 * without persisting anything of its own.
 */
export class CommentWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private first = true;
  private interval: number;

  constructor(
    private sessions: SessionManager,
    private emit: (event: IgCommentEvent) => void,
    private log: Logger,
    intervalMs = Number(process.env.IG_COMMENT_POLL_MS ?? DEFAULT_INTERVAL_MS),
  ) {
    this.interval = Math.max(60_000, intervalMs);
  }

  start(): void {
    if (this.timer) return;
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    const delay = this.first ? FIRST_POLL_DELAY_MS : this.interval;
    this.first = false;
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => {
        if (this.timer) this.schedule();
      });
    }, delay);
    // Never let an idle poller hold the process open on its own.
    this.timer.unref?.();
  }

  /** Public so a restart can take one look immediately rather than waiting
   * out a full interval first. */
  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const sessionKey of await this.sessions.knownSessionKeys()) {
        await this.pollTenant(sessionKey);
      }
    } finally {
      this.running = false;
    }
  }

  private async pollTenant(sessionKey: string): Promise<void> {
    const ownUsername = await this.sessions.getOwnUsername(sessionKey);
    if (!ownUsername) return;

    const page = await this.sessions.newPage(sessionKey);
    if (!page) return;

    try {
      const comments = await readRecentComments(page, ownUsername);
      for (const comment of comments) this.emit(toEvent(sessionKey, comment));
      if (comments.length > 0) {
        this.log.info({ sessionKey, count: comments.length }, 'ig-bridge read comments');
      }
      // A clean pass earns back the normal cadence after a back-off.
      this.interval = Math.max(60_000, Number(process.env.IG_COMMENT_POLL_MS ?? DEFAULT_INTERVAL_MS));
    } catch (err) {
      if (err instanceof ThrottledError) {
        this.interval = Math.min(this.interval * 2, MAX_INTERVAL_MS);
        this.log.warn({ sessionKey, nextPollMs: this.interval }, 'ig-bridge throttled reading comments — backing off');
        return;
      }
      // A dead session is the DM watcher's to notice and report: it is the
      // one that can tell a login redirect apart from a bad read, and it
      // owns the `session_error` event the console reacts to. Saying so
      // from here would race it and, worse, tear down a session over a
      // comment read — which it once did.
      if (isSessionExpiredError(err)) {
        this.log.warn({ sessionKey }, 'ig-bridge: session looks expired while reading comments');
        return;
      }
      this.log.warn({ err, sessionKey }, 'ig-bridge could not read comments');
    } finally {
      await page.close().catch(() => {});
    }
  }
}

function toEvent(sessionKey: string, comment: ScrapedComment): IgCommentEvent {
  return {
    event: 'comment',
    sessionKey,
    comment: {
      postRef: comment.postRef,
      commentRef: comment.commentRef,
      commenter: comment.username,
      text: comment.text,
      at: comment.createdAt,
      parentRef: comment.parentRef,
    },
  };
}
