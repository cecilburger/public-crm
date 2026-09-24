import path from 'node:path';
import Fastify from 'fastify';
import { SessionManager, NoActiveSessionError } from './sessionManager.ts';
import { DmWatcher, type DmWatcherEvent } from './dmWatcher.ts';
import { readRecentComments, probeCommentRequests, mediaIdFromShortcode } from './commentScraper.ts';
import { CommentWatcher, type IgCommentEvent } from './commentWatcher.ts';
import { replyToComment, openThreadWithUser, alreadyReplied, dmLanded } from './commentPoster.ts';
import { sendThreadMessage, SendNotConfirmedError } from './dmScraperPuppeteer.ts';

const PORT = Number(process.env.PORT ?? 8091);
const IG_BRIDGE_SECRET = process.env.IG_BRIDGE_SECRET ?? 'dev-ig-bridge-secret-change-me';
const KIRANA_API_URL = process.env.KIRANA_API_URL ?? 'http://127.0.0.1:8080';
const authDir = path.join(import.meta.dirname, '..', '.ig_bridge_auth');

const app = Fastify({ logger: true });

/**
 * A session key is a division's profile name, issued by the CRM: Marketing's
 * is the bare tenant id (what every profile was called before divisions
 * existed), any other division's is `<tenantId>-<division>`. The tenant id
 * the CRM wants on every event is therefore recoverable from the key alone;
 * the copy persisted at login time is preferred when it exists.
 */
const SESSION_KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-[a-z]+)?$/i;
function tenantIdFromSessionKey(sessionKey: string): string | null {
  const match = SESSION_KEY.exec(sessionKey);
  return match ? match[1]!.toLowerCase() : null;
}
async function tenantOf(sessionKey: string): Promise<string> {
  return (await sessions.getTenantId(sessionKey)) ?? tenantIdFromSessionKey(sessionKey) ?? sessionKey;
}

async function postEvent(ev: DmWatcherEvent | IgCommentEvent): Promise<void> {
  // Comments spool through their own route: they are not messages, and the
  // ig-bridge webhook keys DMs on (thread, sender, seq, text), which a
  // comment has none of.
  const path = ev.event === 'comment' ? '/v1/webhooks/ig-comments' : '/v1/webhooks/ig-bridge';
  try {
    const res = await fetch(`${KIRANA_API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${IG_BRIDGE_SECRET}` },
      // Both identities on the wire: the profile the event came off, and the
      // tenant the CRM files it under.
      body: JSON.stringify({ ...ev, tenantId: await tenantOf(ev.sessionKey) }),
    });
    if (!res.ok) {
      app.log.warn({ status: res.status, event: ev.event }, 'kirana api rejected an ig-bridge event');
    } else {
      app.log.info({ event: ev.event, sessionKey: ev.sessionKey }, 'ig-bridge event posted to kirana api');
    }
  } catch (err) {
    app.log.error({ err, event: ev.event }, 'could not reach kirana api');
  }
}

const sessions = new SessionManager(authDir);
const watcher = new DmWatcher(sessions, (ev) => void postEvent(ev), app.log);
// `start()`'s own first housekeeping pass already resumes every tenant with
// a persisted profile — `tsx watch` restarts on every code change, and in
// production any redeploy or crash does the same, so this can't be a
// one-time thing done only right after login. A second, separate startup
// loop here used to duplicate that exact pass, racing it: both tried to
// launch Chrome against the same `userDataDir` at once, and Chrome's own
// single-instance lock (`ProcessSingleton`) rejected the second launch.
watcher.start();

const comments = new CommentWatcher(sessions, (ev) => void postEvent(ev), app.log);
comments.start();

/**
 * Absorbing an error is only right once the service is actually serving.
 *
 * The same handler in `apps/wa-bridge` swallowed an `EADDRINUSE` from a
 * restart racing the previous process for the port, leaving a process that
 * logged happily and listened to nothing — invisible, because the dying
 * process still answered `/healthz`. A failure before `listen` resolves means
 * this process never became the service.
 */
let listening = false;

function onFatal(err: unknown, kind: string): void {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') {
    app.log.error({ err }, `${kind}: port ${PORT} is already held by another ig-bridge — exiting`);
    process.exit(1);
  }
  if (!listening) {
    app.log.error({ err }, `${kind} before ig-bridge was serving — exiting instead of pretending to run`);
    process.exit(1);
  }
  app.log.error({ err }, `${kind} in ig-bridge — continuing`);
}

