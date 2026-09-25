import path from 'node:path';
import Fastify from 'fastify';
import {
  NoActiveSessionError, SenderNotImplementedError, SendNotConfirmedError, ThreadRequiresAcceptanceError, SessionManager, CommentActionNotImplementedError, CommentNotFoundError, CommentActionUnavailableError,
} from './sessionManager.ts';
import { MessengerWatcher } from './messengerWatcher.ts';
import { CommentWatcher } from './commentWatcher.ts';
import type { FbBridgeEvent } from './events.ts';

const PORT = Number(process.env.PORT ?? 8092);
const FB_BRIDGE_SECRET = process.env.FB_BRIDGE_SECRET ?? 'dev-fb-bridge-secret-change-me';
const KIRANA_API_URL = process.env.KIRANA_API_URL ?? 'http://127.0.0.1:8080';
const authDir = path.join(import.meta.dirname, '..', '.fb_bridge_auth');

const app = Fastify({ logger: true });

/**
 * Everything this service knows how to tell the CRM goes through one endpoint,
 * authenticated by a shared secret — the same arrangement `apps/wa-bridge` and
 * `apps/ig-bridge` use. It is an internal service on loopback, not a public
 * provider, so there is no per-payload signature to verify.
 *
 * A failure here is logged and dropped rather than retried. The CRM's own spool
 * is the retry mechanism for anything that got through, and the watcher's
 * reconciliation pass re-reads whatever did not — a retry loop in here would
 * only queue events in memory that a restart throws away anyway.
 */
async function postEvent(ev: FbBridgeEvent): Promise<void> {
  try {
    const res = await fetch(`${KIRANA_API_URL}/v1/webhooks/fb-bridge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FB_BRIDGE_SECRET}` },
      // Both identities on the wire: the profile the event came off, and the
      // tenant the CRM files it under (see `tenantOf`).
      body: JSON.stringify({ ...ev, tenantId: await tenantOf(ev.sessionKey) }),
    });
    if (!res.ok) {
      app.log.warn({ status: res.status, event: ev.event, sessionKey: ev.sessionKey },
        'kirana api rejected an fb-bridge event');
      return;
    }
    app.log.info({ event: ev.event, sessionKey: ev.sessionKey }, 'fb-bridge event posted to kirana api');
  } catch (err) {
    app.log.error({ err, event: ev.event }, 'could not reach kirana api');
  }
}

const sessions = new SessionManager(authDir);

/**
 * A session key is a division's profile name, issued by the CRM: Marketing's
 * is the bare tenant id (what every profile was called before divisions
 * existed), any other division's is `<tenantId>-<division>`. The tenant id
 * the CRM wants on every event is therefore recoverable from the key alone;
 * the marker's copy, written at connect time, is preferred when it exists.
 */
const SESSION_KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-[a-z]+)?$/i;
function tenantIdFromSessionKey(sessionKey: string): string | null {
  const match = SESSION_KEY.exec(sessionKey);
  return match ? match[1]!.toLowerCase() : null;
}
async function tenantOf(sessionKey: string): Promise<string> {
  const marker = await sessions.getPageMarker(sessionKey);
  return marker?.tenantId ?? tenantIdFromSessionKey(sessionKey) ?? sessionKey;
}

/**
 * What the CRM already holds, asked over the same internal channel everything
 * else uses. The bridge keeps no ledger of its own: a file here would be a
 * second opinion about what has been stored, and the two drift apart the moment
 * either side is restored or redeployed.
 *
 * An unreachable CRM answers "nothing is known", which makes a backfill skip
 * rather than re-import — the limit in `selectBackfill` bounds the damage, and
 * the CRM's own unique indexes absorb whatever slips through.
 */
