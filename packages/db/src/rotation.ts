import { randomKey, encrypt, decrypt, loadKek, type Ciphertext } from '@kirana/core';
import type { Database, Sql } from './sql.ts';
import { withTenant } from './tenant.ts';
import { allTenants } from './platform.ts';
import { tenantKeys, forgetTenantKeys, openField, sealField } from './keys.ts';
import { audit } from './audit.ts';

/**
 * Every column encrypted under a tenant's data key.
 *
 * Adding a new encrypted column and forgetting to add it here would leave it
 * readable only by a key we are about to throw away, so the list is checked
 * against the schema by a test rather than trusted.
 */
export const ENCRYPTED_COLUMNS: { table: string; columns: string[] }[] = [
  { table: 'contacts', columns: ['phone_enc', 'email_enc'] },
  { table: 'messages', columns: ['body_enc'] },
  { table: 'message_drafts', columns: ['body_enc'] },
  { table: 'channels', columns: ['credentials_enc'] },
  { table: 'users', columns: ['mfa_secret_enc'] },
  { table: 'orders', columns: ['recipient_enc', 'address_enc'] },
];

export interface RotationProgress {
  table: string;
  rowsDone: number;
  completed: boolean;
}

export interface RotationResult {
  tenantId: string;
  started: boolean;
  finished: boolean;
  progress: RotationProgress[];
}

/**
 * Step one: mint a new data key and keep the old one alongside it.
 *
 * After this returns, writes use the new key and reads try both. Nothing has
 * been re-encrypted yet, and the workspace has not noticed anything.
 */
export async function beginDekRotation(db: Database, kek: Buffer, tenantId: string): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.query<{ wrapped_dek: string; previous_wrapped_dek: string | null }>(
      'select wrapped_dek, previous_wrapped_dek from tenant_keys where tenant_id = $1',
      [tenantId],
    );
    if (!rows[0]) throw new Error(`No data keys for tenant ${tenantId}`);
    // A rotation already in flight must finish before another begins, or the
    // key two generations back becomes unreachable.
    if (rows[0].previous_wrapped_dek) return false;

    const fresh = encrypt(kek, randomKey().toString('base64'), `dek:${tenantId}`);
    await tx.query(
      `update tenant_keys
          set previous_wrapped_dek = wrapped_dek,
              wrapped_dek = $2,
              key_version = key_version + 1,
              rotation_started_at = now()
        where tenant_id = $1`,
      [tenantId, fresh],
    );
    await tx.query('delete from key_rotations where tenant_id = $1', [tenantId]);
    await audit(tx, tenantId, {
      actorType: 'system', action: 'keys.rotation_started', resourceType: 'tenant', resourceId: tenantId,
    });
    return true;
  }).finally(() => forgetTenantKeys(tenantId));
}

/**
 * Step two, run repeatedly: move a batch of rows onto the new key.
 *
 * Resumable by construction — progress is a cursor per table, so a worker that
 * dies mid-batch loses at most one batch of work and never corrupts a row: each
 * row is read, re-sealed and written inside one transaction.
 */
export async function rotateBatch(
  db: Database, kek: Buffer, tenantId: string, batchSize = 200,
): Promise<RotationProgress[]> {
  const progress: RotationProgress[] = [];

  for (const target of ENCRYPTED_COLUMNS) {
    const done = await withTenant(db, tenantId, async (tx) => {
      const state = await tx.query<{ last_id: string | null; rows_done: string; completed_at: Date | null }>(
        'select last_id, rows_done, completed_at from key_rotations where tenant_id = $1 and table_name = $2',
        [tenantId, target.table],
      );
      if (state[0]?.completed_at) {
        return { table: target.table, rowsDone: Number(state[0].rows_done), completed: true };
      }

      const cursor = state[0]?.last_id ?? null;
      const anyEncrypted = target.columns.map((c) => `${c} is not null`).join(' or ');
      const rows = await tx.query<Record<string, string | null>>(
        `select id, ${target.columns.join(', ')} from ${target.table}
          where tenant_id = $1 and ($2::uuid is null or id > $2) and (${anyEncrypted})
          order by id asc limit $3`,
        [tenantId, cursor, batchSize],
      );

      if (rows.length === 0) {
        await tx.query(
          `insert into key_rotations (tenant_id, table_name, last_id, rows_done, completed_at)
           values ($1,$2,$3,$4, now())
           on conflict (tenant_id, table_name) do update set completed_at = now(), updated_at = now()`,
          [tenantId, target.table, cursor, Number(state[0]?.rows_done ?? 0)],
        );
        return { table: target.table, rowsDone: Number(state[0]?.rows_done ?? 0), completed: true };
      }

      const keys = await tenantKeys(tx, kek, tenantId);
      let lastId = cursor;

      for (const row of rows) {
        const updates: string[] = [];
        const values: unknown[] = [tenantId, row.id as string];

        for (const column of target.columns) {
          const current = row[column];
          if (!current) continue;
          // Read through the fallback, write with the current key.
          const plaintext = openField(keys, tenantId, current as Ciphertext);
          values.push(sealField(keys, tenantId, plaintext));
          updates.push(`${column} = $${values.length}`);
        }
        if (updates.length > 0) {
          await tx.query(
            `update ${target.table} set ${updates.join(', ')} where tenant_id = $1 and id = $2`,
            values,
          );
        }
        lastId = row.id as string;
      }

      const rowsDone = Number(state[0]?.rows_done ?? 0) + rows.length;
      await tx.query(
        `insert into key_rotations (tenant_id, table_name, last_id, rows_done)
         values ($1,$2,$3,$4)
         on conflict (tenant_id, table_name)
         do update set last_id = excluded.last_id, rows_done = excluded.rows_done, updated_at = now()`,
        [tenantId, target.table, lastId, rowsDone],
      );
      return { table: target.table, rowsDone, completed: false };
    });

    progress.push(done);
    // One table at a time keeps each pass short and the cursor easy to reason about.
    if (!done.completed) break;
  }

  return progress;
}

