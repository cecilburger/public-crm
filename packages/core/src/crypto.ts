import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope encryption.
 *
 *   KEK (env / KMS, never in the database)
 *     └─ wraps DEK        — one per tenant, encrypts message bodies, phone numbers, credentials
 *     └─ wraps INDEX KEY  — one per tenant, derives blind indexes for equality lookup
 *
 * Ciphertexts are bound to their tenant with AES-GCM additional authenticated
 * data, so a row copied into another tenant fails to decrypt instead of
 * silently revealing itself.
 */
const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export type Ciphertext = string; // v1.<iv>.<ct>.<tag>, all base64url

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function loadKek(b64: string): Buffer {
  const kek = Buffer.from(b64, 'base64');
  if (kek.length !== KEY_BYTES) {
    throw new Error(`KEK must be ${KEY_BYTES} bytes base64-encoded, got ${kek.length}`);
  }
  return kek;
}

export function encrypt(key: Buffer, plaintext: string, aad?: string): Ciphertext {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decrypt(key: Buffer, payload: Ciphertext, aad?: string): string {
  const [version, ivB64, ctB64, tagB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !ctB64 || !tagB64) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivB64, 'base64url'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Per-tenant data keys, generated once at tenant creation and stored wrapped. */
export interface WrappedTenantKeys {
  wrappedDek: Ciphertext;
  wrappedIndexKey: Ciphertext;
}

export function generateTenantKeys(kek: Buffer, tenantId: string): WrappedTenantKeys {
  return {
    wrappedDek: encrypt(kek, randomKey().toString('base64'), `dek:${tenantId}`),
    wrappedIndexKey: encrypt(kek, randomKey().toString('base64'), `idx:${tenantId}`),
  };
}

export function unwrapTenantKeys(kek: Buffer, tenantId: string, wrapped: WrappedTenantKeys) {
  return {
    dek: Buffer.from(decrypt(kek, wrapped.wrappedDek, `dek:${tenantId}`), 'base64'),
    indexKey: Buffer.from(decrypt(kek, wrapped.wrappedIndexKey, `idx:${tenantId}`), 'base64'),
  };
}

/**
 * Blind index: lets us find a contact by phone number without storing the phone
 * number in a searchable form. Deterministic per tenant, useless across tenants.
 */
export function blindIndex(indexKey: Buffer, value: string): string {
  return createHmac('sha256', indexKey).update(value.trim().toLowerCase(), 'utf8').digest('hex');
}

/* ---------------------------------------------------------------- passwords */

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/**
 * scrypt with OWASP-grade parameters. Argon2id is the preferred production
 * choice — swap this module's two functions for @node-rs/argon2 and the rest of
 * the codebase is unaffected. Hashes are self-describing so both can coexist
 * during a migration.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------------------ tokens */

export const sha256 = (v: string | Buffer): string => createHash('sha256').update(v).digest('hex');

/** Opaque secret for refresh tokens and API keys. Only the hash is persisted. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Meta signs webhooks as sha256=<hex> over the *raw* body. Verifying a
 * re-serialised body is the classic way this check gets silently defeated.
 */
export function verifyWebhookSignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(header.slice(7), expected);
}

/**
 * Audit events are chained: each row commits to the previous one, so deleting or
 * editing history breaks the chain and the nightly verifier notices.
 */
export function auditHash(prevHash: string | null, event: Record<string, unknown>): string {
  const canonical = JSON.stringify(event, Object.keys(event).sort());
  return sha256(`${prevHash ?? 'genesis'}|${canonical}`);
}