async function knownIds(sessionKey: string, externalIds: string[]): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  try {
    const res = await fetch(`${KIRANA_API_URL}/v1/webhooks/fb-bridge/known`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${FB_BRIDGE_SECRET}` },
      body: JSON.stringify({ tenantId: await tenantOf(sessionKey), sessionKey, externalIds }),
    });
    if (!res.ok) {
      app.log.warn({ status: res.status, sessionKey }, 'fb-bridge: could not read known message ids');
      return new Set();
    }
    const body = await res.json() as { known?: string[] };
    return new Set(body.known ?? []);
  } catch (err) {
    app.log.warn({ err, sessionKey }, 'fb-bridge: could not reach kirana api for known message ids');
    return new Set();
  }
}

const messenger = new MessengerWatcher(sessions, (ev) => void postEvent(ev), app.log, knownIds);
const comments = new CommentWatcher(sessions, (ev) => void postEvent(ev), app.log);

// Both watchers' own first pass resumes every tenant with a persisted profile.
// `tsx watch` restarts on every code change and in production a redeploy or a
// crash does the same, so resuming cannot be a one-time thing done only after a
// login. A second startup loop beside this would race it — two launches against
// one `userDataDir`, which Chrome's single-instance lock rejects outright.
messenger.start();
comments.start();

// One tenant's browser dying must not take the service down with every other
// tenant's live session. Puppeteer's page handlers run detached from any call
// this service made, so an error in one has nothing left to catch it.
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaught exception in fb-bridge — continuing');
});
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandled rejection in fb-bridge — continuing');
});

// A tenant's browser legitimately keeps several tabs open at once (the
// long-lived inbox observer plus short-lived reader tabs). Killed rather than
// closed, Chrome's own session restore tries to reopen all of them on the next
// launch, which headless mode refuses outright. `tsx watch` restarts via
// SIGTERM on every save, so this is the common case, not an edge case.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'fb-bridge shutting down — closing browsers');
  messenger.stop();
  comments.stop();
  await sessions.closeAll().catch((err) => app.log.warn({ err }, 'fb-bridge: error closing browsers on shutdown'));
  await app.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Internal service only. Bound to loopback below and never exposed publicly.
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/healthz') return;
  if (req.headers.authorization !== `Bearer ${FB_BRIDGE_SECRET}`) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
});

/** Unauthenticated on purpose: a container health probe has no secret, and this
 * reveals nothing but whether the process is alive. */
app.get('/healthz', async () => ({ status: 'ok' }));

/**
 * Opens a real browser window for the operator to log in by hand.
 *
 * Returns straight away with `awaiting_login` rather than holding the request
 * open — logging in can mean a password, a 2FA code from a phone, and a
 * checkpoint, which is minutes of human work. The CRM polls `/status`.
 *
 * There is no username or password parameter, and there will not be one: the
 * whole point is that no Facebook credential ever passes through this service
 * or the CRM.
 */
app.post<{
  Params: { sessionKey: string };
  Body: { pageId?: string; pageName?: string; assetId?: string; tenantId?: string };
}>(
  '/internal/sessions/:sessionKey/login-window', async (req, reply) => {
    const { pageId, pageName, assetId, tenantId } = req.body ?? {};
    if (!pageId || !pageName) {
      return reply.status(400).send({ error: 'pageId and pageName are required' });
    }
    // `assetId` is optional and its absence is meaningful: without one this
    // connection reads facebook.com/messages/t/, with one it reads that Page's
    // Business Suite inbox. Stored beside the profile so a restart resumes on
    // the same surface instead of silently falling back to the personal one.
    // The tenant id rides along so every event can name it without a lookup.
    const marker = {
      pageId, pageName, assetId: assetId ?? null,
      tenantId: tenantId ?? tenantIdFromSessionKey(req.params.sessionKey),
    };
    const state = await sessions.openLoginWindow(req.params.sessionKey, marker, (settled) => {
      if (settled.status !== 'ready') return;
      void messenger.loadAnchors(req.params.sessionKey)
        .then(() => messenger.attachTenant(req.params.sessionKey))
        .catch((err) => app.log.warn({ err }, 'fb-bridge: failed to attach after login'));
    });
    return reply.send(state);
  });

app.get<{ Params: { sessionKey: string } }>('/internal/sessions/:sessionKey/status', async (req, reply) =>
  reply.send(await sessions.status(req.params.sessionKey)));

/** Forces a comment sweep now instead of waiting for the next interval — for an
 * operator who just posted something and wants to see it wired up, and for
 * manual verification during setup. */
app.post<{ Params: { sessionKey: string } }>('/internal/sessions/:sessionKey/sweep-comments', async (req, reply) => {
  try {
    await comments.sweep(req.params.sessionKey);
    return reply.send({ swept: true });
  } catch (err) {
    return reply.status(502).send({ error: err instanceof Error ? err.message : 'Gagal membaca komentar' });
  }
});

/**
 * Sends a reply in a thread.
 *
 * Answers 501 while the composer selectors are unverified, and says why in the
 * body. That status is deliberate: the CRM treats it as permanent and fails the
 * message with the reason attached, so an agent sees "not available yet" rather
 * than a reply that sits queued looking sent. When the sender lands, nothing
 * upstream changes — this route simply stops answering 501.
 */
app.post<{ Params: { sessionKey: string; threadId: string }; Body: { text?: string } }>(
  '/internal/sessions/:sessionKey/threads/:threadId/send', async (req, reply) => {
    const text = req.body?.text;
    if (!text) return reply.status(400).send({ error: 'text is required' });
    try {
      await sessions.sendMessage(req.params.sessionKey, req.params.threadId, text);
      return reply.send({ sent: true });
    } catch (err) {
      if (err instanceof SenderNotImplementedError) {
        return reply.status(501).send({ error: err.message, code: 'sender_not_implemented' });
      }
      if (err instanceof ThreadRequiresAcceptanceError) {
        // Permanent: no amount of retrying makes a message request accept a
        // reply. The operator has to accept it in Facebook first.
        return reply.status(409).send({ error: err.message, code: 'thread_requires_acceptance' });
      }
      if (err instanceof NoActiveSessionError) {
        return reply.status(404).send({ error: err.message });
      }
      if (err instanceof SendNotConfirmedError) {
        // Not permanent: the message may have been rate-limited, and the next
        // attempt can legitimately succeed.
        return reply.status(502).send({ error: err.message, code: 'send_not_confirmed' });
      }
      app.log.warn({ err, sessionKey: req.params.sessionKey }, 'fb-bridge send failed');
      return reply.status(502).send({ error: err instanceof Error ? err.message : 'Gagal mengirim pesan Facebook' });
    }
  });

/**
 * Replies to a comment publicly, under the Page's name, on the customer's post.
 *
 * The CRM never reports this as done on the strength of the HTTP status: it
 * marks `public_replied` only on 200, and 200 is returned only once the reply
 * is visible under the comment. 502 is "typed but not seen", which the worker
 * treats as terminal for that comment rather than retrying — retyping onto a
 * real person's post is the one outcome worse than a missed reply.
 */
app.post<{ Params: { sessionKey: string }; Body: { postId?: string; commentId?: string; text?: string } }>(
  '/internal/sessions/:sessionKey/comments/reply', async (req, reply) => {
    const { postId, commentId, text } = req.body ?? {};
    if (!postId || !commentId || !text) {
      return reply.status(400).send({ error: 'postId, commentId and text are required' });
    }
    try {
      await sessions.replyToComment(req.params.sessionKey, { postId, commentId, text });
      return reply.send({ replied: true });
    } catch (err) {
      return reply.status(commentActionStatus(err)).send(commentActionBody(err));
    }
  });

/**
 * Sends a private Messenger message to a commenter, through Facebook's own
 * "message" affordance on the comment — the only route by which a Page may
 * open a conversation with someone who has not messaged it first. When
 * Facebook does not offer it for this comment or this person, that is a 409
 * the CRM records as `dm_error`, not a failure to retry.
 */
app.post<{ Params: { sessionKey: string }; Body: { postId?: string; commentId?: string; text?: string } }>(
  '/internal/sessions/:sessionKey/comments/private-reply', async (req, reply) => {
    const { postId, commentId, text } = req.body ?? {};
    if (!postId || !commentId || !text) {
      return reply.status(400).send({ error: 'postId, commentId and text are required' });
    }
    try {
      const { threadId } = await sessions.privateReplyToComment(req.params.sessionKey, { postId, commentId, text });
      return reply.send({ sent: true, threadId });
    } catch (err) {
      return reply.status(commentActionStatus(err)).send(commentActionBody(err));
    }
  });

/** The status the worker keys its permanent/transient decision on. */
function commentActionStatus(err: unknown): number {
  if (err instanceof CommentActionNotImplementedError) return 501;
  if (err instanceof CommentNotFoundError) return 409;
  if (err instanceof CommentActionUnavailableError) return 409;
  if (err instanceof NoActiveSessionError) return 404;
  return 502;
}

function commentActionBody(err: unknown): { error: string; code?: string } {
  const message = err instanceof Error ? err.message : 'Gagal menindaklanjuti komentar Facebook';
  if (err instanceof CommentActionNotImplementedError) return { error: message, code: 'comment_action_not_implemented' };
  if (err instanceof CommentNotFoundError) return { error: message, code: 'comment_not_found' };
  if (err instanceof CommentActionUnavailableError) return { error: message, code: err.code };
  if (err instanceof NoActiveSessionError) return { error: message };
  if (err instanceof SendNotConfirmedError) return { error: message, code: 'reply_not_confirmed' };
  return { error: message };
}

/** Deletes the stored Chromium profile. This is what makes "disconnect" in the
 * CRM actually revoke the session rather than just hide it. */
app.delete<{ Params: { sessionKey: string } }>('/internal/sessions/:sessionKey', async (req, reply) => {
  await sessions.logout(req.params.sessionKey);
  return reply.status(204).send();
});

/**
 * Exactly one bridge per profile, and it says so when it is not.
 *
 * Two of these against one Chromium profile is not a degraded setup, it is a
 * broken one: Chrome refuses the second launch outright, so whichever instance
 * the CRM happens to reach answers "failed to launch the browser". That is
 * what happened live — three comment actions failed against a second bridge
 * that could never have worked, and the port collision was buried in a log
 * line because `uncaughtException` below kept the process alive after the bind
 * failed. A bridge that cannot bind must die, loudly.
 */
const alreadyRunning = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(2_000) })
  .then((res) => res.ok).catch(() => false);
if (alreadyRunning) {
  app.log.error({ port: PORT },
    `fb-bridge is already running on 127.0.0.1:${PORT} — stop it before starting another, `
    + 'or two instances will fight over the same Chromium profile');
  process.exit(1);
}

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
} catch (err) {
  app.log.error({ err, port: PORT }, 'fb-bridge could not bind its port — refusing to run half-started');
  process.exit(1);
}
app.log.info(`fb-bridge listening on 127.0.0.1:${PORT}`);
