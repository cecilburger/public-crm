import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { env, totp, base32Decode } from '@kirana/core';
import { withTenant, type Database } from '@kirana/db';
import { buildApp } from '../apps/api/src/app.ts';
import { freshDb, makeTenant, TEST_KEK, type TestTenant } from './helpers/db.ts';

const PASSWORD = 'correct horse battery staple';

describe('two-factor sign-in', () => {
  let db: Database;
  let app: FastifyInstance;
  let t: TestTenant;
  let access = '';
  let secret = '';
  let backupCodes: string[] = [];
  let mfaSession = '';

  const codeNow = (offsetSeconds = 0) =>
    totp(base32Decode(secret), Math.floor(Date.now() / 1000) + offsetSeconds);

  const login = () => app.inject({
    method: 'POST', url: '/v1/auth/login',
    payload: { workspace: 'mfa', email: 'owner@mfa.test', password: PASSWORD },
  });

  const verify = (mfaToken: string, code: string) => app.inject({
    method: 'POST', url: '/v1/auth/mfa/verify',
    payload: { workspace: 'mfa', mfaToken, code },
  });

  beforeAll(async () => {
    db = await freshDb();
    t = await makeTenant(db, 'mfa');
    app = buildApp({ db, control: db, kek: TEST_KEK, env: env(), dispatch: async () => {} });
    await app.ready();
    access = (await login()).json().accessToken;
  });
  afterAll(async () => { await app.close(); await db.close(); });

  it('starts switched off', async () => {
    const res = await app.inject({
      method: 'GET', url: '/v1/auth/mfa', headers: { authorization: `Bearer ${access}` },
    });
    expect(res.json()).toEqual({ enabled: false, pending: false, backupCodesLeft: 0 });
  });

  it('hands out a secret an authenticator app can scan', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/mfa/setup', headers: { authorization: `Bearer ${access}` },
    });
    expect(res.statusCode).toBe(200);
    secret = res.json().secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.json().uri).toContain('otpauth://totp/');
  });

  it('stores the secret sealed, not in the clear', async () => {
    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ mfa_secret_enc: string }>('select mfa_secret_enc from users limit 1'));
    expect(rows[0]!.mfa_secret_enc).toMatch(/^v1\./);
    expect(rows[0]!.mfa_secret_enc).not.toContain(secret);
  });

  it('refuses to switch on until the app proves it works', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/v1/auth/mfa/enable',
      headers: { authorization: `Bearer ${access}` }, payload: { code: '000000' },
    });
    expect(bad.statusCode).toBe(422);

    const still = await app.inject({
      method: 'GET', url: '/v1/auth/mfa', headers: { authorization: `Bearer ${access}` },
    });
    expect(still.json().enabled).toBe(false);
    expect(still.json().pending).toBe(true);
  });

  it('switches on with a real code and hands back recovery codes once', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/mfa/enable',
      headers: { authorization: `Bearer ${access}` }, payload: { code: codeNow() },
    });
    expect(res.statusCode).toBe(200);
    backupCodes = res.json().backupCodes;
    expect(backupCodes).toHaveLength(10);

    const status = await app.inject({
      method: 'GET', url: '/v1/auth/mfa', headers: { authorization: `Bearer ${access}` },
    });
    expect(status.json()).toMatchObject({ enabled: true, backupCodesLeft: 10 });
  });

  it('stores recovery codes hashed', async () => {
    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ code_hash: string }>('select code_hash from mfa_backup_codes limit 1'));
    expect(rows[0]!.code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(backupCodes.some((c) => rows[0]!.code_hash.includes(c))).toBe(false);
  });

  it('stops handing out a session for the password alone', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mfaRequired).toBe(true);
    expect(body.mfaToken).toBeDefined();
    // The half-finished sign-in must not carry a usable session.
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
  });

  it('accepts a code once, then refuses the replay of it', async () => {
    // Enabling spent the current code, so this uses the next window's — accepted
    // by the one-step drift allowance. Only one success is possible per window,
    // which is exactly the property being tested.
    const code = codeNow(30);

    const first = await verify((await login()).json().mfaToken, code);
    expect(first.statusCode).toBe(200);
    expect(first.json().usedBackupCode).toBe(false);
    mfaSession = first.json().accessToken;

    const me = await app.inject({
      method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${mfaSession}` },
    });
    expect(me.statusCode).toBe(200);

    // Arithmetically still valid for another few seconds — and spent.
    const replay = await verify((await login()).json().mfaToken, code);
    expect(replay.statusCode).toBe(401);
  });

  it('refuses a wrong code', async () => {
    const wrong = codeNow() === '000000' ? '111111' : '000000';
    expect((await verify((await login()).json().mfaToken, wrong)).statusCode).toBe(401);
  });

  it('refuses a forged or expired receipt', async () => {
    expect((await verify('not.a.valid.jwt.at.all.but.long.enough', codeNow(30))).statusCode).toBe(401);
  });

  it('lets a lost phone in with a recovery code, exactly once', async () => {
    const code = backupCodes[0]!;
    const first = await verify((await login()).json().mfaToken, code);
    expect(first.statusCode).toBe(200);
    expect(first.json().usedBackupCode).toBe(true);

    const reuse = await verify((await login()).json().mfaToken, code);
    expect(reuse.statusCode).toBe(401);

    const status = await app.inject({
      method: 'GET', url: '/v1/auth/mfa',
      headers: { authorization: `Bearer ${first.json().accessToken}` },
    });
    expect(status.json().backupCodesLeft).toBe(9);
  });

  it('accepts a recovery code however the user types it', async () => {
    const messy = backupCodes[1]!.toLowerCase().replace('-', ' ');
    expect((await verify((await login()).json().mfaToken, messy)).statusCode).toBe(200);
  });

  it('stops guessing after a few wrong codes', async () => {
    const { mfaToken } = (await login()).json();
    const wrong = codeNow() === '999999' ? '888888' : '999999';
    for (let i = 0; i < 6; i += 1) await verify(mfaToken, wrong);

    const blocked = await verify(mfaToken, wrong);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('can be switched off again, taking the recovery codes with it', async () => {
    // Reuses the session from earlier: the guessing test above has this user
    // locked out of /mfa/verify, which is the point of it.
    const off = await app.inject({
      method: 'POST', url: '/v1/auth/mfa/disable',
      headers: { authorization: `Bearer ${mfaSession}` }, payload: { code: codeNow() },
    });
    expect(off.statusCode).toBe(200);

    const rows = await withTenant(db, t.tenantId, (tx) =>
      tx.query<{ n: number }>('select count(*)::int as n from mfa_backup_codes'));
    expect(rows[0]!.n).toBe(0);

    // And the password alone is a full sign-in again.
    expect((await login()).json().accessToken).toBeDefined();
  });
});
