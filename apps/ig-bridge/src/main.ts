import path from 'node:path';
import Fastify from 'fastify';
import { SessionManager } from './sessionManager.ts';

const PORT = Number(process.env.PORT ?? 8091);
const IG_BRIDGE_SECRET = process.env.IG_BRIDGE_SECRET ?? 'dev-ig-bridge-secret-change-me';
const authDir = path.join(import.meta.dirname, '..', '.ig_bridge_auth');

const app = Fastify({ logger: true });
const sessions = new SessionManager(authDir);

process.on('uncaughtException', (err) => {
  app.log.error({ err }, 'uncaught exception in ig-bridge — continuing');
});
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'unhandled rejection in ig-bridge — continuing');
});

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
    return reply.send(result);
  });

app.post<{ Params: { tenantId: string }; Body: { code: string } }>(
  '/internal/sessions/:tenantId/challenge', async (req, reply) => {
    const { code } = req.body ?? {};
    if (!code) return reply.status(400).send({ error: 'code is required' });
    const result = await sessions.submitChallenge(req.params.tenantId, code);
    return reply.send(result);
  });

app.get<{ Params: { tenantId: string } }>('/internal/sessions/:tenantId/status', async (req, reply) => {
  const hasSession = await sessions.hasSession(req.params.tenantId);
  return reply.send({ hasSession });
});

app.delete<{ Params: { tenantId: string } }>('/internal/sessions/:tenantId', async (req, reply) => {
  await sessions.logout(req.params.tenantId);
  return reply.status(204).send();
});

await app.listen({ port: PORT, host: '127.0.0.1' });
app.log.info(`ig-bridge listening on 127.0.0.1:${PORT}`);