process.on('uncaughtException', (err) => onFatal(err, 'uncaught exception'));
process.on('unhandledRejection', (err) => onFatal(err, 'unhandled rejection'));

// A tenant's browser legitimately keeps more than one tab open at once (the
// long-lived inbox observer plus a short-lived reader/request tab) — left
// running when the process is killed instead of closed, Chrome's own
// session restore tries to reopen all of them at once on the next launch,
// which headless mode outright refuses (confirmed live:
// `Multiple targets are not supported in headless mode`). `tsx watch`
// restarts on every save via SIGTERM, so this is the common case, not an
// edge case — closing every browser first is what keeps a routine restart
// from corrupting a tenant's session state.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'ig-bridge shutting down — closing browsers');
  watcher.stop();
  comments.stop();
  await sessions.closeAll().catch((err) => app.log.warn({ err }, 'ig-bridge: error closing browsers on shutdown'));
  await app.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Internal service only — same shared-secret pattern as apps/wa-bridge, never
// exposed publicly.
app.addHook('onRequest', async (req, reply) => {
  if (req.headers.authorization !== `Bearer ${IG_BRIDGE_SECRET}`) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
});

app.get('/healthz', async () => ({ status: 'ok' }));

// The CRM names the tenant on every login request so events can carry it
// without a lookup; a request that omits it (an older CRM) leaves the key to
// speak for itself.
const rememberTenant = async (sessionKey: string, tenantId: string | undefined): Promise<void> => {
  if (tenantId) await sessions.persistTenantId(sessionKey, tenantId);
};

app.post<{ Params: { sessionKey: string }; Body: { username: string; password: string; tenantId?: string } }>(
  '/internal/sessions/:sessionKey/login', async (req, reply) => {
    const { username, password, tenantId } = req.body ?? {};
    if (!username || !password) return reply.status(400).send({ error: 'username and password are required' });
    await rememberTenant(req.params.sessionKey, tenantId);
    const result = await sessions.login(req.params.sessionKey, username, password);
    if (result.status === 'ready') await watcher.attachTenant(req.params.sessionKey);
    return reply.send(result);
  });

app.post<{ Params: { sessionKey: string }; Body: { username: string; sessionId: string; csrfToken?: string; dsUserId?: string; tenantId?: string } }>(
  '/internal/sessions/:sessionKey/login-cookie', async (req, reply) => {
    const { username, sessionId, csrfToken, dsUserId, tenantId } = req.body ?? {};
    if (!username || !sessionId) return reply.status(400).send({ error: 'username and sessionId are required' });
    await rememberTenant(req.params.sessionKey, tenantId);
    const result = await sessions.loginWithCookie(req.params.sessionKey, username, sessionId, csrfToken, dsUserId);
    if (result.status === 'ready') await watcher.attachTenant(req.params.sessionKey);
    return reply.send(result);
  });

/**
 * Opens Instagram's own login page in a real window on this machine.
 *
 * Returns `awaiting_login` straight away — a person has to type a password and
 * very likely fetch a 2FA code, which is minutes, not seconds. The CRM polls
 * `/status`. Attaching the watcher happens here rather than in the CRM, because
 * the login settles long after the request that started it has been answered.
 */
app.post<{ Params: { sessionKey: string }; Body: { tenantId?: string } | undefined }>(
  '/internal/sessions/:sessionKey/login-window', async (req, reply) => {
    await rememberTenant(req.params.sessionKey, req.body?.tenantId);
    const result = await sessions.openLoginWindow(req.params.sessionKey, (settled) => {
      if (settled.status !== 'ready') return;
      void watcher.attachTenant(req.params.sessionKey)
        .catch((err) => app.log.warn({ err }, 'ig-bridge: failed to attach after browser login'));
    });
    return reply.send(result);
  });

app.post<{ Params: { sessionKey: string }; Body: { code: string } }>(
  '/internal/sessions/:sessionKey/challenge', async (req, reply) => {
    const { code } = req.body ?? {};
    if (!code) return reply.status(400).send({ error: 'code is required' });
    const result = await sessions.submitChallenge(req.params.sessionKey, code);
    if (result.status === 'ready') await watcher.attachTenant(req.params.sessionKey);
    return reply.send(result);
  });

