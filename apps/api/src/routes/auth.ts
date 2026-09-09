import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  AppError, unauthenticated, invalid, verifyPassword, hashPassword, checkLimit, loginKey, type Role,
} from '@kirana/core';
import { withTenant, resolveWorkspace, audit } from '@kirana/db';
import type { AppCtx } from '../app.ts';
import { issueAccessToken, issueRefreshToken, rotateRefreshToken, revokeFamily, issueMfaToken } from '../tokens.ts';

const loginBody = z.object({
  workspace: z.string().min(1).max(64),
  email: z.string().email(),
  password: z.string().min(8).max(512),
});

/**
 * Sign-in attempts are limited on (workspace, email), not on IP: credential
 * stuffing rotates IPs and does not rotate targets. Sharing the API's store
 * means the limit holds across replicas too.
 */
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60_000;

export function registerAuthRoutes(app: FastifyInstance, ctx: AppCtx): void {

  app.post('/v1/auth/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) throw invalid('Check the workspace, email and password fields');
    const { workspace, email, password } = parsed.data;

    const key = loginKey(workspace, email);
    const verdict = await checkLimit(ctx.rateLimits, key, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS);
    if (!verdict.allowed) {
      reply.header('retry-after', String(verdict.retryAfterSeconds));
      // Only raise on the first refusal, not on every retry behind the wall.
      if (verdict.count === LOGIN_MAX_ATTEMPTS + 1) {
        const known = await resolveWorkspace(ctx.control, workspace);
        if (known) void ctx.raise(known.id, 'login_lockout', { email, ip: req.ip });
      }
      throw new AppError('rate_limited', 'Too many sign-in attempts. Try again in a few minutes.');
    }

    // Resolving a workspace slug is the one read that cannot happen inside a
    // tenant context, so it uses the control-plane pool and returns nothing else.
    const tenant = await resolveWorkspace(ctx.control, workspace);
    // Same error and comparable timing whether the workspace, the email or the
    // password was wrong — none of them should be discoverable from outside.
    const dummy = '$scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

    if (!tenant) {
      verifyPassword(password, dummy);
      throw unauthenticated('Those sign-in details do not match');
    }
    if (tenant.status === 'suspended' || tenant.status === 'closed') {
      throw new AppError('forbidden', 'This workspace is suspended. Contact billing.');
    }

    const result = await withTenant(ctx.db, tenant.id, async (tx) => {
      const users = await tx.query<{
        id: string; password_hash: string | null; role: Role; status: string; name: string;
        mfa_enabled_at: Date | null;
      }>(
        `select id, password_hash, role, status, name, mfa_enabled_at
           from users where tenant_id = $1 and lower(email) = $2`,
        [tenant.id, email.toLowerCase()],
      );
      const user = users[0];
      if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
        verifyPassword(password, dummy);
        return null;
      }
      if (user.status !== 'active') return null;

      // Password accepted. If a second factor is switched on, stop here and hand
      // back a receipt — no session exists until the code is checked.
      if (user.mfa_enabled_at) {
        await audit(tx, tenant.id, {
          actorType: 'user', actorId: user.id, action: 'auth.password_accepted_mfa_pending',
          resourceType: 'user', resourceId: user.id, ip: req.ip,
        });
        return { mfaPending: true as const, user };
      }

      const familyId = randomUUID();
      const refresh = await issueRefreshToken(tx, {
        tenantId: tenant.id, userId: user.id, familyId,
        ttlSeconds: ctx.env.REFRESH_TOKEN_TTL_S,
        ip: req.ip, userAgent: req.headers['user-agent'] ?? null,
      });
      await tx.query('update users set last_login_at = now() where tenant_id = $1 and id = $2', [tenant.id, user.id]);
      await audit(tx, tenant.id, {
        actorType: 'user', actorId: user.id, action: 'auth.login', resourceType: 'user', resourceId: user.id,
        ip: req.ip, userAgent: req.headers['user-agent'] ?? null,
      });
      return { user, familyId, refresh: refresh.token };
    });

    if (!result) throw unauthenticated('Those sign-in details do not match');
    // A successful sign-in clears the counter, so a person who mistypes twice
    // and then gets it right does not stay one slip away from a lockout.
    await ctx.rateLimits.reset(key);

    if ('mfaPending' in result) {
      const mfaToken = await issueMfaToken(ctx.env.JWT_SECRET, 300, { sub: result.user.id, tid: tenant.id });
      return reply.send({ mfaRequired: true, mfaToken, expiresIn: 300 });
    }

    const access = await issueAccessToken(ctx.env.JWT_SECRET, ctx.env.ACCESS_TOKEN_TTL_S, {
      sub: result.user.id, tid: tenant.id, role: result.user.role, fam: result.familyId,
    });

    return reply.send({
      accessToken: access,
      refreshToken: result.refresh,
      expiresIn: ctx.env.ACCESS_TOKEN_TTL_S,
      user: { id: result.user.id, name: result.user.name, role: result.user.role, tenantId: tenant.id },
    });
  });

  app.post('/v1/auth/refresh', async (req) => {
    const parsed = z.object({ workspace: z.string(), refreshToken: z.string().min(20) }).safeParse(req.body);
    if (!parsed.success) throw invalid('A workspace and refresh token are required');

    const tenant = await resolveWorkspace(ctx.control, parsed.data.workspace);
    if (!tenant) throw unauthenticated('Session is no longer valid');

    const rotated = await withTenant(ctx.db, tenant.id, (tx) =>
      rotateRefreshToken(tx, tenant.id, parsed.data.refreshToken, ctx.env.REFRESH_TOKEN_TTL_S));

    if (!rotated.ok) {
      if (rotated.reason === 'reused') {
        await withTenant(ctx.db, tenant.id, (tx) => audit(tx, tenant.id, {
          actorType: 'system', action: 'auth.refresh_reuse_detected', resourceType: 'session',
          ip: req.ip, meta: { outcome: 'family_revoked' },
        }));
        // A token presented twice means a copy of it exists somewhere.
        void ctx.raise(tenant.id, 'refresh_token_reuse', { ip: req.ip, workspace: parsed.data.workspace });
      }
      throw unauthenticated('Session is no longer valid');
    }

    const user = await withTenant(ctx.db, tenant.id, async (tx) => {
      const rows = await tx.query<{ role: Role }>('select role from users where tenant_id = $1 and id = $2',
        [tenant.id, rotated.userId]);
      return rows[0];
    });
    if (!user) throw unauthenticated('Session is no longer valid');

    const access = await issueAccessToken(ctx.env.JWT_SECRET, ctx.env.ACCESS_TOKEN_TTL_S, {
      sub: rotated.userId, tid: tenant.id, role: user.role, fam: rotated.familyId,
    });
    return { accessToken: access, refreshToken: rotated.token, expiresIn: ctx.env.ACCESS_TOKEN_TTL_S };
  });

  app.post('/v1/auth/logout', async (req) => {
    const actor = ctx.requireActor(req);
    const header = req.headers.authorization!;
    const claims = JSON.parse(Buffer.from(header.slice(7).split('.')[1]!, 'base64url').toString()) as { fam: string };
    await withTenant(ctx.db, actor.tenantId, async (tx) => {
      await revokeFamily(tx, actor.tenantId, claims.fam);
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'auth.logout', resourceType: 'session', ip: req.ip,
      });
    });
    return { ok: true };
  });

  app.get('/v1/me', async (req) => {
    const actor = ctx.requireActor(req);
    return ctx.asTenant(req, async (tx) => {
      const rows = await tx.query<{ id: string; name: string; email: string; role: Role }>(
        'select id, name, email, role from users where tenant_id = $1 and id = $2',
        [actor.tenantId, actor.userId],
      );
      const tenant = await tx.query<{ name: string; slug: string; status: string }>(
        'select name, slug, status from tenants where id = $1', [actor.tenantId]);
      // The access token's subject can outlive the row it points to (a
      // removed member, or a dev database reseeded under a live session) —
      // treat that as "no longer signed in", not as a page to render broken.
      if (!rows[0] || !tenant[0]) throw unauthenticated('Session no longer valid');
      return { user: rows[0], workspace: tenant[0] };
    });
  });

  app.get('/v1/members', async (req) => {
    ctx.guard(req, 'conversation:read');
    return ctx.asTenant(req, (tx, actor) =>
      tx.query(
        `select id, name, email, role, status, last_login_at
           from users where tenant_id = $1 order by name asc limit 200`,
        [actor.tenantId]));
  });

  app.post('/v1/members', async (req, reply) => {
    const actor = ctx.guard(req, 'member:manage');
    const parsed = z.object({
      email: z.string().email(), name: z.string().min(1),
      password: z.string().min(12), role: z.enum(['admin', 'supervisor', 'agent', 'viewer']),
    }).safeParse(req.body);
    if (!parsed.success) throw invalid('Check the new member details');

    const created = await ctx.asTenant(req, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `insert into users (tenant_id, email, name, password_hash, role, status)
         values ($1,$2,$3,$4,$5,'active') returning id`,
        [actor.tenantId, parsed.data.email.toLowerCase(), parsed.data.name,
         hashPassword(parsed.data.password), parsed.data.role],
      );
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'member.invited',
        resourceType: 'user', resourceId: rows[0]!.id, meta: { role: parsed.data.role },
      });
      return rows[0]!;
    });
    return reply.status(201).send(created);
  });
}
