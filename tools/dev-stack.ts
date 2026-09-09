/**
 * The whole backend in one process, on an in-memory Postgres, with a seeded
 * workspace that looks like a working day.
 *
 * This is for developing the console and for demos — `make up` is the real
 * stack. It runs the same API code, the same migrations and the same row-level
 * security policies, so anything that works here works there.
 *
 *   npm run dev:stack     → http://localhost:8080
 */
import {
  connectPglite, migrate, provisionTenant, addChannel, addUser, withTenant, ingestInboundMessage,
  queueOutboundMessage, createDeal, tenantKeys, openField,
} from '@kirana/db';
import { env, loadKek } from '@kirana/core';
import { buildApp } from '../apps/api/src/app.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { processAutopilotDraft } from '../apps/worker/src/processors/autopilotDraft.ts';
import { processOutbound } from '../apps/worker/src/processors/outboundSend.ts';
import { closePeriodAndIssueInvoice } from '../apps/worker/src/processors/billingRollup.ts';
import { ClaudeAutopilot, ScriptedAutopilot, type AutopilotModel } from '../apps/worker/src/autopilot/model.ts';
import { GraphMetaClient } from '../apps/worker/src/meta.ts';
import { WaBridgeClient } from '../apps/worker/src/waBridge.ts';

process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'warn';

const e = env();
const kek = loadKek(e.KIRANA_KEK);

const db = await connectPglite();
await migrate(db);

const { tenantId } = await provisionTenant(db, kek, {
  slug: 'toko-demo',
  name: 'Toko Demo Nusantara',
  ownerEmail: 'rani@toko-demo.id',
  ownerName: 'Rani Putri',
  ownerPassword: 'demo-password-1234',
  plan: 'growth',
});

const agents = await Promise.all([
  addUser(db, tenantId, { email: 'dimas@toko-demo.id', name: 'Dimas Arya', password: 'demo-password-1234', role: 'agent' }),
  addUser(db, tenantId, { email: 'sinta@toko-demo.id', name: 'Sinta Larasati', password: 'demo-password-1234', role: 'supervisor' }),
]);

const wa = await addChannel(db, tenantId, {
  kind: 'whatsapp', displayName: 'Toko Demo — Sales', externalId: 'wa-demo-1', phoneE164: '+628110000001',
});
const ig = await addChannel(db, tenantId, {
  kind: 'instagram', displayName: '@tokodemo', externalId: 'ig-demo-1',
});