/**
 * Read-only: what is actually sitting on our own recent posts right now.
 *
 * Nothing is written from here — it is the probe that answers "does this
 * session still work, and does the account have comments to read" before
 * anything is ingested, and it stays as the way to check that afterwards.
 */
app.get<{ Params: { sessionKey: string }; Querystring: { limit?: string; all?: string } }>(
  '/internal/sessions/:sessionKey/comments', async (req, reply) => {
    const username = await sessions.getOwnUsername(req.params.sessionKey);
    if (!username) return reply.status(404).send({ error: 'no active session for this tenant' });

    const page = await sessions.newPage(req.params.sessionKey);
    if (!page) return reply.status(404).send({ error: 'no active session for this tenant' });
    try {
      const limit = Math.min(Math.max(Number(req.query?.limit ?? 6) || 6, 1), 12);
      const comments = await readRecentComments(page, username, limit, { includeOwn: req.query?.all === 'true' });
      return reply.send({ username, count: comments.length, comments });
    } catch (err) {
      // Deliberately does NOT call `forgetSession`. Reading comments is a
      // diagnostic, and this route guessing "the session is dead" from one
      // unparseable response tears down a session the DM watcher is still
      // using — which it did, on the very first live run, from a plain
      // rate-limit page. Only the DM path, which can tell a redirect to the
      // login form apart from a throttle, is allowed to make that call.
      app.log.warn({ err, sessionKey: req.params.sessionKey }, 'ig-bridge could not read comments');
      return reply.status(502).send({ error: err instanceof Error ? err.message : 'Gagal membaca komentar' });
    } finally {
      await page.close().catch(() => {});
    }
  });

/**
 * Read one of instagram.com's own JSON endpoints through this tenant's
 * session and hand back the raw answer.
 *
 * Diagnostic only, and GET-only by construction: when a reader disagrees
 * with what is actually on a post, the argument is settled by looking at
 * what Instagram really returns, not by reasoning about the parser. Reading
 * the parsed result is what let a double-post happen — the parser said
 * "no reply here" while two were plainly under the post.
 */
app.get<{ Params: { sessionKey: string }; Querystring: { path?: string } }>(
  '/internal/sessions/:sessionKey/ig-get', async (req, reply) => {
    const path = req.query?.path ?? '';
    if (!path.startsWith('/api/v1/')) {
      return reply.status(400).send({ error: 'path must start with /api/v1/' });
    }

    const page = await sessions.newPage(req.params.sessionKey);
    if (!page) return reply.status(404).send({ error: 'no active session for this tenant' });
    try {
      if (!page.url().includes('instagram.com')) {
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      }
      const raw = await page.evaluate(`
        (async function () {
          try {
            var res = await fetch(${JSON.stringify(path)}, {
              headers: { 'x-ig-app-id': '936619743392459', 'accept': 'application/json' },
              credentials: 'include',
            });
            return JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 400000) });
          } catch (err) { return JSON.stringify({ status: 0, body: String(err) }); }
        })();
      `) as string;
      return reply.send(JSON.parse(raw));
    } finally {
      await page.close().catch(() => {});
    }
  });

/**
 * Ask the duplicate guard its answer, without posting anything.
 *
 * The guard is the one piece of this feature that must never be wrong, and
 * the only way it was being tested was by posting — which is how a comment
 * ended up answered twice. This makes it checkable for free.
 */
app.get<{ Params: { sessionKey: string }; Querystring: { postRef?: string; commentRef?: string } }>(
  '/internal/sessions/:sessionKey/comments/replied', async (req, reply) => {
    const { postRef, commentRef } = req.query ?? {};
    if (!postRef || !commentRef) return reply.status(400).send({ error: 'postRef and commentRef are required' });
    const mediaId = mediaIdFromShortcode(postRef);
    if (!mediaId) return reply.status(400).send({ error: `postRef tidak valid: ${postRef}` });

    const ownUsername = await sessions.getOwnUsername(req.params.sessionKey);
    if (!ownUsername) return reply.status(404).send({ error: 'no active session for this tenant' });
    const page = await sessions.newPage(req.params.sessionKey);
    if (!page) return reply.status(404).send({ error: 'no active session for this tenant' });

    try {
      if (!page.url().includes('instagram.com')) {
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      }
      return reply.send({
        mediaId,
        alreadyReplied: await alreadyReplied(page, { mediaId, commentRef, ownUsername }),
      });
    } finally {
      await page.close().catch(() => {});
    }
  });

