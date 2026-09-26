import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer';
import { COMMENTS, URLS } from './selectors.ts';
import { parseFacebookComments, type ParsedComment, type ParsedComments } from './parsers/comments.ts';
import { readContainerHtml, type Logger } from './messengerWatcher.ts';
import { readPostSurfaceHtml } from './pageHtml.ts';
import { CheckpointRequiredError, SessionExpiredError, type PageMarker, type SessionManager } from './sessionManager.ts';
import { PulseTabs, changedPosts, keepRenderingInBackground } from './commentPulse.ts';
import type { FbBridgeEvent } from './events.ts';
import type { PostDetails, PostDetailsUpdate } from './parsers/postDetails.ts';

export type { PostDetailsUpdate } from './parsers/postDetails.ts';

/**
 * How often every recent post is re-read in full, whatever the pulse saw — the
 * safety net for what a comment count cannot show (a comment deleted and
 * another written in the same minute, an abbreviated "1,2 rb" count). The
 * first one does not wait: one runs at startup and one the moment a login
 * settles (`onSessionReady`).
 */
export const SWEEP_INTERVAL_MS = 15 * 60_000;
/**
 * How often the Page timeline is re-read for comment counts — what makes a new
 * comment reach the CRM within about a minute.
 *
 * Facebook offers no usable push for this. Measured live, 2026-09-26: the
 * notification badge stopped updating in a tab left open ~15 minutes (its
 * socket still alive), and a comment on a post that already had an unread
 * notification never raised the badge at all. The timeline, reloaded, always
 * shows each post's comment count; a count that rose names the one post worth
 * opening. So a quiet minute costs one timeline load, and only a changed post
 * costs one more — the chosen trade against reading all posts every minute.
 */
export const PULSE_INTERVAL_MS = 60_000;
/** How many of a Page's newest posts are re-read in full on each sweep. */
const POSTS_PER_SWEEP = 3;
/** How long a post's comments get to render before it is read. */
const COMMENT_RENDER_MS = 20_000;
/**
 * How long the timeline gets to show a post LINK, not merely a post shape.
 *
 * The feed paints post-shaped placeholders — `div[role="article"]` with no
 * text and no links — before its GraphQL fetch resolves, and the next posts
 * only hydrate as they scroll into view. Measured live at the moment the old
 * sweep read (the first article appearing): three post articles, two of them
 * still without a link — and every sweep before this recorded `posts: 0`
 * while three posts sat on the Page. Waiting for a permalink is waiting for
 * the thing the sweep actually needs.
 */
const POST_DISCOVERY_MS = 20_000;
const DISCOVERY_POLL_MS = 1_000;
/** How long a post's own surface gets for its comments to render and settle. */
const POST_SURFACE_SETTLE_MS = 15_000;
/** Bounded, like everything a sweep does: a person scrolls a little, not the whole history. */
const MAX_DISCOVERY_SCROLLS = 3;
const SCROLL_SETTLE_MS = 2_000;

export type SweepTrigger = 'startup' | 'interval' | 'ready' | 'manual' | 'pulse';

/**
 * What the CRM already holds, by comment id — under the post each was just read
 * under, when that is given. An unreachable CRM answers "nothing".
 */
export type KnownCommentIds = (
  sessionKey: string, commentIds: string[], postByComment?: Record<string, string>,
) => Promise<Set<string>>;

/** Resolves true only once the CRM has accepted the event. */
export type EmitEvent = (ev: FbBridgeEvent) => Promise<boolean> | boolean | void;

/** Hands the CRM what each post is; resolves true once it has taken them. */
export type RecordPostDetails = (sessionKey: string, pageId: string, posts: PostDetailsUpdate[]) => Promise<boolean>;

/** At most this many posts in one hand-over — the handful a timeline reading renders, and the CRM's own bound. */
const MAX_POST_DETAILS = 20;
/**
 * How much earlier a post's age must read before it is worth sending again.
 * A relative age re-read a minute later lands within seconds of the last one;
 * only a genuinely finer reading moves it back by more.
 */
const AGE_SLACK_MS = 5 * 60_000;