// What Autopilot is allowed to know. Without this it correctly refuses to
// answer anything, which is the right behaviour but a dull demo.
await withTenant(db, tenantId, async (tx) => {
  const items: [string, string, string, string | null, number | null, number | null, string][] = [
    ['product', 'Batik Parang size M', 'Katun primis halus, warna navy dan coklat', 'BTK-PRG-M', 480_000, 7, '{batik,parang,navy}'],
    ['product', 'Batik Parang size L', 'Katun primis halus, warna navy', 'BTK-PRG-L', 495_000, 0, '{batik,parang}'],
    ['product', 'Dress Linen Ruby', 'Tersedia navy, maroon, sage, cream. XL habis.', 'DRS-RBY', 385_000, 14, '{dress,linen,navy,maroon,sage,cream}'],
    ['product', 'Kemeja Linen Pria', 'Lengan panjang, empat warna', 'KML-01', 320_000, 12, '{kemeja,linen,pria}'],
    ['policy', 'Ongkir dan COD', 'Ongkir Jabodetabek Rp 12.000, luar Jawa mulai Rp 25.000. COD minimal Rp 100.000.', null, null, null, '{}'],
    ['policy', 'Harga grosir', 'Pembelian 3 pcs atau lebih dapat harga grosir, yaitu harga satuan dikali jumlah tanpa tambahan.', null, null, null, '{}'],
    ['faq', 'Retur', 'Retur maksimal 3 hari setelah barang diterima, barang belum dipakai dan label masih utuh.', null, null, null, '{retur}'],
    ['policy', 'Pembayaran', 'Transfer ke BCA 1234567890 a.n. Toko Demo Nusantara.\nSetelah transfer, kirim bukti ke WhatsApp ini.', null, null, null, '{bayar}'],
  ];
  for (const [kind, title, body, sku, price, stock, tags] of items) {
    await tx.query(
      `insert into knowledge_items (tenant_id, kind, title, body, sku, price_idr, stock, tags)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, kind, title, body, sku, price, stock, tags],
    );
  }
  // Where the shop delivers, and for how much.
  for (const [area, cost, eta] of [['Jakarta', 12_000, 1], ['Bekasi', 12_000, 2],
                                   ['Bandung', 18_000, 3], ['default', 25_000, 4]] as const) {
    await tx.query(
      `insert into shipping_rates (tenant_id, area, cost_idr, eta_days) values ($1,$2,$3,$4)`,
      [tenantId, area, cost, eta],
    );
  }

  // Starts in the cautious mode, the way a real shop should.
  await tx.query(
    `insert into autopilot_settings (tenant_id, mode) values ($1, 'suggest')
     on conflict (tenant_id) do update set mode = excluded.mode`,
    [tenantId],
  );
});

const now = Date.now();
const min = 60_000;
const hour = 60 * min;

// A day's worth of inbox: some fresh, some ageing, some past the reply window.
const inbound: [string, string, string, number, string][] = [
  ['08123456789', 'Bu Sari',        'Sis, batik parang size M masih ada? Kalau ambil 3 dapat harga grosir ga?', 4 * min,  wa.id],
  ['08123456789', 'Bu Sari',        'Butuh hari Jumat soalnya buat kondangan',                                  3 * min,  wa.id],
  ['081298765432', 'Pak Hendra',    'Invoice untuk PO kemarin sudah bisa dikirim ke email saya?',               22 * min, wa.id],
  ['085712345678', 'Dinda Wardani', 'halo kak, yang di reel kemarin itu warna apa aja ya? ada navy ga',          2 * hour, ig.id],
  ['081377788899', 'Toko Melati',   'Mau restock 24 pcs, minta penawaran ya',                                    5 * hour, wa.id],
  ['087811223344', 'Bu Ratna',      'Pesanan saya kok belum dikirim ya sudah 2 hari',                           26 * hour, wa.id],
];

for (const [phone, name, body, ago, channelId] of inbound) {
  const at = new Date(now - ago);
  await withTenant(db, tenantId, (tx) =>
    ingestInboundMessage({ tx, tenantId, kek }, {
      channelId, from: phone, body, displayName: name,
      providerMessageId: `wamid.seed.${phone}.${ago}`, providerTs: at, now: at,
    }));
}

// A couple of threads already worked, so the console is not all unanswered.
await withTenant(db, tenantId, async (tx) => {
  const convs = await tx.query<{ id: string; contact_id: string; display_name: string }>(
    `select c.id, c.contact_id, ct.display_name
       from conversations c join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id
      where c.tenant_id = $1 order by c.last_message_at desc`, [tenantId]);

  const hendra = convs.find((c) => c.display_name === 'Pak Hendra');
  if (hendra) {
    await queueOutboundMessage({ tx, tenantId, kek }, {
      conversationId: hendra.id, senderType: 'autopilot',
      body: 'Baik Pak Hendra, invoice #INV-88214 saya kirimkan ke email Bapak sekarang. Mohon dicek dalam 5 menit ya.',
    });
    await tx.query(`update conversations set assignee_id = $2, status = 'pending' where tenant_id = $1 and id = $3`,
      [tenantId, agents[0].id, hendra.id]);
  }

  const melati = convs.find((c) => c.display_name === 'Toko Melati');
  if (melati) {
    await tx.query('update conversations set assignee_id = $2 where tenant_id = $1 and id = $3',
      [tenantId, agents[1].id, melati.id]);
  }

  // Deals across the board, including one that has gone quiet.
  const deals: [string, string, number, string][] = [
    ['Dinda Wardani',  'Paket reseller starter',        3_150_000, 'Baru'],
    ['Bu Sari',        'Batik Parang grosir — 3 pcs',   1_440_000, 'Berminat'],
    ['Toko Melati',    'Restock 24 pcs',               12_400_000, 'Penawaran'],
    ['Pak Hendra',     'PO korporat Q1',               24_900_000, 'Nego'],
    ['Bu Ratna',       'Pesanan ulang — 6 pcs',         2_880_000, 'Berhasil'],
  ];
  const stages = await tx.query<{ id: string; name: string }>(
    'select id, name from pipeline_stages where tenant_id = $1 order by position asc', [tenantId]);

  for (const [contactName, title, amount, stageName] of deals) {
    const contact = convs.find((c) => c.display_name === contactName);
    const stage = stages.find((s) => s.name === stageName);
    if (!contact) continue;
    const deal = await createDeal({ tx, tenantId, kek }, {
      contactId: contact.contact_id, title, amountIdr: amount,
      ownerId: agents[0].id, sourceConversationId: contact.id,
    });
    if (stage) {
      await tx.query(
        `update deals set stage_id = $3, status = case when $4 then 'won' else 'open' end where tenant_id = $1 and id = $2`,
        [tenantId, deal.id, stage.id, stageName === 'Berhasil']);
    }
  }
  await tx.query(
    `update deals set rots_at = now() - interval '2 days' where tenant_id = $1 and title like 'Paket reseller%'`,
    [tenantId]);
});

// The same choice the worker makes: a real model when a key is configured,
// a deterministic stand-in otherwise, through the identical guardrail path.
const autopilot: AutopilotModel = process.env.ANTHROPIC_API_KEY
  ? new ClaudeAutopilot({ model: e.AUTOPILOT_MODEL, effort: e.AUTOPILOT_EFFORT })
  : new ScriptedAutopilot();

const runAutopilot = (payload: unknown) =>
  processAutopilotDraft(
    { db, kek, model: autopilot, dispatch: async () => {}, publicBaseUrl: e.PUBLIC_BASE_URL },
    payload as { tenantId: string; conversationId: string; messageId?: string },
  );

// Draft replies for the seeded conversations, so the inbox opens with real
// suggestions waiting rather than an empty demo.
// Read the list first, then draft outside the transaction: processAutopilotDraft
// opens its own, and nesting one inside another deadlocks a single-connection
// database (and holds a pooled connection across a model call on a real one).
const unclaimed = await withTenant(db, tenantId, (tx) =>
  tx.query<{ id: string }>(`select id from conversations where tenant_id = $1 and assignee_id is null`, [tenantId]));

for (const conversation of unclaimed) {
  await runAutopilot({ tenantId, conversationId: conversation.id }).catch(() => undefined);
}

// A closed period with an invoice already issued, so the billing page shows the
// real thing rather than an empty table.
await withTenant(db, tenantId, async (tx) => {
  await tx.query(
    `insert into billing_profiles (tenant_id, legal_name, npwp, address, bank_details)
     values ($1, 'PT Toko Demo Nusantara', '01.234.567.8-901.000', 'Jl. Melati 12, Jakarta Selatan',
             'BCA 1234567890 a.n. PT Toko Demo Nusantara')`,
    [tenantId]);
  await tx.query(
    `insert into billing_periods (tenant_id, starts_at, ends_at, plan_code)
     values ($1, now() - interval '31 days', now() - interval '1 day', 'growth')`,
    [tenantId]);
});
await closePeriodAndIssueInvoice(db, tenantId);

// Channel credentials are stored encrypted per tenant; unwrapped only in
// memory, only for the send being performed — same as the real worker.
const accessTokenFor = async (tid: string, channelId: string): Promise<string> => {
  return withTenant(db, tid, async (tx) => {
    const rows = await tx.query<{ credentials_enc: string | null }>(
      'select credentials_enc from channels where tenant_id = $1 and id = $2', [tid, channelId]);
    if (!rows[0]?.credentials_enc) throw new Error('Channel has no stored credentials');
    const keys = await tenantKeys(tx, kek, tid);
    return (JSON.parse(openField(keys, tid, rows[0].credentials_enc)) as { accessToken: string }).accessToken;
  });
};
// The seeded demo channels have no real Meta credentials to send with — a
// real WhatsApp Web number connected through `apps/wa-bridge` does have
// somewhere real to go, so that half of `processOutbound` is worth wiring in.
const meta = new GraphMetaClient(e.META_GRAPH_URL);
const waBridge = new WaBridgeClient(e.WA_BRIDGE_URL, e.WA_BRIDGE_SECRET);

const app = buildApp({
  db, control: db, kek, env: e,
  dispatch: async ({ queue, payload }) => {
    if (queue === 'inbound.normalise') {
      await processInboundWebhook(
        { db, control: db, kek, dispatch: async (job) => { if (job.queue === 'autopilot.draft') await runAutopilot(job.payload); } },
        (payload as { webhookEventId: string }).webhookEventId);
    }
    if (queue === 'autopilot.draft') await runAutopilot(payload);
    if (queue === 'outbound.send') {
      const job = payload as { tenantId: string; messageId: string };
      // The seeded demo channels (Obrolan's WhatsApp/Instagram) carry no real
      // Meta credentials — there is nowhere for `processOutbound` to actually
      // send those, only a guaranteed failure. A WhatsApp Web number has a
      // real `apps/wa-bridge` session behind it, so only that kind is worth
      // routing through the real send path here; everything else stays the
      // no-op it always was in this demo stack.
      const isWaBridge = await withTenant(db, job.tenantId, async (tx) => {
        const rows = await tx.query<{ kind: string }>(
          `select ch.kind from messages m
             join channels ch on ch.id = m.channel_id and ch.tenant_id = m.tenant_id
            where m.tenant_id = $1 and m.id = $2`,
          [job.tenantId, job.messageId],
        );
        return rows[0]?.kind === 'whatsapp_web';
      }).catch(() => false);

      if (isWaBridge) {
        await processOutbound({ db, kek, meta, waBridge, accessTokenFor }, job)
          .catch((err) => console.error('[dev-stack] outbound send failed:', (err as Error).message));
      }
    }
  },
});

await app.listen({ port: e.PORT, host: '127.0.0.1' });

console.log(`
  Kirana dev stack (in-memory Postgres, real API)

  API        http://localhost:${e.PORT}
  workspace  toko-demo
  autopilot  ${process.env.ANTHROPIC_API_KEY ? 'claude (' + e.AUTOPILOT_MODEL + ')' : 'offline stand-in — set ANTHROPIC_API_KEY for the real model'}

  sign in    rani@toko-demo.id      / demo-password-1234   (owner)
             sinta@toko-demo.id     / demo-password-1234   (supervisor)
             dimas@toko-demo.id     / demo-password-1234   (agent)
`);
