import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  AppError, unauthenticated, invalid, conflict, checkLimit,
  newTotpSecret, verifyTotp, otpauthUri, base32Encode, base32Decode,
  newBackupCodes, normaliseBackupCode, sha256, type Role,
} from '@kirana/core';
import { withTenant, resolveWorkspace, audit, tenantKeys, sealField, openField } from '@kirana/db';
import type { AppCtx } from '../app.ts';
import { issueAccessToken, issueRefreshToken, verifyMfaToken } from '../tokens.ts';

/** Codes are six digits; guessing is cheap unless attempts are not. */
const MFA_MAX_ATTEMPTS = 6;
const MFA_WINDOW_MS = 10 * 60_000;

export function registerMfaRoutes(app: FastifyInstance, ctx: AppCtx): void {

  app.get('/v1/auth/mfa', async (req) => {
    const actor = ctx.requireActor(req);
    return ctx.asTenant(req, async (tx) => {
      const rows = await tx.query<{ mfa_enabled_at: Date | null; mfa_secret_enc: string | null }>(
        'select mfa_enabled_at, mfa_secret_enc from users where tenant_id = $1 and id = $2',
        [actor.tenantId, actor.userId],
      );
      const unused = await tx.query<{ n: number }>(
        `select count(*)::int as n from mfa_backup_codes
          where tenant_id = $1 and user_id = $2 and used_at is null`,
        [actor.tenantId, actor.userId],
      );
      const enabled = Boolean(rows[0]?.mfa_enabled_at);
      const pending = Boolean(rows[0]?.mfa_secret_enc) && !enabled;

      // While enrolment is unfinished the secret is returned so the page can be
      // reloaded without starting over. It is useless to anyone who does not
      // already hold this session.
      let secret: string | undefined;
      let uri: string | undefined;
      if (pending && rows[0]?.mfa_secret_enc) {
        const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);
        secret = openField(keys, actor.tenantId, rows[0].mfa_secret_enc);
        const who = await tx.query<{ email: string }>(
          'select email from users where tenant_id = $1 and id = $2', [actor.tenantId, actor.userId]);
        const shop = await tx.query<{ name: string }>('select name from tenants where id = $1', [actor.tenantId]);
        uri = otpauthUri({
          secret: base32Decode(secret),
          account: who[0]?.email ?? 'user',
          issuer: `Kirana (${shop[0]?.name ?? 'workspace'})`,
        });
      }

      return { enabled, pending, backupCodesLeft: unused[0]?.n ?? 0, secret, uri };
    });
  });

  /** Step one: mint a secret. Stored sealed, but not yet switched on. */
  app.post('/v1/auth/mfa/setup', async (req) => {
    const actor = ctx.requireActor(req);
    return ctx.asTenant(req, async (tx) => {
      const users = await tx.query<{ email: string; mfa_enabled_at: Date | null }>(
        'select email, mfa_enabled_at from users where tenant_id = $1 and id = $2',
        [actor.tenantId, actor.userId],
      );
      if (!users[0]) throw unauthenticated();
      if (users[0].mfa_enabled_at) throw conflict('Two-factor is already switched on');

      const secret = newTotpSecret();
      const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);
      await tx.query(
        'update users set mfa_secret_enc = $3, mfa_last_counter = null where tenant_id = $1 and id = $2',
        [actor.tenantId, actor.userId, sealField(keys, actor.tenantId, base32Encode(secret))],
      );

      const workspace = await tx.query<{ name: string }>('select name from tenants where id = $1', [actor.tenantId]);
      return {
        secret: base32Encode(secret),
        uri: otpauthUri({ secret, account: users[0].email, issuer: `Kirana (${workspace[0]?.name ?? 'workspace'})` }),
      };
    });
  });

  /** Step two: prove the app works before anything is switched on. */
  app.post('/v1/auth/mfa/enable', async (req) => {
    const actor = ctx.requireActor(req);
    const body = z.object({ code: z.string().min(6).max(10) }).safeParse(req.body);
    if (!body.success) throw invalid('Enter the six-digit code from your authenticator app');

    return ctx.asTenant(req, async (tx) => {
      const users = await tx.query<{ mfa_secret_enc: string | null; mfa_enabled_at: Date | null }>(
        'select mfa_secret_enc, mfa_enabled_at from users where tenant_id = $1 and id = $2',
        [actor.tenantId, actor.userId],
      );
      const user = users[0];
      if (!user?.mfa_secret_enc) throw invalid('Start with /v1/auth/mfa/setup');
      if (user.mfa_enabled_at) throw conflict('Two-factor is already switched on');

      const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);
      const secret = base32Decode(openField(keys, actor.tenantId, user.mfa_secret_enc));
      const result = verifyTotp(secret, body.data.code, Math.floor(Date.now() / 1000));
      if (!result.ok) throw invalid('That code did not match. Check your phone clock and try again.');

      // Ten recovery codes, hashed here and shown to the user exactly once.
      const codes = newBackupCodes();
      for (const code of codes) {
        await tx.query(
          'insert into mfa_backup_codes (tenant_id, user_id, code_hash) values ($1,$2,$3)',
          [actor.tenantId, actor.userId, sha256(normaliseBackupCode(code))],
        );
      }
      await tx.query(
        'update users set mfa_enabled_at = now(), mfa_last_counter = $3 where tenant_id = $1 and id = $2',
        [actor.tenantId, actor.userId, result.counter ?? null],
      );
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'auth.mfa_enabled',
        resourceType: 'user', resourceId: actor.userId, ip: req.ip,
      });

      return { enabled: true, backupCodes: codes };
    });
  });

  app.post('/v1/auth/mfa/disable', async (req) => {
    const actor = ctx.requireActor(req);
    const body = z.object({ code: z.string().min(6).max(16) }).safeParse(req.body);
    if (!body.success) throw invalid('Confirm with a code from your authenticator app');

    return ctx.asTenant(req, async (tx) => {
      const users = await tx.query<{ mfa_secret_enc: string | null; mfa_enabled_at: Date | null }>(
        'select mfa_secret_enc, mfa_enabled_at from users where tenant_id = $1 and id = $2',
        [actor.tenantId, actor.userId],
      );
      const user = users[0];
      if (!user?.mfa_enabled_at || !user.mfa_secret_enc) throw conflict('Two-factor is not switched on');

      const keys = await tenantKeys(tx, ctx.kek, actor.tenantId);
      const secret = base32Decode(openField(keys, actor.tenantId, user.mfa_secret_enc));
      if (!verifyTotp(secret, body.data.code, Math.floor(Date.now() / 1000)).ok) {
        throw invalid('That code did not match');
      }

      await tx.query(
        `update users set mfa_enabled_at = null, mfa_secret_enc = null, mfa_last_counter = null
          where tenant_id = $1 and id = $2`,
        [actor.tenantId, actor.userId],
      );
      await tx.query('delete from mfa_backup_codes where tenant_id = $1 and user_id = $2',
        [actor.tenantId, actor.userId]);
      await audit(tx, actor.tenantId, {
        actorType: 'user', actorId: actor.userId, action: 'auth.mfa_disabled',
        resourceType: 'user', resourceId: actor.userId, ip: req.ip,
      });
      return { enabled: false };
    });
  });

  /**
   * The second half of a sign-in. Takes the receipt issued when the password was
   * accepted, plus a code — from the app, or one of the recovery codes.
   */
  app.post('/v1/auth/mfa/verify', async (req, reply) => {
    const body = z.object({
      workspace: z.string().min(1),
      mfaToken: z.string().min(20),
      code: z.string().min(6).max(16),
    }).safeParse(req.body);
    if (!body.success) throw invalid('A workspace, token and code are required');

    let claims;
    try {
      claims = await verifyMfaToken(ctx.env.JWT_SECRET, body.data.mfaToken);
    } catch {
      throw unauthenticated('That sign-in has expired. Start again.');
    }

    const limit = await checkLimit(ctx.rateLimits, `mfa:${claims.sub}`, MFA_MAX_ATTEMPTS, MFA_WINDOW_MS);
    if (!limit.allowed) {
      reply.header('retry-after', String(limit.retryAfterSeconds));
      if (limit.count === MFA_MAX_ATTEMPTS + 1) {
        void ctx.raise(claims.tid, 'mfa_lockout', { userId: claims.sub, ip: req.ip });
      }
      throw new AppError('rate_limited', 'Too many codes tried. Wait a few minutes.');
    }

    const workspace = await resolveWorkspace(ctx.control, body.data.workspace);
    if (!workspace || workspace.id !== claims.tid) throw unauthenticated('Session is no longer valid');

    const result = await withTenant(ctx.db, claims.tid, async (tx) => {
      const users = await tx.query<{
        id: string; name: string; role: Role; status: string;
        mfa_secret_enc: string | null; mfa_last_counter: string | null;
      }>(
        `select id, name, role, status, mfa_secret_enc, mfa_last_counter
           from users where tenant_id = $1 and id = $2`,
        [claims.tid, claims.sub],
      );
      const user = users[0];
      if (!user || user.status !== 'active' || !user.mfa_secret_enc) return null;

      const keys = await tenantKeys(tx, ctx.kek, claims.tid);
      const secret = base32Decode(openField(keys, claims.tid, user.mfa_secret_enc));
      const attempt = verifyTotp(secret, body.data.code, Math.floor(Date.now() / 1000));

      let usedBackupCode = false;
      if (attempt.ok) {
        // A code stays arithmetically valid for its whole 30-second window. Once
        // used it is spent, so a shoulder-surfed code cannot be used twice.
        const last = user.mfa_last_counter === null ? null : Number(user.mfa_last_counter);
        if (last !== null && attempt.counter !== undefined && attempt.counter <= last) return null;
        await tx.query('update users set mfa_last_counter = $3 where tenant_id = $1 and id = $2',
          [claims.tid, user.id, attempt.counter ?? null]);
      } else {
        const hash = sha256(normaliseBackupCode(body.data.code));
        const spent = await tx.query<{ id: string }>(
          `update mfa_backup_codes set used_at = now()
            where tenant_id = $1 and user_id = $2 and code_hash = $3 and used_at is null
            returning id`,
          [claims.tid, user.id, hash],
        );
        if (!spent[0]) return null;
        usedBackupCode = true;
      }

      const familyId = randomUUID();
      const refresh = await issueRefreshToken(tx, {
        tenantId: claims.tid, userId: user.id, familyId,
        ttlSeconds: ctx.env.REFRESH_TOKEN_TTL_S, ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      await tx.query('update users set last_login_at = now() where tenant_id = $1 and id = $2',
        [claims.tid, user.id]);
      await audit(tx, claims.tid, {
        actorType: 'user', actorId: user.id, action: 'auth.mfa_verified',
        resourceType: 'user', resourceId: user.id, ip: req.ip,
        meta: { usedBackupCode },
      });
      return { user, familyId, refresh: refresh.token, usedBackupCode };
    });

    if (!result) throw unauthenticated('That code did not match');
    await ctx.rateLimits.reset(`mfa:${claims.sub}`);

    const access = await issueAccessToken(ctx.env.JWT_SECRET, ctx.env.ACCESS_TOKEN_TTL_S, {
      sub: result.user.id, tid: claims.tid, role: result.user.role, fam: result.familyId,
    });
    return sendSession(reply, {
      access, refresh: result.refresh, ttl: ctx.env.ACCESS_TOKEN_TTL_S,
      user: result.user, tenantId: claims.tid, usedBackupCode: result.usedBackupCode,
    });
  });
}

function sendSession(reply: FastifyReply, args: {
  access: string; refresh: string; ttl: number;
  user: { id: string; name: string; role: Role }; tenantId: string; usedBackupCode: boolean;
}) {
  return reply.send({
    accessToken: args.access,
    refreshToken: args.refresh,
    expiresIn: args.ttl,
    usedBackupCode: args.usedBackupCode,
    user: { id: args.user.id, name: args.user.name, role: args.user.role, tenantId: args.tenantId },
  });
}
