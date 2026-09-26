import path from 'node:path';
import Fastify from 'fastify';
import { SessionManager, NotAuthenticatedError, type BridgeEvent } from './sessionManager.ts';

const PORT = Number(process.env.PORT ?? 8090);
const KIRANA_API_URL = process.env.KIRANA_API_URL ?? 'http://127.0.0.1:8080';
const WA_BRIDGE_SECRET = process.env.WA_BRIDGE_SECRET ?? 'dev-wa-bridge-secret-change-me';
const authDir = path.join(import.meta.dirname, '..', '.wwebjs_auth');

async function postEvent(ev: BridgeEvent): Promise<void> {
  try {
    const res = await fetch(`${KIRANA_API_URL}/v1/webhooks/wa-bridge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WA_BRIDGE_SECRET}` },
      body: JSON.stringify(ev),
    });
    if (!res.ok) app.log.warn({ status: res.status, event: ev.event }, 'kirana api rejected a wa-bridge event');
  } catch (err) {
    app.log.error({ err, event: ev.event }, 'could not reach kirana api');
  }
}

const app = Fastify({ logger: true });
const sessions = new SessionManager(authDir, (ev) => void postEvent(ev));

/**
 * One process holds every tenant's WhatsApp session. whatsapp-web.js reinjects
 * its page script on each navigation (`framenavigated`), and that handler runs
 * detached from any call this service made — logging out or destroying a
 * client mid-reinject can race it, throwing "Execution context was destroyed"
 * with nothing left to catch it. Left alone, that one race kills the whole
 * process and every other tenant's live session along with it; logging it and
 * carrying on costs only that one event, not the service.
 */
/**
 * Carrying on is only right once the service is actually up.
 *
 * Confirmed live: a restart raced the previous process for the port, the
 * `EADDRINUSE` landed here, and this handler swallowed it — leaving a process
 * that was alive, logging, and listening to nothing at all. Nothing else
 * noticed: the port was still held by the dying process, so `/healthz` kept
 * answering, and WhatsApp stayed silently disconnected. A failure before the
 * server is listening is not a tenant-level hiccup to absorb; it means this
 * process never became the service, and it should get out of the way.
 */
let listening = false;

function onFatal(err: unknown, kind: string): void {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') {
    app.log.error({ err }, `${kind}: port ${PORT} is already held by another wa-bridge — exiting`);
    process.exit(1);
  }
  if (!listening) {
    app.log.error({ err }, `${kind} before wa-bridge was serving — exiting instead of pretending to run`);
    process.exit(1);
  }
  app.log.error({ err }, `${kind} in wa-bridge — continuing`);
}

process.on('uncaughtException', (err) => onFatal(err, 'uncaught exception'));
process.on('unhandledRejection', (err) => onFatal(err, 'unhandled rejection'));

// Internal service only — never exposed publicly, authenticated by one shared
// secret rather than per-tenant tokens, the same way `apps/api` and
// `apps/worker` authenticate to each other for this channel.
app.addHook('onRequest', async (req, reply) => {
  if (req.headers.authorization !== `Bearer ${WA_BRIDGE_SECRET}`) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
});

/**
 * Bring every already-authenticated session back up.
 *
 * Without this, a session only ever ran because a request started it — so
 * every restart (and `tsx watch` restarts on each save) left WhatsApp
 * silently deaf: the process healthy, `/healthz` fine, the channel row still
 * 'connected', and no inbound message reaching the CRM until somebody
 * noticed hours later and called the start endpoint by hand.
 */