export interface SweepSummary {
  posts: number;
  read: number;
  known: number;
  fresh: number;
  rejected: number;
}

const noneKnown: KnownCommentIds = async () => new Set();
const recordNothing: RecordPostDetails = async () => true;

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
 *
 * KEEPS NO LEDGER. Which comments are already stored is asked of the CRM on
 * every sweep, the same arrangement the Messenger backfill uses. A file of
 * "seen" ids beside the profile used to decide this, and it outlived the
 * database it described: after the CRM was rebuilt, sixteen comments stayed
 * "seen" in the file and never reached the new database at all. A comment
 * counts as delivered only when the CRM says so; one it refused is offered
 * again on the next sweep.
 */
export class CommentWatcher {
  private timer: NodeJS.Timeout | null = null;
  private pulseTimer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  private pulseTabs: PulseTabs;
  /** Each recent post's comment count at the last reading, per session — what a pulse compares against. */
  private postCounts = new Map<string, Record<string, number>>();
  /** What the CRM last accepted about each post, per session — so a quiet minute sends nothing. */
  private postsSent = new Map<string, ReadonlyMap<string, { text: string | null; createdAt: number | null }>>();

  constructor(
    private sessions: SessionManager,
    private onEvent: EmitEvent,
    private log: Logger,
    private knownCommentIds: KnownCommentIds = noneKnown,
    private recordPostDetails: RecordPostDetails = recordNothing,
  ) {
    this.pulseTabs = new PulseTabs(sessions, log);
  }

