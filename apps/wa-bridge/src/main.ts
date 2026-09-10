import path from 'node:path';
import Fastify from 'fastify';
import { SessionManager, type BridgeEvent } from './sessionManager.ts';

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
process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaught exception in wa-bridge — continuing');
});
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandled rejection in wa-bridge — continuing');
});

// Internal service only — never exposed publicly, authenticated by one shared
// secret rather than per-tenant tokens, the same way `apps/api` and
// `apps/worker` authenticate to each other for this channel.
app.addHook('onRequest', async (req, reply) => {
  if (req.headers.authorization !== `Bearer ${WA_BRIDGE_SECRET}`) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
});

app.get('/healthz', async () => ({ status: 'ok' }));

app.post<{ Params: { channelId: string } }>('/internal/sessions/:channelId/start', async (req, reply) => {
  await sessions.start(req.params.channelId);
  return reply.status(202).send({ started: true });
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
app.log.info(`wa-bridge listening on 127.0.0.1:${PORT}`);
