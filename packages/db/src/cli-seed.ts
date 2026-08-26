import { connectPostgres } from './sql.ts';
import { migrate } from './migrate.ts';
import { provisionTenant, addChannel } from './provision.ts';
import { withTenant } from './tenant.ts';
import { ingestInboundMessage } from './repo.ts';
import { env, loadKek } from '@kirana/core';

const e = env();
const kek = loadKek(e.KIRANA_KEK);
const db = await connectPostgres(e.DATABASE_URL, { max: 4 });

try {
  await migrate(db);
  const { tenantId } = await provisionTenant(db, kek, {
    slug: 'toko-demo', name: 'Toko Demo Nusantara',
    ownerEmail: 'owner@toko-demo.id', ownerName: 'Rani Putri',
    ownerPassword: 'demo-password-change-me', plan: 'growth',
  });
  const channel = await addChannel(db, tenantId, {
    kind: 'whatsapp', displayName: 'Toko Demo — Sales',
    externalId: 'wa-demo-1', phoneE164: '+628110000001',
  });

  await withTenant(db, tenantId, async (tx) => {
    await ingestInboundMessage({ tx, tenantId, kek }, {
      channelId: channel.id, from: '08123456789',
      body: 'Sis, batik parang size M masih ada?',
      providerMessageId: 'wamid.demo.1', displayName: 'Bu Sari',
    });
  });

  console.log(`seeded tenant ${tenantId} (owner@toko-demo.id / demo-password-change-me)`);
} finally {
  await db.close();
}
