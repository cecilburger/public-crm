import { describe, it, expect } from 'vitest';
import {
  encrypt, decrypt, randomKey, generateTenantKeys, unwrapTenantKeys, loadKek,
  blindIndex, hashPassword, verifyPassword, verifyWebhookSignature, auditHash, newSecret, sha256,
} from '@kirana/core';
import { createHmac } from 'node:crypto';

describe('field encryption', () => {
  const key = randomKey();

  it('round-trips a value', () => {
    const ct = encrypt(key, 'Bu Sari +628123456789');
    expect(ct).not.toContain('628123456789');
    expect(decrypt(key, ct)).toBe('Bu Sari +628123456789');
  });

  it('produces a different ciphertext every time', () => {
    expect(encrypt(key, 'same')).not.toBe(encrypt(key, 'same'));
  });

  it('detects a tampered ciphertext instead of returning garbage', () => {
    const ct = encrypt(key, 'Rp 480.000');
    const [v, iv, body, tag] = ct.split('.');
    const flipped = Buffer.from(body!, 'base64url');
    if (flipped.length === 0) throw new Error('empty ciphertext');
    flipped[0] = (flipped[0] as number) ^ 0xff;
    expect(() => decrypt(key, `${v}.${iv}.${flipped.toString('base64url')}.${tag}`)).toThrow();
  });

  it('refuses to decrypt a row moved into another tenant', () => {
    const ct = encrypt(key, '+628123456789', 't:tenant-a');
    expect(decrypt(key, ct, 't:tenant-a')).toBe('+628123456789');
    expect(() => decrypt(key, ct, 't:tenant-b')).toThrow();
  });
});

describe('envelope encryption', () => {
  it('wraps and unwraps per-tenant keys under the KEK', () => {
    const kek = loadKek(randomKey().toString('base64'));
    const wrapped = generateTenantKeys(kek, 'tenant-a');
    const keys = unwrapTenantKeys(kek, 'tenant-a', wrapped);

    expect(keys.dek).toHaveLength(32);
    expect(keys.indexKey).toHaveLength(32);
    expect(keys.dek.equals(keys.indexKey)).toBe(false);
  });

  it("will not unwrap one tenant's keys as another's", () => {
    const kek = loadKek(randomKey().toString('base64'));
    const wrapped = generateTenantKeys(kek, 'tenant-a');
    expect(() => unwrapTenantKeys(kek, 'tenant-b', wrapped)).toThrow();
  });

  it('rejects a KEK of the wrong size rather than silently truncating', () => {
    expect(() => loadKek(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('blind index', () => {
  const a = randomKey();
  const b = randomKey();

  it('is deterministic, so a lookup finds the contact', () => {
    expect(blindIndex(a, '+628123456789')).toBe(blindIndex(a, '+628123456789'));
  });

  it('does not reveal the value', () => {
    expect(blindIndex(a, '+628123456789')).not.toContain('628123456789');
  });

  it('gives different tenants different indexes for the same number', () => {
    expect(blindIndex(a, '+628123456789')).not.toBe(blindIndex(b, '+628123456789'));
  });
});

describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('Correct horse battery staple', stored)).toBe(false);
  });

  it('salts, so identical passwords do not collide in the dump', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('rejects a malformed or empty stored hash instead of passing', () => {
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'plaintext')).toBe(false);
    expect(verifyPassword('anything', 'argon2id$v=19$whatever')).toBe(false);
  });
});

describe('webhook signatures', () => {
  const secret = 'meta-app-secret';
  const body = Buffer.from(JSON.stringify({ entry: [{ id: '1' }] }));
  const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts a correct signature over the raw bytes', () => {
    expect(verifyWebhookSignature(secret, body, good)).toBe(true);
  });

  it('rejects a missing, malformed or wrong signature', () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'nonsense')).toBe(false);
    expect(verifyWebhookSignature(secret, body, `sha256=${'0'.repeat(64)}`)).toBe(false);
  });

  it('rejects a signature computed over re-serialised JSON', () => {
    // The classic mistake: signing JSON.stringify(JSON.parse(body)), which
    // differs from the bytes Meta actually signed whenever key order or
    // whitespace differs.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString())) + ' ');
    expect(verifyWebhookSignature(secret, reserialised, good)).toBe(false);
  });
});

describe('audit chain', () => {
  it('changes the hash when any field changes', () => {
    const a = auditHash(null, { action: 'auth.login', actor: 'u1' });
    const b = auditHash(null, { action: 'auth.login', actor: 'u2' });
    expect(a).not.toBe(b);
  });

  it('is order-independent over keys but dependent on the previous link', () => {
    expect(auditHash(null, { a: 1, b: 2 })).toBe(auditHash(null, { b: 2, a: 1 } as Record<string, unknown>));
    expect(auditHash('prev-1', { a: 1 })).not.toBe(auditHash('prev-2', { a: 1 }));
  });
});

describe('secrets', () => {
  it('generates unguessable, url-safe tokens', () => {
    const s = newSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(s);
  });

  it('stores only hashes', () => {
    const token = newSecret();
    expect(sha256(token)).toHaveLength(64);
    expect(sha256(token)).not.toContain(token);
  });
});
