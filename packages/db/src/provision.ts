import { hashPassword, type Role } from '@kirana/core';
import type { Database } from './sql.ts';
import { withTenant, withoutTenant } from './tenant.ts';
import { provisionTenantKeys } from './keys.ts';
import { audit } from './audit.ts';

export interface ProvisionInput {
  slug: string;
  name: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
  plan?: 'starter' | 'growth' | 'scale' | 'custom';
  interval?: 'monthly' | 'annual';
  retentionDays?: number;
}

/**
 * Creating a tenant is the only two-context operation in the system: the tenant
 * row is written by the control plane, everything else is written from inside
 * the new tenant's own security context — which is also the first proof that
 * the context works.
 */
export async function provisionTenant(db: Database, kek: Buffer, input: ProvisionInput) {
  const created = await withoutTenant(db, 'creating a new tenant row', async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into tenants (slug, name, retention_days) values ($1, $2, $3) returning id`,
      [input.slug, input.name, input.retentionDays ?? 730],
    );
    return rows[0]!;
  });

  await withTenant(db, created.id, async (tx) => {
    await provisionTenantKeys(tx, kek, created.id);

    const owner = await tx.query<{ id: string }>(
      `insert into users (tenant_id, email, name, password_hash, role, status)
       values ($1, $2, $3, $4, 'owner', 'active') returning id`,
      [created.id, input.ownerEmail.toLowerCase(), input.ownerName, hashPassword(input.ownerPassword)],
    );

    await tx.query(
      `insert into subscriptions (tenant_id, plan_code, interval, status)
       values ($1, $2, $3, 'trialing')`,
      [created.id, input.plan ?? 'starter', input.interval ?? 'monthly'],
    );

    const pipeline = await tx.query<{ id: string }>(
      `insert into pipelines (tenant_id, name, is_default) values ($1, 'Penjualan', true) returning id`,
      [created.id],
    );

    // Stages carry the events that advance a deal without anyone dragging a card.
    const stages: [string, number, number, string | null, boolean, boolean][] = [
      ['Baru',      1, 0.10, null,                              false, false],
      ['Berminat',  2, 0.30, '{"event":"quotation.requested"}', false, false],
      ['Penawaran', 3, 0.50, '{"event":"quotation.sent"}',      false, false],
      ['Nego',      4, 0.70, '{"event":"quotation.opened"}',    false, false],
      ['Berhasil',  5, 1.00, '{"event":"payment.succeeded"}',   true,  false],
      ['Batal',     6, 0.00, null,                              false, true],
    ];
    for (const [name, position, probability, auto, isWon, isLost] of stages) {
      await tx.query(
        `insert into pipeline_stages (tenant_id, pipeline_id, name, position, probability, auto_advance_on, is_won, is_lost)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [created.id, pipeline[0]!.id, name, position, probability, auto, isWon, isLost],
      );
    }

    await audit(tx, created.id, {
      actorType: 'system', action: 'tenant.provisioned', resourceType: 'tenant', resourceId: created.id,
      meta: { slug: input.slug, plan: input.plan ?? 'starter' },
    });

    return owner[0]!.id;
  });

  return { tenantId: created.id };
}

export async function addUser(
  db: Database, tenantId: string,
  input: { email: string; name: string; password: string; role: Role },
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into users (tenant_id, email, name, password_hash, role, status)
       values ($1,$2,$3,$4,$5,'active') returning id`,
      [tenantId, input.email.toLowerCase(), input.name, hashPassword(input.password), input.role],
    );
    await audit(tx, tenantId, {
      actorType: 'system', action: 'user.created', resourceType: 'user', resourceId: rows[0]!.id,
      meta: { role: input.role },
    });
    return rows[0]!;
  });
}

export async function addChannel(
  db: Database, tenantId: string,
  input: { kind: string; displayName: string; externalId?: string; phoneE164?: string; wabaId?: string },
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into channels (tenant_id, kind, display_name, external_id, phone_e164, waba_id)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [tenantId, input.kind, input.displayName, input.externalId ?? null,
       input.phoneE164 ?? null, input.wabaId ?? null],
    );
    await audit(tx, tenantId, {
      actorType: 'system', action: 'channel.connected', resourceType: 'channel', resourceId: rows[0]!.id,
      meta: { kind: input.kind },
    });
    return rows[0]!;
  });
}
