import path from 'node:path';
import Fastify from 'fastify';
import { SessionManager, NoActiveSessionError } from './sessionManager.ts';
import { DmWatcher, type DmWatcherEvent } from './dmWatcher.ts';

const PORT = Number(process.env.PORT ?? 8091);
const IG_BRIDGE_SECRET = process.env.IG_BRIDGE_SECRET ?? 'dev-ig-bridge-secret-change-me';
const KIRANA_API_URL = process.env.KIRANA_API_URL ?? 'http://127.0.0.1:8080';
const authDir = path.join(import.meta.dirname, '..', '.ig_bridge_auth');

const app = Fastify({ logger: true });

async function postEvent(ev: DmWatcherEvent): Promise<void> {
  try {
    const res = await fetch(`${KIRANA_API_URL}/v1/webhooks/ig-bridge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${IG_BRIDGE_SECRET}` },
      body: JSON.stringify(ev),
    });
    if (!res.ok) {
      app.log.warn({ status: res.status, event: ev.event }, 'kirana api rejected an ig-bridge event');
    } else {
      app.log.info({ event: ev.event, tenantId: ev.tenantId }, 'ig-bridge event posted to kirana api');
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

process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaught exception in ig-bridge — continuing');
});
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandled rejection in ig-bridge — continuing');
});

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

app.post<{ Params: { tenantId: string }; Body: { username: string; password: string } }>(
  '/internal/sessions/:tenantId/login', async (req, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) return reply.status(400).send({ error: 'username and password are required' });
    const result = await sessions.login(req.params.tenantId, username, password);
    if (result.status === 'ready') await watcher.attachTenant(req.params.tenantId);
    return reply.send(result);
  });

app.post<{ Params: { tenantId: string }; Body: { username: string; sessionId: string; csrfToken?: string; dsUserId?: string } }>(
  '/internal/sessions/:tenantId/login-cookie', async (req, reply) => {
    const { username, sessionId, csrfToken, dsUserId } = req.body ?? {};
    if (!username || !sessionId) return reply.status(400).send({ error: 'username and sessionId are required' });
    const result = await sessions.loginWithCookie(req.params.tenantId, username, sessionId, csrfToken, dsUserId);
    if (result.status === 'ready') await watcher.attachTenant(req.params.tenantId);
    return reply.send(result);
  });

app.post<{ Params: { tenantId: string }; Body: { code: string } }>(
  '/internal/sessions/:tenantId/challenge', async (req, reply) => {
    const { code } = req.body ?? {};
    if (!code) return reply.status(400).send({ error: 'code is required' });
    const result = await sessions.submitChallenge(req.params.tenantId, code);
    if (result.status === 'ready') await watcher.attachTenant(req.params.tenantId);
    return reply.send(result);
  });

app.get<{ Params: { tenantId: string } }>('/internal/sessions/:tenantId/status', async (req, reply) => {
  const hasSession = await sessions.hasSession(req.params.tenantId);
  return reply.send({ hasSession });
});

app.post<{ Params: { tenantId: string; threadId: string }; Body: { text: string } }>(
  '/internal/sessions/:tenantId/threads/:threadId/send', async (req, reply) => {
    const { text } = req.body ?? {};
    if (!text) return reply.status(400).send({ error: 'text is required' });
    try {
      await sessions.sendDm(req.params.tenantId, req.params.threadId, text);
      watcher.markSentByUs(req.params.tenantId, req.params.threadId, text);
      return reply.send({ sent: true });
    } catch (err) {
      app.log.warn({ err, tenantId: req.params.tenantId, threadId: req.params.threadId }, 'ig-bridge send failed');
      const status = err instanceof NoActiveSessionError ? 404 : 502;
      return reply.status(status).send({ error: err instanceof Error ? err.message : 'Gagal mengirim pesan Instagram' });
    }
  });

app.delete<{ Params: { tenantId: string } }>('/internal/sessions/:tenantId', async (req, reply) => {
  await sessions.logout(req.params.tenantId);
  return reply.status(204).send();
});

await app.listen({ port: PORT, host: '127.0.0.1' });
app.log.info(`ig-bridge listening on 127.0.0.1:${PORT}`);