/**
 * Can we open a DM thread with this person at all? Opens it and reports the
 * thread id, without sending a word.
 *
 * Reaching a stranger is the half that keeps failing, and the only way it
 * was being tested was by running the whole reply — which meant a public
 * post every time we wanted to learn one fact about the DM.
 */
app.get<{ Params: { sessionKey: string }; Querystring: { username?: string } }>(
  '/internal/sessions/:sessionKey/dm-probe', async (req, reply) => {
    const username = req.query?.username;
    if (!username) return reply.status(400).send({ error: 'username is required' });

    const page = await sessions.newPage(req.params.sessionKey);
    if (!page) return reply.status(404).send({ error: 'no active session for this tenant' });
    try {
      const threadId = await openThreadWithUser(page, username);
      return reply.send({ username, reachable: !!threadId, threadId });
    } catch (err) {
      return reply.send({ username, reachable: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      await page.close().catch(() => {});
    }
  });

/** Diagnostic for the above — see `probeCommentRequests`. Read-only. */
app.get<{ Params: { sessionKey: string } }>(
  '/internal/sessions/:sessionKey/comment-probe', async (req, reply) => {
    const username = await sessions.getOwnUsername(req.params.sessionKey);
    if (!username) return reply.status(404).send({ error: 'no active session for this tenant' });

    const page = await sessions.newPage(req.params.sessionKey);
    if (!page) return reply.status(404).send({ error: 'no active session for this tenant' });
    try {
      return reply.send(await probeCommentRequests(page, username));
    } catch (err) {
      app.log.warn({ err, sessionKey: req.params.sessionKey }, 'ig-bridge comment probe failed');
      return reply.status(502).send({ error: err instanceof Error ? err.message : 'Probe gagal' });
    } finally {
      await page.close().catch(() => {});
    }
  });

app.get<{ Params: { sessionKey: string } }>('/internal/sessions/:sessionKey/status', async (req, reply) => {
  const hasSession = await sessions.hasSession(req.params.sessionKey);

  // A live session that never recorded whose it is. Recoverable, and worth
  // recovering here rather than making the operator disconnect and log in
  // again for a session that works. Only ever runs when one is missing.
  let username = await sessions.getOwnUsername(req.params.sessionKey);
  if (hasSession && !username && !sessions.isAwaitingLogin(req.params.sessionKey)) {
    username = await sessions.recoverOwnUsername(req.params.sessionKey).catch(() => null);
  }

  return reply.send({
    hasSession,
    // Only meaningful for the browser-login flow: a window is open on this
    // machine and a person is part-way through it. The CRM shows that rather
    // than "disconnected", which would invite them to start a second one.
    awaitingLogin: sessions.isAwaitingLogin(req.params.sessionKey),
    username,
    // Masked. See `capturedFor` — `sessionid` is the credential itself.
    captured: sessions.capturedFor(req.params.sessionKey),
  });
});

app.post<{ Params: { sessionKey: string; threadId: string }; Body: { text: string; username?: string } }>(
  '/internal/sessions/:sessionKey/threads/:threadId/send', async (req, reply) => {
    const { text, username } = req.body ?? {};
    if (!text) return reply.status(400).send({ error: 'text is required' });
    try {
      await sessions.sendDm(req.params.sessionKey, req.params.threadId, text, username);
      watcher.markSentByUs(req.params.sessionKey, req.params.threadId, text);
      return reply.send({ sent: true });
    } catch (err) {
      app.log.warn({ err, sessionKey: req.params.sessionKey, threadId: req.params.threadId }, 'ig-bridge send failed');
      const status = err instanceof NoActiveSessionError ? 404 : 502;
      return reply.status(status).send({ error: err instanceof Error ? err.message : 'Gagal mengirim pesan Instagram' });
    }
  });

/**
 * Answer one comment: a short line in public, the real reply in DM.
 *
 * Both halves are reported separately because they fail separately and the
 * caller records them separately — Instagram will happily accept the public
 * reply and refuse the DM (a commenter who has never messaged us may simply
 * not be reachable), and that is a normal outcome, not an error.
 */
app.post<{
  Params: { sessionKey: string };
  Body: { postRef?: string; commentRef?: string; commenter?: string; publicReply?: string; dmText?: string };
}>('/internal/sessions/:sessionKey/comments/reply', async (req, reply) => {
  const { postRef, commentRef, commenter, publicReply, dmText } = req.body ?? {};
  if (!postRef || !commentRef || !commenter) {
    return reply.status(400).send({ error: 'postRef, commentRef and commenter are required' });
  }

  // The caller stores the permalink shortcode, which is the media id in
  // another base — converted here, where that function already lives, so the
  // CRM never has to carry a second copy of it.
  const mediaId = mediaIdFromShortcode(postRef);
  if (!mediaId) return reply.status(400).send({ error: `postRef tidak valid: ${postRef}` });

  const ownUsername = await sessions.getOwnUsername(req.params.sessionKey);
  if (!ownUsername) return reply.status(404).send({ error: 'no active session for this tenant' });

  const page = await sessions.newPage(req.params.sessionKey);
  if (!page) return reply.status(404).send({ error: 'no active session for this tenant' });

  const result: {
    public: { sent: boolean; error?: string };
    dm: { sent: boolean; alreadyThere?: boolean; threadId?: string; error?: string };
  } = { public: { sent: false }, dm: { sent: false } };

  try {
    if (publicReply) {
      try {
        await replyToComment(page, { mediaId, commentRef, text: publicReply, ownUsername });
        result.public.sent = true;
      } catch (err) {
        result.public.error = err instanceof Error ? err.message : 'Gagal membalas komentar';
        app.log.warn({ err, commentRef }, 'ig-bridge public comment reply failed');
      }
    }

    // The DM goes second, on purpose: that is the order the person
    // experiences it — they see the reply under the post, then find the DM.
    if (dmText) {
      try {
        const threadId = await openThreadWithUser(page, commenter);
        if (!threadId) {
          result.dm.error = `@${commenter}: tombol Message diklik tapi thread tidak pernah terbuka`;
        // `IG_COMMENT_FORCE_DM=true` sends the opener even to someone who
        // already has it. That is not a behaviour anyone wants in front of
        // real prospects — it is how the same introduction reaches one person
        // three times — so it exists only to exercise this path on a test
        // account that has already been through it once, and stays off unless
        // it is deliberately switched on.
        } else if (process.env.IG_COMMENT_FORCE_DM !== 'true' && await dmLanded(page, commenter, dmText)) {
          // The sender has its own pre-send check, but it reads the thread
          // the same blind way — so on a retry it would send this a second
          // time to someone who already has it. Asked of the inbox instead,
          // the answer is correct for link-rendered messages too.
          app.log.info({ commenter }, 'ig-bridge: DM already in this thread — not sending again');
          // Reported apart from a real send. "We sent it" and "they already
          // had it, so we did not" are different facts, and the second one
          // dressed as the first is what makes someone go looking through
          // Instagram for a message that was never sent.
          result.dm = { sent: false, alreadyThere: true, threadId };
        } else {
          // Only a message that appears after this instant can be the one
          // being sent now — see `dmLanded`.
          const startedAt = Date.now() - 5_000;
          try {
            await sendThreadMessage(page, threadId, dmText, ownUsername);
          } catch (err) {
            // "Typed but not seen in the thread" is not the same as "not
            // sent". Confirmed live: the opener arrives as a link preview
            // (it names a domain), which the thread scrape cannot see, and
            // treating that as a failure is what would message a stranger a
            // second time. Instagram's own inbox settles it.
            if (!(err instanceof SendNotConfirmedError)
              || !(await dmLanded(page, commenter, dmText, { sinceMs: startedAt }))) throw err;
            app.log.info({ commenter }, 'ig-bridge: DM confirmed through the inbox, not the thread view');
          }
          watcher.markSentByUs(req.params.sessionKey, threadId, dmText);
          result.dm = { sent: true, threadId };
        }
      } catch (err) {
        result.dm.error = err instanceof Error ? err.message : 'Gagal mengirim DM';
        app.log.warn({ err, commenter }, 'ig-bridge comment DM failed');
      }
    }
    return reply.send(result);
  } finally {
    await page.close().catch(() => {});
  }
});

app.delete<{ Params: { sessionKey: string } }>('/internal/sessions/:sessionKey', async (req, reply) => {
  await sessions.logout(req.params.sessionKey);
  return reply.status(204).send();
});

await app.listen({ port: PORT, host: '127.0.0.1' });
listening = true;
app.log.info(`ig-bridge listening on 127.0.0.1:${PORT}`);
