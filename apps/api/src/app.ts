import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import {
  AppError, unauthenticated, forbidden, actorCan, checkLimit, MemoryRateLimitStore, tenantKey, ipKey,
  LogAlertSink,
  type Actor, type Permission, type Role, type Env, type RateLimitStore,
  type AlertSink, type SecurityEventKind,
} from '@kirana/core';
import { withTenant, recordSecurityEvent, type Database, type Sql } from '@kirana/db';
import { verifyAccessToken, familyRevoked } from './tokens.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerConversationRoutes } from './routes/conversations.ts';
import { registerBillingRoutes } from './routes/billing.ts';
import { registerWebhookRoutes } from './routes/webhooks.ts';
import { registerGovernanceRoutes } from './routes/governance.ts';
import { registerAutopilotRoutes } from './routes/autopilot.ts';
import { registerCheckoutRoutes } from './routes/checkout.ts';
import { registerMfaRoutes } from './routes/mfa.ts';
import { registerSecurityRoutes } from './routes/security.ts';
import { registerWaBridgeChannelRoutes } from './routes/waBridgeChannels.ts';
import { registerContactRoutes } from './routes/contacts.ts';
import { registry, httpRequests, httpDuration, routeLabel } from './metrics.ts';

/** What a webhook is handed to once it is spooled and verified. */
export type Dispatch = (job: { queue: string; payload: unknown }) => Promise<void>;

/** Everything a route module is allowed to reach. */
export interface AppCtx extends AppDeps {
  rateLimits: RateLimitStore;
  /** Record that we became aware of something, and tell someone. Never throws. */
  raise(tenantId: string, kind: SecurityEventKind, detail?: Record<string, unknown>): Promise<void>;
  /** The resolved sink, for signals that belong to no tenant. */
  alertSink: AlertSink;
  requireActor(req: FastifyRequest): Actor;
  guard(req: FastifyRequest, permission: Permission): Actor;
  asTenant<T>(req: FastifyRequest, fn: (tx: Sql, actor: Actor) => Promise<T>): Promise<T>;
}