  start(): void {
    void this.sweepAll('startup');
    this.timer = setInterval(() => void this.sweepAll('interval'), SWEEP_INTERVAL_MS);
    // Skipped for a session whose sweep is still running (the `running` guard
    // in `sweep`), so a pulse never reads beside a sweep or another pulse.
    this.pulseTimer = setInterval(() => void this.sweepAll('pulse'), PULSE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    void this.pulseTabs.closeAll();
  }

  /** A login just settled: read the Page now rather than at the next interval. */
  onSessionReady(sessionKey: string): void {
    void this.sweep(sessionKey, 'ready').catch((err) =>
      this.log.warn({ err, sessionKey }, 'fb-bridge: comment sweep failed'));
  }

  private async sweepAll(trigger: SweepTrigger): Promise<void> {
    for (const sessionKey of await this.sessions.knownSessionKeys()) {
      await this.sweep(sessionKey, trigger).catch((err) =>
        this.log.warn({ err, sessionKey }, 'fb-bridge: comment sweep failed'));
    }
  }

  /**
   * One pass over a tenant's Page.
   *
   * A full sweep opens every recent post. A `'pulse'` reads the timeline in its
   * long-lived tab and opens only the posts whose comment count rose since the
   * last reading (`changedPosts`) — a quiet minute opens nothing else.
   *
   * Guarded against overlap: a sweep that runs long (a slow feed, a wedged tab)
   * must not have the next interval or pulse start a second one beside it,
   * both reading the same feed and both deciding the same comment is new.
   */
  async sweep(sessionKey: string, trigger: SweepTrigger = 'manual'): Promise<SweepSummary | null> {
    if (this.running.has(sessionKey)) return null;
    const marker = await this.sessions.getPageMarker(sessionKey);
    if (!marker) return null;
    const pulse = trigger === 'pulse';

    this.running.add(sessionKey);
    // Released on every way out: a tab that failed to open once used to leave
    // the session marked running forever, and every sweep after it returned
    // without a word until the process restarted.
    let page: Page | null;
    try {
      page = pulse ? await this.pulseTabs.get(sessionKey) : await this.sessions.newPage(sessionKey);
    } catch (err) {
      this.running.delete(sessionKey);
      throw err;
    }
    if (!page) {
      this.running.delete(sessionKey);
      return null;
    }
    const ids = { sessionKey, tenantId: marker.tenantId ?? null, pageId: marker.pageId };
    if (!pulse) {
      this.log.info({ event: 'fb_page_sweep_started', ...ids, trigger }, 'fb_page_sweep_started');
      // The per-step `visible` in `fb_posts_discovered` shows whether this held.
      await keepRenderingInBackground(page, this.log, ids);
    }

    try {
      const own = { pageId: marker.pageId, pageName: marker.pageName };
      const timeline = await this.discoverPosts(page, marker, ids, { quiet: pulse });
      if (!timeline) return null;

      const recent = timeline.postIds.slice(0, POSTS_PER_SWEEP);
      const toRead = pulse ? changedPosts(this.postCounts.get(sessionKey), timeline.commentCounts, recent) : recent;
      // What each post is, from the readings this sweep takes anyway: the
      // timeline first, then any post opened below (its caption uncut).
      let details: ReadonlyMap<string, PostDetails> = new Map(Object.entries(timeline.postDetails));
      if (pulse && toRead.length === 0) {
        this.rememberCounts(sessionKey, timeline.commentCounts, recent, new Set());
        await this.sendPostDetails(sessionKey, marker, details);
        return { read: 0, known: 0, fresh: 0, rejected: 0, posts: timeline.postIds.length };
      }
      if (pulse) {
        this.log.info({
          event: 'fb_comment_pulse_changed', ...ids, postIds: toRead,
          counts: Object.fromEntries(toRead.map((postId) => [postId, timeline.commentCounts[postId] ?? 0])),
        }, 'fb_comment_pulse_changed');
      }

      const found = new Map(timeline.comments.map((comment) => [comment.commentId, comment]));
      const unreadable = new Set<string>();

      // The timeline is a summary, not the comments. It renders the first one
      // or two under each post and hides the rest behind "View more comments",
      // so reading it alone misses comments silently — confirmed live. Each
      // recent post is therefore opened on its own permalink, where the whole
      // thread is rendered. Bounded, because a Page's history is not: only the
      // newest posts are worth re-reading every sweep, and anything older is
      // reached the same way the first time it appears.
      for (const [index, postId] of toRead.entries()) {
        const url = URLS.postPermalink(marker.pageId, postId);
        this.log.info({ event: 'fb_post_opened', ...ids, postId, url }, 'fb_post_opened');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // `domcontentloaded` is the document, not the comments: they are
        // rendered afterwards, and a read taken straight after the navigation
        // came back with whatever the timeline already had — which looked
        // exactly like a post with nothing new on it. Waited for, not slept
        // through, so a post that genuinely has no comments costs the timeout
        // once rather than a fixed delay every sweep.
        await page.waitForSelector(COMMENTS.comment.join(', '), { timeout: COMMENT_RENDER_MS }).catch(() => {});
        // Fail-closed: only a surface that proves it owns THIS post is read
        // (`readPostSurfaceHtml`); a background feed or another dialog is not.
        const { html: postHtml, reads } = await this.readSettledPostSurface(page, postId, own);
        this.log.info({
          event: 'fb_post_surface_found', ...ids, postId, found: Boolean(postHtml), bytes: postHtml?.length ?? 0, reads,
        }, 'fb_post_surface_found');
        if (!postHtml) {
          this.log.warn(
            { sessionKey, postId },
            'fb-bridge: target post surface not found — refusing background feed fallback',
          );
          unreadable.add(postId);
          continue;
        }
        await snapshot(sessionKey, `post-${index}`, postHtml);
        const parsed = parseFacebookComments(postHtml, { defaultPostId: postId, ...own });
        const opened = parsed.postDetails[postId];
        if (opened) details = new Map([...details, [postId, mergeDetails(details.get(postId), opened)]]);
        this.log.info(
          { event: 'fb_comments_rendered', ...ids, postId, commentNodes: parsed.matchedComments },
          'fb_comments_rendered',
        );
        this.log.info({
          event: 'fb_customer_comments_parsed', ...ids, postId, customer: parsed.comments.length,
          pageOwn: parsed.droppedPageOwn, droppedNoId: parsed.droppedNoId, droppedNoPost: parsed.droppedNoPost,
        }, 'fb_customer_comments_parsed');
        for (const comment of parsed.comments) {
          if (comment.postId !== postId) {
            this.log.warn(
              { sessionKey, expectedPostId: postId, parsedPostId: comment.postId, commentId: comment.commentId },
              'fb-bridge: comment surface contained a different post — dropped',
            );
            continue;
          }
          found.set(comment.commentId, comment);
        }
      }

      const summary = await this.emitNew(sessionKey, marker, [...found.values()]);
      await this.sendPostDetails(sessionKey, marker, details);
      // A comment the CRM refused keeps the old counts, so the next pulse opens
      // that post again rather than waiting for the full sweep.
      if (summary.rejected === 0) this.rememberCounts(sessionKey, timeline.commentCounts, recent, unreadable);
      // Logged every sweep, not only when something is new. A sweep that finds
      // nothing and says nothing is indistinguishable from a sweep that never
      // ran or one whose selectors have gone stale, and this service has been
      // all three. (A quiet pulse returned above without a word: once a minute
      // would bury everything else.)
      const result = { ...summary, posts: timeline.postIds.length };
      this.log.info({ ...ids, trigger, ...result }, 'fb-bridge: page comments swept');
      return result;
    } catch (err) {
      const needsLogin = err instanceof SessionExpiredError || err instanceof CheckpointRequiredError;
      if (needsLogin) {
        const error = (err as Error).message;
        this.sessions.forgetSession(sessionKey, error);
        void this.onEvent({ event: 'session_error', sessionKey, at: new Date().toISOString(), error, needsLogin: true });
      }
      throw err;
    } finally {
      // The pulse tab stays open for the next minute; a sweep's own tab does not.
      if (!pulse) await page.close().catch(() => {});
      this.running.delete(sessionKey);
    }
  }

  /**
   * Hands the CRM what each post is, so the inbox can name a comment group
   * after its post instead of its slug — only what the CRM does not already
   * have from an earlier minute: a new post, an edited caption, or an age that
   * reads meaningfully earlier than before. A post the CRM did not take is
   * offered again next time.
   *
   * Never allowed to fail the sweep: a post without a caption in the inbox is
   * a label, and a comment that never reaches the inbox is a customer ignored.
   */
  private async sendPostDetails(
    sessionKey: string, marker: PageMarker, details: ReadonlyMap<string, PostDetails>,
  ): Promise<void> {
    const sent = this.postsSent.get(sessionKey) ?? new Map();
    const fresh: PostDetailsUpdate[] = [...details.entries()]
      .filter(([postId, post]) => isNews(sent.get(postId), post))
      .map(([postId, post]) => ({ postId, ...post }))
      .slice(0, MAX_POST_DETAILS);
    if (fresh.length === 0) return;

    let accepted = false;
    try {
      accepted = await this.recordPostDetails(sessionKey, marker.pageId, fresh);
    } catch (err) {
      this.log.warn({ err, sessionKey, postIds: fresh.map((p) => p.postId) }, 'fb-bridge: could not hand post details to the CRM');
      return;
    }
    if (!accepted) return;
    this.postsSent.set(sessionKey, new Map([
      ...sent,
      ...fresh.map((p) => [p.postId, { text: p.text, createdAt: p.createdAt ? Date.parse(p.createdAt) : null }] as const),
    ]));
  }

  /**
   * What the next pulse compares against. A post whose surface could not be
   * read keeps its previous count, so the next pulse opens it again.
   */
  private rememberCounts(
    sessionKey: string, counts: Record<string, number>, recent: string[], unreadable: Set<string>,
  ): void {
    const previous = this.postCounts.get(sessionKey) ?? {};
    const next: Record<string, number> = {};
    for (const postId of recent) {
      next[postId] = unreadable.has(postId) ? (previous[postId] ?? 0) : (counts[postId] ?? 0);
    }
    this.postCounts.set(sessionKey, next);
  }

  /**
   * The Page's timeline, read once it shows post links — and the evidence of
   * how it looked at the moment the old sweep used to read it. `quiet` (the
   * once-a-minute pulse) records it only when no post could be found at all.
   */
  private async discoverPosts(
    page: Page, marker: PageMarker, ids: Record<string, unknown>, opts: { quiet?: boolean } = {},
  ): Promise<ParsedComments | null> {
    const own = { pageId: marker.pageId, pageName: marker.pageName };
    await page.goto(URLS.pagePosts(marker.pageId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await this.sessions.assertUsable(page);
    await page.waitForSelector(COMMENTS.post.join(', '), { timeout: COMMENT_RENDER_MS }).catch(() => {});

    const shape = (p: ParsedComments | null) => p && ({
      posts: p.postIds.length, postArticles: p.postArticles, postArticlesWithoutId: p.postArticlesWithoutId,
      commentNodes: p.matchedComments,
    });
    // Every reading is kept, tagged with whether the tab was rendering at the
    // time: a short sweep then says which step stalled and why, instead of
    // only "found 1".
    const steps: Array<Record<string, unknown>> = [];
    const read = async (step: string) => {
      const html = await readContainerHtml(page, COMMENTS.feed);
      const parsed = html ? parseFacebookComments(html, own) : null;
      const visibility = await page.evaluate('document.visibilityState').catch(() => null);
      steps.push({ step, ...shape(parsed), visible: visibility === null ? null : visibility === 'visible' });
      return { html, parsed };
    };
    // What the sweep read before post links were waited for — kept as evidence.
    const first = await read('first-read');
    let current = first;

    const deadline = Date.now() + POST_DISCOVERY_MS;
    let waits = 0;
    while (current.html && (current.parsed?.postIds.length ?? 0) === 0 && Date.now() < deadline) {
      await sleep(DISCOVERY_POLL_MS);
      current = await read(`wait-${++waits}`);
    }
    // Only the first post hydrates in view; the next ones do as they scroll in.
    let scrolls = 0;
    while (current.html && (current.parsed?.postIds.length ?? 0) > 0
      && (current.parsed?.postIds.length ?? 0) < POSTS_PER_SWEEP && scrolls < MAX_DISCOVERY_SCROLLS) {
      const before = current.parsed!.postIds.length;
      await page.evaluate('window.scrollBy(0, 1400)').catch(() => {});
      scrolls += 1;
      await sleep(SCROLL_SETTLE_MS);
      current = await read(`scroll-${scrolls}`);
      if ((current.parsed?.postIds.length ?? 0) === before && scrolls >= 2) break;
    }

    if (!current.html || !current.parsed) {
      this.log.warn({ ...ids, steps }, 'fb-bridge: page feed container not found — COMMENTS.feed may be stale');
      return null;
    }
    await snapshot(String(ids.sessionKey), 'timeline', current.html);
    if (!opts.quiet || current.parsed.postIds.length === 0) {
      this.log.info({
        event: 'fb_posts_discovered', ...ids, count: current.parsed.postIds.length, postIds: current.parsed.postIds,
        commentCounts: current.parsed.commentCounts,
        atFirstRead: shape(first.parsed), afterWait: shape(current.parsed), scrolls, steps,
      }, 'fb_posts_discovered');
    }
    if (current.parsed.droppedNoId > 0) {
      // Loud rather than silent: a comment with no readable id has no
      // idempotency key, so it is dropped instead of being re-ingested on
      // every sweep. All of them being dropped means the selectors moved.
      this.log.warn(
        { ...ids, dropped: current.parsed.droppedNoId, matched: current.parsed.matchedComments },
        'fb-bridge: comments dropped for having no readable id — COMMENTS.permalink may be stale',
      );
    }
    return current.parsed;
  }

  /**
   * The target post's surface once its own comments have rendered.
   *
   * Waiting for "a comment" is not enough on a permalink: the feed behind the
   * post's modal carries comments too, so that wait returned at once and the
   * modal was read before its comments arrived — confirmed live, a post with
   * three comments read back as 19 KB and none, then as 73 KB and three a
   * moment later. This re-reads the post's OWN surface until its comment count
   * is non-zero and unchanged across two reads, or the time runs out (a post
   * with genuinely no comments costs that once per sweep).
   */
  private async readSettledPostSurface(
    page: Page, postId: string, own: { pageId: string; pageName: string },
  ): Promise<{ html: string | null; reads: number }> {
    const deadline = Date.now() + POST_SURFACE_SETTLE_MS;
    let html = await readPostSurfaceHtml(page, postId);
    let reads = 1;
    let previous = -1;
    for (;;) {
      const count = html ? parseFacebookComments(html, { defaultPostId: postId, ...own }).matchedComments : 0;
      if (html && count > 0 && count === previous) return { html, reads };
      if (Date.now() >= deadline) return { html, reads };
      previous = count;
      await sleep(DISCOVERY_POLL_MS);
      html = await readPostSurfaceHtml(page, postId);
      reads += 1;
    }
  }

  /**
   * Offers the CRM every comment it does not already hold, one event each,
   * and counts one as delivered only when the CRM accepted it.
   */
  async emitNew(sessionKey: string, marker: PageMarker, comments: ParsedComment[]): Promise<Omit<SweepSummary, 'posts'>> {
    const ids = { sessionKey, tenantId: marker.tenantId ?? null, pageId: marker.pageId };
    const unique = [...new Map(comments.map((c) => [c.commentId, c])).values()];
    // The post each was read under goes along: a comment the CRM holds under a
    // slug Facebook has since re-issued is not "known", and is offered again.
    const postByComment = Object.fromEntries(unique.map((c) => [c.commentId, c.postId]));
    const known = unique.length > 0
      ? await this.knownCommentIds(sessionKey, unique.map((c) => c.commentId), postByComment)
      : new Set<string>();
    let fresh = 0;
    let rejected = 0;
    for (const comment of unique) {
      const isKnown = known.has(comment.commentId);
      this.log.info({
        event: 'fb_comment_candidate', ...ids, postId: comment.postId, commentId: comment.commentId,
        parentCommentId: comment.parentCommentId, authorId: comment.authorId, known: isKnown,
      }, 'fb_comment_candidate');
      if (isKnown) continue;
      const accepted = (await this.onEvent({
        event: 'comment',
        sessionKey,
        at: new Date().toISOString(),
        comment: { ...comment, pageId: marker.pageId, pageName: marker.pageName },
      })) === true;
      this.log.info({
        event: 'fb_comment_event_emitted', ...ids, postId: comment.postId, commentId: comment.commentId,
        parentCommentId: comment.parentCommentId, accepted,
      }, 'fb_comment_event_emitted');
      if (accepted) fresh += 1;
      else rejected += 1;
    }
    return { read: unique.length, known: known.size, fresh, rejected };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two readings of one post, as one: the later caption when it has one (a
 * post's own permalink shows its caption whole; the timeline cuts it), and
 * the earlier age — a relative age only gets coarser as a post gets older.
 */
function mergeDetails(earlier: PostDetails | undefined, later: PostDetails): PostDetails {
  const ages = [earlier?.createdAt, later.createdAt].filter((at): at is string => Boolean(at)).sort();
  return { text: later.text ?? earlier?.text ?? null, createdAt: ages[0] ?? null };
}

/**
 * Whether a reading tells the CRM anything the last accepted one did not. A
 * caption that is only the start of the one already sent is the timeline's
 * cut of it, not an edit — the CRM keeps the whole one either way.
 */
function isNews(
  previous: { text: string | null; createdAt: number | null } | undefined, post: PostDetails,
): boolean {
  if (!previous) return true;
  if (post.text !== null && !(previous.text ?? '').startsWith(post.text)) return true;
  if (post.createdAt === null) return false;
  return previous.createdAt === null || Date.parse(post.createdAt) < previous.createdAt - AGE_SLACK_MS;
}


/**
 * The HTML a sweep read, written out only when `FB_BRIDGE_SNAPSHOT_DIR` is set.
 *
 * Off by default, like `FB_BRIDGE_DEBUG`: these pages are customers' comments.
 * It exists because the failures here are silent by nature — a selector that
 * matches nothing looks exactly like a Page with nothing on it — and the only
 * way to tell them apart is the markup the sweep actually saw.
 */
async function snapshot(sessionKey: string, stage: string, html: string): Promise<void> {
  const dir = process.env.FB_BRIDGE_SNAPSHOT_DIR;
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(dir, `${sessionKey}-${stage}.html`), html, 'utf8').catch(() => {});
}
