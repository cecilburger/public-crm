import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMENTS, URLS } from './selectors.ts';
import { parseFacebookComments } from './parsers/comments.ts';
import { readContainerHtml, type Logger } from './messengerWatcher.ts';
import { readPostSurfaceHtml } from './pageHtml.ts';
import { CheckpointRequiredError, SessionExpiredError, type SessionManager } from './sessionManager.ts';
import type { FbBridgeEvent } from './events.ts';

/**
 * How often a Page's own posts are swept for new comments.
 *
 * There is no equivalent of the inbox `MutationObserver` here, and that is a
 * property of the surface rather than a shortcut: comments live under posts in
 * a feed, not in one container a person leaves open, so watching them
 * continuously would mean holding a tab per post. A conservative sweep is the
 * honest design — fifteen minutes is roughly how often a person actually checks
 * their Page, and polling harder than that is the surest way to get an account
 * flagged for no benefit.
 */
const SWEEP_INTERVAL_MS = 15 * 60_000;
/** How many of a Page's newest posts are re-read in full on each sweep. */
const POSTS_PER_SWEEP = 3;
/** How long a post's comments get to render before it is read. */
const COMMENT_RENDER_MS = 12_000;

/** How many comment ids to keep per tenant. Comments arrive on old posts as
 * well as new ones, so this has to cover more than one sweep's worth — but it
 * is only an optimisation. The real idempotency barrier is the unique index on
 * `(tenant_id, comment_id)` in the CRM, which holds even if this forgets. */
const SEEN_LIMIT = 5_000;

/**
 * Pulls inbound comments off a tenant's Facebook Page.
 *
 * INBOUND ONLY, AND INERT. This reads and reports. It does not reply, does not
 * like, does not message the commenter, does not move anyone to WhatsApp, and
 * does not involve a chatbot. Those are separate features that do not exist
 * yet, and nothing here is wired to make them easy to switch on by accident.
 *
 * Comments are reported as their own kind of event, never as messages — a
 * comment belongs to a post and is public, a DM belongs to a conversation and
 * is not, and collapsing the two would put every commenter into the reply
 * inbox and bill them as a conversation window.
 */
export class CommentWatcher {
  private seen = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(
    private sessions: SessionManager,
    private onEvent: (ev: FbBridgeEvent) => void,
    private log: Logger,
  ) {}

