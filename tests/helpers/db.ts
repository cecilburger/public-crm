import { randomUUID } from 'node:crypto';
import { connectPglite, connectPostgres, migrate, provisionTenant, addChannel, type Database } from '@kirana/db';
import { loadKek } from '@kirana/core';

export const TEST_KEK = loadKek(Buffer.alloc(32, 3).toString('base64'));

export interface TestTenant {
  tenantId: string;
  channelId: string;
  slug: string;
}

/**
 * A fresh database per call, migrated with the real SQL.
 *
 * Two engines, one suite. By default this is PGlite — Postgres compiled to
 * WASM — so the whole suite runs in-process with no Docker. Set
 * `TEST_DATABASE_URL` and the identical tests run against real Postgres
 * instead, which is what CI does: roles, FORCE row-level security, advisory
 * locks, partial indexes and `ON CONFLICT … WHERE` are supposed to behave the
 * same in both, and the only way to know is to run them in both.
 */
export async function freshDb(): Promise<Database> {
  const adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    const db = await connectPglite();
    await migrate(db);
    return db;
  }

  // Real Postgres: an isolated database per test file, dropped afterwards.
  const name = `kirana_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = await connectPostgres(adminUrl, { max: 1 });
  await admin.exec(`create database ${name}`);
  await admin.close();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  // Connects as the owner, so it must drop into kirana_app itself — exactly as
  // PGlite's bootstrap superuser does.
  const db = await connectPostgres(url.toString(), { max: 4, assumeRole: true });
  await migrate(db);

  const closeConnection = db.close.bind(db);
  return {
    ...db,
    close: async () => {
      await closeConnection();
      const cleanup = await connectPostgres(adminUrl, { max: 1 });
      await cleanup.exec(`drop database if exists ${name} with (force)`);
      await cleanup.close();
    },
  };
}

export async function makeTenant(db: Database, slug: string): Promise<TestTenant> {
  const { tenantId } = await provisionTenant(db, TEST_KEK, {
    slug,
    name: `Tenant ${slug}`,
    ownerEmail: `owner@${slug}.test`,
    ownerName: 'Owner',
    ownerPassword: 'correct horse battery staple',
    plan: 'growth',
  });
  const channel = await addChannel(db, tenantId, {
    kind: 'whatsapp', displayName: `${slug} WA`, externalId: `wa-${slug}`, phoneE164: '+628110000001',
  });
  return { tenantId, channelId: channel.id, slug };
}
