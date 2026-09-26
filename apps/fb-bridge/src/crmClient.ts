import type { FbBridgeEvent } from './events.ts';
import type { Logger } from './messengerWatcher.ts';

export interface CrmClientDeps {
  apiUrl: string;
  secret: string;
  /** The tenant the CRM files a session's events under. */
  tenantOf: (sessionKey: string) => Promise<string>;
  log: Logger;
  /** Injected so the wire contract can be tested without a CRM. */
  fetch?: typeof fetch;
}

export interface CrmClient {
  postEvent(ev: FbBridgeEvent): Promise<boolean>;
  knownIds(sessionKey: string, externalIds: string[]): Promise<Set<string>>;
  knownCommentIds(sessionKey: string, commentIds: string[], postByComment?: Record<string, string>): Promise<Set<string>>;
}

/**
 * The bridge's only conversation with the CRM: events in, and "what do you
 * already hold?" out.
 *
 * Everything this service knows how to tell the CRM goes through one endpoint,
 * authenticated by a shared secret — the same arrangement `apps/wa-bridge` and
 * `apps/ig-bridge` use. It is an internal service on loopback, not a public
 * provider, so there is no per-payload signature to verify.
 */
export function createCrmClient(deps: CrmClientDeps): CrmClient {
  const http = deps.fetch ?? fetch;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${deps.secret}` };

  /**
   * A failure here is logged and dropped rather than retried. The CRM's own
   * spool is the retry mechanism for anything that got through, and the
   * watchers' next pass re-reads whatever did not — a retry loop in here would
   * only queue events in memory that a restart throws away anyway. The answer
   * is returned so a caller that must know — the comment sweep, which offers a
   * refused comment again next time — can tell delivered from dropped.
   */
  async function postEvent(ev: FbBridgeEvent): Promise<boolean> {
    const ids = ev.event === 'comment'
      ? { postId: ev.comment.postId, commentId: ev.comment.commentId, pageId: ev.comment.pageId }
      : {};
    try {
      const res = await http(`${deps.apiUrl}/v1/webhooks/fb-bridge`, {
        method: 'POST',
        headers,
        // Both identities on the wire: the profile the event came off, and the
        // tenant the CRM files it under (see `tenantOf`).
        body: JSON.stringify({ ...ev, tenantId: await deps.tenantOf(ev.sessionKey) }),
      });
      if (!res.ok) {
        deps.log.warn({ status: res.status, event: ev.event, sessionKey: ev.sessionKey, ...ids },
          'kirana api rejected an fb-bridge event');
        return false;
      }
      deps.log.info({ event: ev.event, sessionKey: ev.sessionKey, status: res.status, ...ids },
        'fb-bridge event posted to kirana api');
      return true;
    } catch (err) {
      deps.log.error({ err, event: ev.event, ...ids }, 'could not reach kirana api');
      return false;
    }
  }

  async function askKnown(
    sessionKey: string,
    body: { externalIds: string[]; commentIds?: string[]; commentPosts?: Record<string, string> },
    what: string,
  ): Promise<{ known?: string[]; knownComments?: string[] } | null> {
    try {
      const res = await http(`${deps.apiUrl}/v1/webhooks/fb-bridge/known`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tenantId: await deps.tenantOf(sessionKey), sessionKey, ...body }),
      });
      if (!res.ok) {
        deps.log.warn({ status: res.status, sessionKey }, `fb-bridge: could not read known ${what} ids`);
        return null;
      }
      return await res.json() as { known?: string[]; knownComments?: string[] };
    } catch (err) {
      deps.log.warn({ err, sessionKey }, `fb-bridge: could not reach kirana api for known ${what} ids`);
      return null;
    }
  }

  /**
   * What the CRM already holds, asked over the same internal channel everything
   * else uses. The bridge keeps no ledger of its own: a file here would be a
   * second opinion about what has been stored, and the two drift apart the
   * moment either side is restored or redeployed.
   *
   * An unreachable CRM answers "nothing is known", which makes a backfill skip
   * rather than re-import — the limit in `selectBackfill` bounds the damage,
   * and the CRM's own unique indexes absorb whatever slips through.
   */
  async function knownIds(sessionKey: string, externalIds: string[]): Promise<Set<string>> {
    if (externalIds.length === 0) return new Set();
    const body = await askKnown(sessionKey, { externalIds }, 'message');
    return new Set(body?.known ?? []);
  }

  /**
   * Which of these comment ids the CRM already stores — the comment sweep's
   * only memory of what it has delivered (see `CommentWatcher`). Same endpoint
   * and same failure rule: an unreachable CRM answers "nothing", so the sweep
   * offers everything again and the CRM's unique index absorbs it.
   *
   * The post each comment was just read under goes along with it: Facebook
   * re-issues a post's `pfbid…` slug, and the CRM calls a comment known only
   * when it holds it under the slug the post has now — otherwise it is offered
   * again and re-filed rather than left under a post id that no longer exists.
   */
  async function knownCommentIds(
    sessionKey: string, commentIds: string[], postByComment?: Record<string, string>,
  ): Promise<Set<string>> {
    if (commentIds.length === 0) return new Set();
    const body = await askKnown(sessionKey, {
      externalIds: [], commentIds, ...(postByComment ? { commentPosts: postByComment } : {}),
    }, 'comment');
    return new Set(body?.knownComments ?? []);
  }

  return { postEvent, knownIds, knownCommentIds };
}
