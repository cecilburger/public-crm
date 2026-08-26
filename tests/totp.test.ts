import { describe, it, expect } from 'vitest';
import {
  hotp, totp, verifyTotp, base32Encode, base32Decode,
  newTotpSecret, otpauthUri, newBackupCodes, normaliseBackupCode,
} from '@kirana/core';

/** RFC 6238 Appendix B, SHA-1 rows. The reason this is worth implementing. */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP against the RFC test vectors', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  it('reproduces every 8-digit vector', () => {
    for (const [time, expected] of vectors) {
      expect(totp(RFC_SECRET, time, 8)).toBe(expected);
    }
  });

  it('reproduces them at the 6 digits authenticator apps actually use', () => {
    for (const [time, expected] of vectors) {
      expect(totp(RFC_SECRET, time)).toBe(expected.slice(-6));
    }
  });

  it('matches RFC 4226 HOTP for counter 0', () => {
    expect(hotp(RFC_SECRET, 0)).toBe('755224');
  });
});

describe('verifying a code', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const now = 1_111_111_111;

  it('accepts the current code', () => {
    expect(verifyTotp(secret, totp(secret, now), now).ok).toBe(true);
  });

  it('tolerates one step of clock drift either way', () => {
    expect(verifyTotp(secret, totp(secret, now - 30), now).ok).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + 30), now).ok).toBe(true);
  });

  it('refuses a code two steps out', () => {
    expect(verifyTotp(secret, totp(secret, now - 90), now).ok).toBe(false);
    expect(verifyTotp(secret, totp(secret, now + 90), now).ok).toBe(false);
  });

  it('reports which counter matched, so a replay can be caught', () => {
    const result = verifyTotp(secret, totp(secret, now), now);
    expect(result.counter).toBe(Math.floor(now / 30));
  });

  it('refuses anything that is not six digits', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ']) {
      expect(verifyTotp(secret, bad, now).ok).toBe(false);
    }
  });

  it('refuses a wrong code from the right secret', () => {
    const wrong = totp(secret, now) === '000000' ? '111111' : '000000';
    expect(verifyTotp(secret, wrong, now).ok).toBe(false);
  });
});

describe('base32', () => {
  it('round-trips', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '12345678901234567890']) {
      expect(base32Decode(base32Encode(Buffer.from(text))).toString()).toBe(text);
    }
  });

  it('encodes the RFC secret the way authenticator apps expect', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('rejects characters that are not base32', () => {
    expect(() => base32Decode('ABC!')).toThrow();
  });
});

describe('enrollment material', () => {
  it('builds a scannable otpauth URI with the issuer encoded', () => {
    const uri = otpauthUri({ secret: RFC_SECRET, account: 'rani@toko demo.id', issuer: 'Kirana' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Kirana%3Arani%40toko%20demo\.id\?/);
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('generates secrets that differ', () => {
    expect(newTotpSecret().equals(newTotpSecret())).toBe(false);
    expect(newTotpSecret()).toHaveLength(20);
  });

  it('issues ten readable single-use backup codes', () => {
    const codes = newBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
  });

  it('accepts a backup code however the user types it', () => {
    expect(normaliseBackupCode('a1b2c-3d4e5')).toBe('A1B2C3D4E5');
    expect(normaliseBackupCode(' A1B2C 3D4E5 ')).toBe('A1B2C3D4E5');
  });
});