  start(): void {
    void this.sweepAll();
    this.timer = setInterval(() => void this.sweepAll(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweepAll(): Promise<void> {
    for (const tenantId of await this.sessions.knownTenantIds()) {
      await this.sweep(tenantId).catch((err) =>
        this.log.warn({ err, tenantId }, 'fb-bridge: comment sweep failed'));
    }
  }

  /**
   * One pass over a tenant's Page.
   *
   * Guarded against overlap: a sweep that runs long (a slow feed, a wedged tab)
   * must not have the next interval start a second one beside it, both reading
   * the same feed and both deciding the same comment is new.
   */
  async sweep(tenantId: string): Promise<void> {
    if (this.running.has(tenantId)) return;
    const marker = await this.sessions.getPageMarker(tenantId);
    if (!marker) return;

    this.running.add(tenantId);
    const page = await this.sessions.newPage(tenantId);
    if (!page) {
      this.running.delete(tenantId);
      return;
    }

    try {
      await page.goto(URLS.pagePosts(marker.pageId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.sessions.assertUsable(page);

      // `assertUsable` only proves the BODY has some text — the header, the
      // nav, the sidebar — which paints well before the feed's own GraphQL
      // fetch resolves. Reading the feed immediately after it, on a browser
      // that has just launched with no warm cache, found zero posts: not
      // because there were none, but because the feed had not rendered yet.
      // Confirmed live, on the very first sweep after every cold start.
      await page.waitForSelector(COMMENTS.post.join(', '), { timeout: COMMENT_RENDER_MS }).catch(() => {});

      const html = await readContainerHtml(page, COMMENTS.feed);
      if (!html) {
        this.log.warn({ tenantId }, 'fb-bridge: page feed container not found — COMMENTS.feed may be stale');
        return;
      }

      const parsed = parseFacebookComments(html);
      const found = new Map(parsed.comments.map((comment) => [comment.commentId, comment]));

      // The timeline is a summary, not the comments. It renders the first one
      // or two under each post and hides the rest behind "View more comments",
      // so reading it alone misses comments silently — confirmed live. Each
      // recent post is therefore opened on its own permalink, where the whole
      // thread is rendered. Bounded, because a Page's history is not: only the
      // newest posts are worth re-reading every sweep, and anything older is
      // reached the same way the first time it appears.
      for (const postId of parsed.postIds.slice(0, POSTS_PER_SWEEP)) {
        await page.goto(URLS.postPermalink(marker.pageId, postId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // `domcontentloaded` is the document, not the comments: they are
        // rendered afterwards, and a read taken straight after the navigation
        // came back with whatever the timeline already had — which looked
        // exactly like a post with nothing new on it. Waited for, not slept
        // through, so a post that genuinely has no comments costs the timeout
        // once rather than a fixed delay every sweep.
        await page.waitForSelector(COMMENTS.comment.join(', '), { timeout: COMMENT_RENDER_MS }).catch(() => {});
        const postHtml = await readPostSurfaceHtml(page, postId);
        if (!postHtml) {
          this.log.warn(
            { tenantId, postId },
            'fb-bridge: target post surface not found — refusing background feed fallback',
          );
          continue;
        }
        for (const comment of parseFacebookComments(postHtml, { defaultPostId: postId }).comments) {
          if (comment.postId !== postId) {
            this.log.warn(
              { tenantId, expectedPostId: postId, parsedPostId: comment.postId, commentId: comment.commentId },
              'fb-bridge: comment surface contained a different post — dropped',
            );
            continue;
          }
          found.set(comment.commentId, comment);
        }
      }

      if (parsed.droppedNoId > 0) {
        // Loud rather than silent: a comment with no readable id has no
        // idempotency key, so it is dropped instead of being re-ingested on
        // every sweep. All of them being dropped means the selectors moved.
        this.log.warn(
          { tenantId, dropped: parsed.droppedNoId, matched: parsed.matchedComments },
          'fb-bridge: comments dropped for having no readable id — COMMENTS.permalink may be stale',
        );
      }

      const seen = await this.loadSeen(tenantId);
      let fresh = 0;
      for (const comment of found.values()) {
        if (seen.has(comment.commentId)) continue;
        seen.add(comment.commentId);
        fresh += 1;
        this.onEvent({
          event: 'comment',
          tenantId,
          at: new Date().toISOString(),
          comment: { ...comment, pageId: marker.pageId, pageName: marker.pageName },
        });
      }
      // Logged every sweep, not only when something is new. A sweep that finds
      // nothing and says nothing is indistinguishable from a sweep that never
      // ran or one whose selectors have gone stale, and this service has been
      // all three.
      this.log.info(
        { tenantId, posts: parsed.postIds.length, read: found.size, fresh },
        'fb-bridge: page comments swept',
      );
      if (fresh > 0) await this.persistSeen(tenantId, seen);
    } catch (err) {
      const needsLogin = err instanceof SessionExpiredError || err instanceof CheckpointRequiredError;
      if (needsLogin) {
        const error = (err as Error).message;
        this.sessions.forgetSession(tenantId, error);
        this.onEvent({ event: 'session_error', tenantId, at: new Date().toISOString(), error, needsLogin: true });
      }
      throw err;
    } finally {
      await page.close().catch(() => {});
      this.running.delete(tenantId);
    }
  }

  private seenFile(tenantId: string): string {
    return path.join(this.sessions.getProfileDir(tenantId), '.seen-comments.json');
  }

  /**
   * The ids already reported, persisted beside the profile.
   *
   * Without this every restart would re-report every comment still visible on
   * the Page. The CRM would reject them all on its unique index, so nothing
   * would actually duplicate — but it would be a burst of pointless webhook
   * traffic on every save under `tsx watch`, which is noise that hides real
   * signal.
   */
  private async loadSeen(tenantId: string): Promise<Set<string>> {
    const cached = this.seen.get(tenantId);
    if (cached) return cached;
    let ids: string[] = [];
    try {
      ids = JSON.parse(await fs.readFile(this.seenFile(tenantId), 'utf8')) as string[];
    } catch {
      // Nothing persisted yet.
    }
    const set = new Set(ids);
    this.seen.set(tenantId, set);
    return set;
  }

  private async persistSeen(tenantId: string, seen: Set<string>): Promise<void> {
    // Oldest first out of the file, so a Page with years of comments does not
    // grow this without bound. Trimming can only cause a re-report, which the
    // CRM's unique index absorbs — it can never cause a duplicate.
    const trimmed = [...seen].slice(-SEEN_LIMIT);
    this.seen.set(tenantId, new Set(trimmed));
    await fs.writeFile(this.seenFile(tenantId), JSON.stringify(trimmed), 'utf8').catch(() => {});
  }
}
