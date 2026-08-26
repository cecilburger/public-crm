import { unwrapTenantKeys, generateTenantKeys, encrypt, decrypt, blindIndex, type Ciphertext } from '@kirana/core';
import type { Sql } from './sql.ts';

/**
 * Unwrapped data keys, cached in memory only. Never logged, never serialised,
 * and dropped on a short TTL so a rotated or revoked key stops working quickly.
 */
export interface TenantKeys {
  dek: Buffer;
  /**
   * Present only while a rotation is in flight. Rows not yet re-encrypted are
   * still under this one, so every read tries it as a fallback.
   */
  previousDek?: Buffer;
  /**
   * Deliberately **not** rotated alongside the DEK. Blind indexes are derived
   * from it, and changing it mid-flight would leave half the contacts indexed
   * under the old key — a lookup would miss them and create a duplicate customer.
   * Its compromise leaks equality, not content, so it is a separate and much
   * rarer operation.
   */
  indexKey: Buffer;
}

interface CachedKeys extends TenantKeys { loadedAt: number }
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedKeys>();

export function forgetTenantKeys(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId); else cache.clear();
}

export async function tenantKeys(tx: Sql, kek: Buffer, tenantId: string): Promise<CachedKeys> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit;

  const rows = await tx.query<{
    wrapped_dek: string; wrapped_index_key: string; previous_wrapped_dek: string | null;
  }>(
    'select wrapped_dek, wrapped_index_key, previous_wrapped_dek from tenant_keys where tenant_id = $1',
    [tenantId],
  );
  if (!rows[0]) throw new Error(`No data keys provisioned for tenant ${tenantId}`);

  const { dek, indexKey } = unwrapTenantKeys(kek, tenantId, {
    wrappedDek: rows[0].wrapped_dek,
    wrappedIndexKey: rows[0].wrapped_index_key,
  });
  const previousDek = rows[0].previous_wrapped_dek
    ? Buffer.from(decrypt(kek, rows[0].previous_wrapped_dek, `dek:${tenantId}`), 'base64')
    : undefined;

  const entry: CachedKeys = { dek, indexKey, previousDek, loadedAt: Date.now() };
  cache.set(tenantId, entry);
  return entry;
}

export async function provisionTenantKeys(tx: Sql, kek: Buffer, tenantId: string): Promise<void> {
  const wrapped = generateTenantKeys(kek, tenantId);
  await tx.query(
    `insert into tenant_keys (tenant_id, wrapped_dek, wrapped_index_key)
     values ($1, $2, $3) on conflict (tenant_id) do nothing`,
    [tenantId, wrapped.wrappedDek, wrapped.wrappedIndexKey],
  );
}

/**
 * Helpers that bind every ciphertext to its tenant via AES-GCM AAD.
 *
 * Writes always use the current key. Reads try the current key and fall back to
 * the previous one, which is the whole trick that lets a rotation run in the
 * background without a maintenance window.
 */
export const sealField = (keys: TenantKeys, tenantId: string, plaintext: string): Ciphertext =>
  encrypt(keys.dek, plaintext, `t:${tenantId}`);

export function openField(keys: TenantKeys, tenantId: string, ct: Ciphertext): string {
  try {
    return decrypt(keys.dek, ct, `t:${tenantId}`);
  } catch (err) {
    // Only a rotation in flight justifies a second attempt; otherwise a failure
    // here means tampering or the wrong tenant, and it should surface.
    if (!keys.previousDek) throw err;
    return decrypt(keys.previousDek, ct, `t:${tenantId}`);
  }
}

export const fieldIndex = (indexKey: Buffer, value: string): string => blindIndex(indexKey, value);