/**
 * Step three: drop the old key.
 *
 * Only once every table reports complete. Until this runs the old key is still
 * reachable, which is what makes the whole thing safe to interrupt.
 */
export async function finishDekRotation(db: Database, tenantId: string): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const states = await tx.query<{ table_name: string; completed_at: Date | null }>(
      'select table_name, completed_at from key_rotations where tenant_id = $1', [tenantId]);

    const completed = new Set(states.filter((s) => s.completed_at).map((s) => s.table_name));
    if (ENCRYPTED_COLUMNS.some((t) => !completed.has(t.table))) return false;

    await tx.query(
      `update tenant_keys
          set previous_wrapped_dek = null, rotation_started_at = null, rotated_at = now()
        where tenant_id = $1`,
      [tenantId],
    );
    await audit(tx, tenantId, {
      actorType: 'system', action: 'keys.rotation_completed', resourceType: 'tenant', resourceId: tenantId,
      meta: { tables: ENCRYPTED_COLUMNS.map((t) => t.table) },
    });
    return true;
  }).finally(() => forgetTenantKeys(tenantId));
}

/** Begin, grind, finish. Safe to call again after an interruption. */
export async function rotateTenantDek(
  db: Database, kek: Buffer, tenantId: string, opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<RotationResult> {
  const started = await beginDekRotation(db, kek, tenantId);
  const maxBatches = opts.maxBatches ?? 1_000;

  let progress: RotationProgress[] = [];
  for (let i = 0; i < maxBatches; i += 1) {
    progress = await rotateBatch(db, kek, tenantId, opts.batchSize);
    if (progress.length === ENCRYPTED_COLUMNS.length && progress.every((p) => p.completed)) break;
  }

  const finished = await finishDekRotation(db, tenantId);
  return { tenantId, started, finished, progress };
}

/**
 * Rotating the key-encrypting key itself.
 *
 * Cheap, because it only re-wraps each tenant's keys — no ciphertext is touched.
 * This is the rotation to run on a schedule; a DEK rotation is for the day you
 * think a data key may have leaked.
 */
export async function rewrapUnderNewKek(
  db: Database, control: Database, oldKekB64: string, newKekB64: string,
): Promise<{ rewrapped: number }> {
  const oldKek = loadKek(oldKekB64);
  const newKek = loadKek(newKekB64);

  const tenants = await allTenants(control, 're-wrapping data keys under a new KEK');

  let rewrapped = 0;
  for (const tenant of tenants) {
    await withTenant(db, tenant.id, async (tx) => {
      const rows = await tx.query<{
        wrapped_dek: string; wrapped_index_key: string; previous_wrapped_dek: string | null;
      }>(
        'select wrapped_dek, wrapped_index_key, previous_wrapped_dek from tenant_keys where tenant_id = $1',
        [tenant.id],
      );
      if (!rows[0]) return;

      const move = (ct: string, aad: string) =>
        encrypt(newKek, decrypt(oldKek, ct, aad), aad);

      await tx.query(
        `update tenant_keys
            set wrapped_dek = $2, wrapped_index_key = $3, previous_wrapped_dek = $4, rotated_at = now()
          where tenant_id = $1`,
        [
          tenant.id,
          move(rows[0].wrapped_dek, `dek:${tenant.id}`),
          move(rows[0].wrapped_index_key, `idx:${tenant.id}`),
          rows[0].previous_wrapped_dek ? move(rows[0].previous_wrapped_dek, `dek:${tenant.id}`) : null,
        ],
      );
      rewrapped += 1;
    });
    forgetTenantKeys(tenant.id);
  }
  return { rewrapped };
}