export interface AppDeps {
  /** Tenant-scoped pool, connects as `kirana_app`. */
  db: Database;
  /** Control-plane pool: tenant lookup at login and the webhook spool only. */
  control: Database;
  kek: Buffer;
  env: Env;
  dispatch: Dispatch;
  /** Redis in production; an in-process Map otherwise. */
  rateLimits?: RateLimitStore;
  /** Test hook: override the per-minute API budget. */
  rateLimit?: { max: number; windowMs: number };
  /** Where security alerts go. Logs if not supplied. */
  alerts?: AlertSink;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    rawBody?: Buffer;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.env.LOG_LEVEL,
      // Never let a secret reach the log shipper.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]',
                'req.headers["x-hub-signature-256"]', '*.password', '*.token', '*.secret'],
        censor: '[redacted]',
      },
      serializers: {
        req: (r: FastifyRequest) => ({ method: r.method, url: r.url, id: r.id }),
      },
    },
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  app.register(helmet, {
    // JSON API: no scripts to police, but the transport and framing headers matter.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  app.register(cors, {
    origin: deps.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    maxAge: 600,
  });

  // Meta signs the bytes it sent, so we must verify the bytes we received —
  // re-serialising the parsed body is how this check gets quietly defeated.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try { done(null, JSON.parse((body as Buffer).toString('utf8'))); }
    catch { done(new AppError('validation_failed', 'Body is not valid JSON'), undefined); }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (!err.expose) req.log.error({ err }, 'request failed');
      return reply.status(err.status).type('application/problem+json').send(err.toProblem(req.url));
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).type('application/problem+json')
        .send(new AppError('rate_limited', 'Too many requests').toProblem(req.url));
    }
    // A query that tried to leave its tenant is not an ordinary 500. The
    // database refused it, which means the isolation held — and it also means
    // something asked, which is worth knowing about within the hour.
    if (/row-level security/i.test((err as Error).message ?? '') && req.actor) {
      void ctx.raise(req.actor.tenantId, 'cross_tenant_denied', {
        path: req.url, method: req.method, actorId: req.actor.userId,
      });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.status(500).type('application/problem+json')
      .send(new AppError('internal', 'Unexpected error').toProblem(req.url));
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    return payload;
  });

  /* ------------------------------------------------------------ auth hook */

  app.decorateRequest('actor', undefined);

  // One store for every limit in the system, so two replicas share a counter
  // instead of each politely allowing the whole budget.
  const store = deps.rateLimits ?? new MemoryRateLimitStore();
  const budget = deps.rateLimit ?? { max: deps.env.RATE_LIMIT_PER_MINUTE, windowMs: 60_000 };
  const alerts = deps.alerts ?? new LogAlertSink();

  // Recording that we noticed must never be able to break the thing we noticed.
  const raise: AppCtx['raise'] = async (tenantId, kind, detail = {}) => {
    try {
      const { alert } = await withTenant(deps.db, tenantId, (tx) =>
        recordSecurityEvent(tx, tenantId, kind, detail));
      await alerts.deliver(alert);
    } catch (err) {
      app.log.error({ err, kind, tenantId }, 'could not record security event');
    }
  };

  // Unauthenticated by design: health probes, the sign-in pair, the provider
  // webhook (which authenticates by signature) and the public price calculator.
  const PUBLIC = new Set(['/healthz', '/readyz', '/metrics', '/v1/auth/login', '/v1/auth/refresh',
                          '/v1/webhooks/meta', '/v1/webhooks/wa-bridge', '/v1/billing/estimate',
                          '/v1/billing/plans', '/v1/auth/mfa/verify']);

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? '';
    // The checkout page authenticates by capability: the link code itself.
    if (PUBLIC.has(path) || path.startsWith('/bayar/')) return;

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthenticated();

    let claims;
    try {
      claims = await verifyAccessToken(deps.env.JWT_SECRET, header.slice(7));
    } catch {
      throw unauthenticated('Access token is invalid or expired');
    }

    // A stolen-and-rotated refresh token revokes its family; the short-lived
    // access tokens from that family have to die with it. Checked alongside
    // whether the tenant a token claims even exists any more — a signature is
    // still valid after the database behind it is wiped and reseeded (as the
    // in-memory `dev:stack` does on every restart), and without this a token
    // like that sails through every RLS-scoped read as an empty result right
    // up until the first write, which fails as a raw foreign-key violation
    // instead of the plain "sign in again" this should have been.
    const { tenantExists, dead } = await withTenant(deps.db, claims.tid, async (tx) => {
      const rows = await tx.query<{ id: string }>('select id from tenants where id = $1', [claims.tid]);
      return { tenantExists: !!rows[0], dead: await familyRevoked(tx, claims.tid, claims.fam) };
    });
    if (!tenantExists) throw unauthenticated('Session no longer valid');
    if (dead) throw unauthenticated('Session revoked');

    req.actor = { userId: claims.sub, tenantId: claims.tid, role: claims.role as Role };
  });

  // Registered after the auth hook so the tenant is known: per workspace once
  // signed in, per IP before that. The provider webhook is exempt — it
  // authenticates by signature and has to absorb bursts.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (path.startsWith('/v1/webhooks/') || path === '/healthz' || path === '/readyz') return;

    const key = req.actor ? tenantKey(req.actor.tenantId) : ipKey(req.ip);
    const verdict = await checkLimit(store, key, budget.max, budget.windowMs);

    reply.header('x-ratelimit-limit', String(budget.max));
    reply.header('x-ratelimit-remaining', String(verdict.remaining));
    reply.header('x-ratelimit-reset', String(Math.ceil(verdict.resetAt / 1000)));

    if (!verdict.allowed) {
      reply.header('retry-after', String(verdict.retryAfterSeconds));
      throw new AppError('rate_limited', 'Too many requests. Slow down and try again shortly.');
    }
  });

  /* -------------------------------------------------------------- helpers */

  const requireActor = (req: FastifyRequest): Actor => {
    if (!req.actor) throw unauthenticated();
    return req.actor;
  };

  const guard = (req: FastifyRequest, permission: Permission): Actor => {
    const actor = requireActor(req);
    if (!actorCan(actor, permission)) throw forbidden(`This action needs ${permission}`);
    return actor;
  };

  const asTenant = <T>(req: FastifyRequest, fn: (tx: Sql, actor: Actor) => Promise<T>): Promise<T> => {
    const actor = requireActor(req);
    return withTenant(deps.db, actor.tenantId, (tx) => fn(tx, actor));
  };

  const ctx: AppCtx = { ...deps, rateLimits: store, raise, alertSink: alerts, requireActor, guard, asTenant };

  /* --------------------------------------------------------------- routes */

  // Every response is timed by route *pattern*, so a uuid in the path cannot
  // create a time series per conversation.
  app.addHook('onResponse', async (req, reply) => {
    const route = routeLabel(req.routeOptions?.url, req.url);
    const labels = { method: req.method, route };
    httpDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequests.inc({ ...labels, status: `${Math.floor(reply.statusCode / 100)}xx` });
  });

  app.get('/metrics', async (req, reply) => {
    // Traffic volumes and error rates are commercially interesting, so the
    // endpoint is guarded whenever a token is configured.
    if (deps.env.METRICS_TOKEN) {
      const header = req.headers.authorization;
      if (header !== `Bearer ${deps.env.METRICS_TOKEN}`) return reply.status(404).send();
    }
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.db.query('select 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  registerAuthRoutes(app, ctx);
  registerConversationRoutes(app, ctx);
  registerBillingRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerGovernanceRoutes(app, ctx);
  registerAutopilotRoutes(app, ctx);
  registerCheckoutRoutes(app, ctx);
  registerMfaRoutes(app, ctx);
  registerSecurityRoutes(app, ctx);
  registerWaBridgeChannelRoutes(app, ctx);
  registerContactRoutes(app, ctx);

  return app;
}
