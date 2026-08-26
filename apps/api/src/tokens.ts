import { SignJWT, jwtVerify } from 'jose';
import { newSecret, sha256, type Role } from '@kirana/core';
import type { Sql } from '@kirana/db';

export interface AccessClaims {
  sub: string;      // user id
  tid: string;      // tenant id
  role: Role;
  fam: string;      // refresh-token family, so a revoked family kills access too
}

const enc = (secret: string) => new TextEncoder().encode(secret);

export async function issueAccessToken(secret: string, ttlSeconds: number, claims: AccessClaims): Promise<string> {
  return new SignJWT({ tid: claims.tid, role: claims.role, fam: claims.fam })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer('kirana')
    .setAudience('kirana-api')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(enc(secret));
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, enc(secret), { issuer: 'kirana', audience: 'kirana-api' });
  return { sub: String(payload.sub), tid: String(payload.tid), role: payload.role as Role, fam: String(payload.fam) };
}

/**
 * The ticket handed out between "password accepted" and "second factor
 * accepted". Deliberately short-lived, single-purpose, and useless on any other
 * endpoint — it is not a session, it is a receipt for half of one.
 */
export async function issueMfaToken(
  secret: string, ttlSeconds: number, claims: { sub: string; tid: string },
): Promise<string> {
  return new SignJWT({ tid: claims.tid, purpose: 'mfa' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer('kirana')
    .setAudience('kirana-mfa')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(enc(secret));
}

export async function verifyMfaToken(secret: string, token: string): Promise<{ sub: string; tid: string }> {
  const { payload } = await jwtVerify(token, enc(secret), { issuer: 'kirana', audience: 'kirana-mfa' });
  if (payload.purpose !== 'mfa') throw new Error('Not an MFA token');
  return { sub: String(payload.sub), tid: String(payload.tid) };
}

/**
 * Refresh tokens rotate on every use and are stored only as hashes. Presenting
 * an already-rotated token means it was copied, so the entire family is revoked
 * rather than just that one token.
 */
export async function issueRefreshToken(
  tx: Sql,
  args: { tenantId: string; userId: string; familyId: string; ttlSeconds: number; ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; id: string }> {
  const token = newSecret(32);
  const rows = await tx.query<{ id: string }>(
    `insert into refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at, ip, user_agent)
     values ($1,$2,$3,$4, now() + make_interval(secs => $5), $6, $7) returning id`,
    [args.tenantId, args.userId, args.familyId, sha256(token), args.ttlSeconds, args.ip ?? null, args.userAgent ?? null],
  );
  return { token, id: rows[0]!.id };
}

export type RotateResult =
  | { ok: true; userId: string; familyId: string; token: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' };

export async function rotateRefreshToken(
  tx: Sql, tenantId: string, presented: string, ttlSeconds: number,
): Promise<RotateResult> {
  const rows = await tx.query<{
    id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null; replaced_by: string | null;
  }>(
    `select id, user_id, family_id, expires_at, revoked_at, replaced_by
       from refresh_tokens where tenant_id = $1 and token_hash = $2`,
    [tenantId, sha256(presented)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };

  if (row.replaced_by || row.revoked_at) {
    // Someone is using a token we already rotated away. Burn the family.
    await tx.query(
      `update refresh_tokens set revoked_at = now(), revoke_reason = 'reuse_detected'
        where tenant_id = $1 and family_id = $2 and revoked_at is null`,
      [tenantId, row.family_id],
    );
    // Rotation sets `replaced_by` *and* `revoked_at`, so testing revoked_at first
    // would report every replay as a plain revocation and the reuse signal would
    // never fire. A superseded token presented again is reuse; only a token
    // revoked without a successor (a sign-out) is merely revoked.
    return { ok: false, reason: row.replaced_by ? 'reused' : 'revoked' };
  }
  if (new Date(row.expires_at) <= new Date()) return { ok: false, reason: 'expired' };

  const next = await issueRefreshToken(tx, {
    tenantId, userId: row.user_id, familyId: row.family_id, ttlSeconds,
  });
  await tx.query(
    `update refresh_tokens set replaced_by = $3, revoked_at = now(), revoke_reason = 'rotated'
      where tenant_id = $1 and id = $2`,
    [tenantId, row.id, next.id],
  );

  return { ok: true, userId: row.user_id, familyId: row.family_id, token: next.token };
}

export async function revokeFamily(tx: Sql, tenantId: string, familyId: string, reason = 'logout'): Promise<void> {
  await tx.query(
    `update refresh_tokens set revoked_at = now(), revoke_reason = $3
      where tenant_id = $1 and family_id = $2 and revoked_at is null`,
    [tenantId, familyId, reason],
  );
}

export async function familyRevoked(tx: Sql, tenantId: string, familyId: string): Promise<boolean> {
  const rows = await tx.query<{ n: number }>(
    `select count(*)::int as n from refresh_tokens
      where tenant_id = $1 and family_id = $2 and revoke_reason = 'reuse_detected'`,
    [tenantId, familyId],
  );
  return (rows[0]?.n ?? 0) > 0;
}