async function resumeSessions(): Promise<void> {
  const channelIds = await sessions.resumable();
  if (channelIds.length === 0) {
    app.log.info('wa-bridge: no authenticated session to resume');
    return;
  }
  for (const channelId of channelIds) {
    try {
      await sessions.start(channelId);
      app.log.info({ channelId }, 'wa-bridge: resumed a saved WhatsApp session');
    } catch (err) {
      if (err instanceof NotAuthenticatedError) {
        // Said plainly, because this is the one failure here with an obvious
        // fix. `start` has already cleared the marker, so the next restart
        // will not try this session again until it is rescanned.
        app.log.warn({ channelId }, 'wa-bridge: saved session is no longer linked — rescan its QR to reconnect');
        continue;
      }
      app.log.warn({ err, channelId }, 'wa-bridge: could not resume a saved session');
    }
  }
}

app.get('/healthz', async () => ({ status: 'ok' }));

/**
 * How long a start request waits before answering "on its way".
 *
 * `initialize()` only resolves once web.whatsapp.com has fully loaded and the
 * library has injected itself — measured live at 10s on a good connection and
 * 87s on a slow one. The console's "Sambung ulang" / "Hubungkan nomor" sat on
 * that whole wait, looking frozen, while the QR it was waiting for had long
 * since arrived through the webhook. The QR never needed this response: it
 * travels as its own event. A fast failure (a login that is plainly gone) still
 * gets its 409; anything slower carries on in the background and reports
 * through the same events the console already reads.
 */
const START_WAIT_MS = 5_000;

app.post<{ Params: { channelId: string } }>('/internal/sessions/:channelId/start', async (req, reply) => {
  const channelId = req.params.channelId;
  const starting = sessions.start(channelId);
  try {
    const finished = await Promise.race([
      starting.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), START_WAIT_MS)),
    ]);
    if (!finished) {
      starting.catch((err) => {
        app.log.warn({ err, channelId }, 'wa-bridge: session failed to start in the background');
      });
    }
    return reply.status(202).send({ started: true });
  } catch (err) {
    // 409, not 500: nothing here is broken, the stored login is simply gone and
    // a person has to scan a code. A 500 carrying a `TypeError` about reading
    // 'Socket' sent whoever read it looking for a bug in this service.
    if (err instanceof NotAuthenticatedError) {
      return reply.status(409).send({ error: err.message, code: 'not_authenticated' });
    }
    throw err;
  }
});

app.post<{ Params: { channelId: string }; Body: { to: string; body: string } }>(
  '/internal/sessions/:channelId/send', async (req, reply) => {
    try {
      const sent = await sessions.send(req.params.channelId, req.body.to, req.body.body);
      return reply.send(sent);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      return reply.status(status).send({ error: (err as Error).message });
    }
  });

app.delete<{ Params: { channelId: string } }>('/internal/sessions/:channelId', async (req, reply) => {
  await sessions.stop(req.params.channelId);
  return reply.status(204).send();
});

await app.listen({ port: PORT, host: '127.0.0.1' });
listening = true;
app.log.info(`wa-bridge listening on 127.0.0.1:${PORT}`);

// After listening, not before: a session takes tens of seconds to come up,
// and blocking the port on it would make the service look dead to everything
// that polls it during a restart.
void resumeSessions();

// Nothing else notices a session dying in place. WhatsApp Web updates itself,
// reloads its interface, and the injected page scripts go with it — the
// process stays healthy and inbound messages simply stop. Checking costs one
// round trip every two minutes; not checking cost three silent outages in a
// single afternoon, each one found by a person waiting for a reply.
sessions.startHeartbeat((channelId) => {
  app.log.warn({ channelId }, 'wa-bridge: session stopped responding — restarting it');
  void sessions.start(channelId).catch((err) => {
    // A session whose login is gone is not a crash to retry. Restarting it
    // reopens the QR page, fails on the same missing module, and leaves
    // another tab behind — every two minutes, forever. The operator has
    // already been told to rescan through the `auth_failure` event, and the
    // session is no longer marked resumable, so this stops here.
    if (err instanceof NotAuthenticatedError) {
      app.log.warn({ channelId }, 'wa-bridge: session is logged out — waiting for a QR scan, not retrying');
      return;
    }
    app.log.error({ err, channelId }, 'wa-bridge: could not restart a dead session');
  });
});
