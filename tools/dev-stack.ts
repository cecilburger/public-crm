/**
 * The whole backend in one process, on Postgres, with a seeded workspace that
 * looks like a working day.
 *
 * This is for developing the console and for demos — `make up` is the real
 * stack. It runs the same API code, the same migrations and the same row-level
 * security policies, so anything that works here works there.
 *
 * The data directory persists to disk across restarts (`.dev-stack-data/`,
 * gitignored) rather than living only in memory: this same process is also
 * the one you reconnect real external sessions against (a WhatsApp Web QR
 * pairing, an Instagram Playwright login) that take real, slow, rate-limit-
 * sensitive setup — losing that on every restart made every single edit to
 * this codebase mean redoing that setup by hand. The demo seed below only
 * runs once, the first time there is no 'toko-demo' tenant yet; every
 * restart after that reuses whatever is already there, seed included.
 *
 *   npm run dev:stack     → http://localhost:8080
 */
import path from 'node:path';
import crypto from 'node:crypto';
import {
  connectPglite, migrate, withoutTenant, provisionTenant, addChannel, addUser, withTenant, ingestInboundMessage,
  queueOutboundMessage, createDeal, updateDeal, tenantKeys, openField,
  upsertDraftOrder, setDeliveryDetails, confirmOrder, markOrderPaid, markOrderFulfilled, releaseOrder,
  createTask, setTaskStatus, createBrand, setBrandStatus, createContact, createWaBridgeChannel,
  ensureConversation,
} from '@kirana/db';
import { env, loadKek } from '@kirana/core';
import QRCode from 'qrcode';
import { buildApp, type Dispatch } from '../apps/api/src/app.ts';
import { createRealtimeHub } from '../apps/api/src/realtime.ts';
import { processInboundWebhook } from '../apps/worker/src/processors/inboundNormalise.ts';
import { processAutopilotDraft } from '../apps/worker/src/processors/autopilotDraft.ts';
import { processOutbound } from '../apps/worker/src/processors/outboundSend.ts';
import {
  processCommentPublicReply, processCommentDm, processCommentAutopilot, type CommentActionJob,
} from '../apps/worker/src/processors/facebookComments.ts';
import { closePeriodAndIssueInvoice } from '../apps/worker/src/processors/billingRollup.ts';
import { ClaudeAutopilot, ScriptedAutopilot, type AutopilotModel } from '../apps/worker/src/autopilot/model.ts';
import { GraphMetaClient } from '../apps/worker/src/meta.ts';
import { WaBridgeClient } from '../apps/worker/src/waBridge.ts';
import { IgBridgeClient } from '../apps/worker/src/igBridgeClient.ts';
import { FbBridgeClient } from '../apps/worker/src/fbBridgeClient.ts';

process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'warn';

const e = {
  ...env(),
  // Business data (contacts, deals, the Instagram Bridge connection, …) now
  // persists across restarts in `.dev-stack-data/` — the browser's login
  // session deliberately does not, so a restart still lands back on the sign-
  // in page the way it always used to. A fresh random secret each run makes
  // every token signed by a previous run fail verification immediately,
  // without touching a single row of the data itself.
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
};
const kek = loadKek(e.KIRANA_KEK);

const dataDir = path.join(import.meta.dirname, '..', '.dev-stack-data');
const db = await connectPglite(dataDir);
await migrate(db);

const existingTenant = await withoutTenant(db, 'checking for an existing dev-stack workspace', (tx) =>
  tx.query<{ id: string }>(`select id from tenants where slug = 'toko-demo'`));

let tenantId: string;

// The same choice the worker makes: a real model when a key is configured,
// a deterministic stand-in otherwise, through the identical guardrail path.
// Declared here, ahead of the seed/reuse branch below, so both the demo
// seeding pass (which drafts replies for the conversations it creates) and
// the server's own inbound-message dispatch handler (wired up much further
// down, well after this branch has closed) can reach it — it used to live
// inside the seed branch's own `else` block, which left `runAutopilot`
// genuinely out of scope for every dispatch on a *reused* workspace, since
// that path skips the branch it was declared in entirely.
const autopilot: AutopilotModel = process.env.ANTHROPIC_API_KEY
  ? new ClaudeAutopilot({ model: e.AUTOPILOT_MODEL, effort: e.AUTOPILOT_EFFORT })
  : new ScriptedAutopilot();

const runAutopilot = (payload: unknown) =>
  processAutopilotDraft(
    { db, kek, model: autopilot, dispatch: async () => {}, publicBaseUrl: e.PUBLIC_BASE_URL },
    payload as { tenantId: string; conversationId: string; messageId?: string },
  );

if (existingTenant[0]) {
  tenantId = existingTenant[0].id;
  console.log(`[dev-stack] reusing existing workspace ${tenantId} from ${dataDir} — skipping demo seed`);
} else {

({ tenantId } = await provisionTenant(db, kek, {
  slug: 'toko-demo',
  name: 'Toko Demo Nusantara',
  ownerEmail: 'rani@toko-demo.id',
  ownerName: 'Rani Putri',
  ownerPassword: 'demo-password-1234',
  plan: 'growth',
}));

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

// The wa-bridge numbers behind "Status Nomor" — a spread of session states
// (a couple actually live, one mid-pairing, one that errored out, one that
// dropped) so the monitoring table isn't just a wall of green dots.
//
// The "mid-pairing" one needs a real `qr_data` image, not just the
// `qr_pending` status — the console only shows the "Lihat QR" button when
// both are set (same as a real pending session mid-pairing would have),
// so a QR-less pending row is invisible in the UI, not just unstyled.
const demoQrDataUrl = await QRCode.toDataURL('https://wa.me/qr/demo-pairing-toko-demo');

const waBridgeSpecs: {
  displayName: string; phone?: string; sessionStatus: string; channelStatus: string;
  lastSeenAgo?: number; lastError?: string; maxPerDay: number; qrData?: string;
  chat: { meeting: number; minat: number; balas: number; belum: number; tolak: number; bot: number };
}[] = [
  // Matches the numbers on the settings mockup exactly — the busiest number, live.
  { displayName: 'WA Toko — CS Utama',      phone: '+6281199000001', sessionStatus: 'ready',        channelStatus: 'connected',  lastSeenAgo: 2 * min,  maxPerDay: 150,
    chat: { meeting: 3, minat: 5, balas: 88, belum: 812, tolak: 16, bot: 137 } },
  { displayName: 'WA Toko — Reseller',      phone: '+6281199000002', sessionStatus: 'ready',        channelStatus: 'connected',  lastSeenAgo: 40 * min, maxPerDay: 100,
    chat: { meeting: 1, minat: 8, balas: 42, belum: 210, tolak: 6, bot: 54 } },
  // Never finished pairing — no chats to have a funnel over yet.
  { displayName: 'WA Toko — Nomor Cadangan', sessionStatus: 'qr_pending',   channelStatus: 'connecting', maxPerDay: 50, qrData: demoQrDataUrl,
    chat: { meeting: 0, minat: 0, balas: 0, belum: 0, tolak: 0, bot: 0 } },
  { displayName: 'WA Toko — Admin Lama',    phone: '+6281199000004', sessionStatus: 'error',        channelStatus: 'error',      lastSeenAgo: 3 * 24 * hour, lastError: 'Sesi keluar otomatis — perangkat tertaut dicabut dari HP', maxPerDay: 80,
    chat: { meeting: 0, minat: 2, balas: 10, belum: 305, tolak: 40, bot: 0 } },
  { displayName: 'WA Toko — Gudang',        phone: '+6281199000005', sessionStatus: 'disconnected', channelStatus: 'connecting', lastSeenAgo: 26 * hour, maxPerDay: 60,
    chat: { meeting: 0, minat: 1, balas: 15, belum: 96, tolak: 3, bot: 12 } },
];

const waBridgeChannels = await withTenant(db, tenantId, async (tx) => {
  const ctx = { tx, tenantId, kek };
  const out: { id: string; displayName: string }[] = [];
  for (const spec of waBridgeSpecs) {
    const { channelId } = await createWaBridgeChannel(ctx, { displayName: spec.displayName });
    await tx.query(
      `update wa_bridge_sessions
          set status = $3, last_seen_at = $4, last_error = $5, phone_e164 = $6, updated_at = now(),
              max_per_day = $7, chat_meeting = $8, chat_minat = $9, chat_balas = $10,
              chat_belum = $11, chat_tolak = $12, chat_bot = $13, qr_data = $14
        where tenant_id = $1 and channel_id = $2`,
      [tenantId, channelId, spec.sessionStatus,
       spec.lastSeenAgo !== undefined ? new Date(now - spec.lastSeenAgo) : null,
       spec.lastError ?? null, spec.phone ?? null, spec.maxPerDay,
       spec.chat.meeting, spec.chat.minat, spec.chat.balas, spec.chat.belum, spec.chat.tolak, spec.chat.bot,
       spec.qrData ?? null],
    );
    await tx.query(
      `update channels set status = $3, phone_e164 = $4 where tenant_id = $1 and id = $2`,
      [tenantId, channelId, spec.channelStatus, spec.phone ?? null],
    );
    out.push({ id: channelId, displayName: spec.displayName });
  }
  return out;
});

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

// Chats on the wa-bridge numbers themselves, so "Status Nomor" has real
// totals, an unanswered thread and a queue depth per number — not just a
// row of session dots. The errored and disconnected numbers keep one old,
// never-picked-up thread each, matching a number that went quiet.
const waBridgeInbound: [string, string, string, number, string][] = [
  ['081990000101', 'Citra Dewi', 'Halo kak, ready stock kemeja linen pria warna putih?', 6 * min, waBridgeChannels[0]!.id],
  ['081990000101', 'Citra Dewi', 'Kalau size L ada ga ya kak',                            5 * min, waBridgeChannels[0]!.id],
  ['081990000102', 'Pak Arif',   'Mau tanya ongkir ke Semarang berapa ya kak',            18 * min, waBridgeChannels[0]!.id],
  ['081990000103', 'Mbak Fitri', 'Halo, pesanan kemarin sudah sampai mana ya kak',        45 * min, waBridgeChannels[1]!.id],
  ['081990000104', 'Pak Joko',   'Selamat siang, minta katalog terbaru dong kak',         55 * min, waBridgeChannels[1]!.id],
  ['081990000105', 'Bu Endang',  'Kak ini masih follow up pesanan minggu lalu ya',        3 * 24 * hour, waBridgeChannels[3]!.id],
  ['081990000106', 'Pak Bram',   'Halo min, gudang masih buka ga hari ini',               26 * hour, waBridgeChannels[4]!.id],
];

for (const [phone, name, body, ago, channelId] of waBridgeInbound) {
  const at = new Date(now - ago);
  await withTenant(db, tenantId, (tx) =>
    ingestInboundMessage({ tx, tenantId, kek }, {
      channelId, from: phone, body, displayName: name,
      providerMessageId: `wamid.seed.${phone}.${ago}`, providerTs: at, now: at,
    }));
}

// Two of those threads already got a reply, so "Status Nomor" shows a real
// average reply time instead of "Belum ada balasan" everywhere.
await withTenant(db, tenantId, async (tx) => {
  const convs = await tx.query<{ id: string; display_name: string }>(
    `select c.id, ct.display_name
       from conversations c join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id
      where c.tenant_id = $1 and c.channel_id = any($2::uuid[])`,
    [tenantId, waBridgeChannels.slice(0, 2).map((c) => c.id)]);

  const citra = convs.find((c) => c.display_name === 'Citra Dewi');
  if (citra) {
    await queueOutboundMessage({ tx, tenantId, kek }, {
      conversationId: citra.id, senderType: 'agent', senderId: agents[0].id,
      body: 'Halo Kak Citra, untuk kemeja linen putih size L masih ready ya kak.',
    });
    await tx.query(`update conversations set assignee_id = $2 where tenant_id = $1 and id = $3`,
      [tenantId, agents[0].id, citra.id]);
  }

  const fitri = convs.find((c) => c.display_name === 'Mbak Fitri');
  if (fitri) {
    await queueOutboundMessage({ tx, tenantId, kek }, {
      conversationId: fitri.id, senderType: 'agent', senderId: agents[1].id,
      body: 'Halo Kak Fitri, pesanan sudah masuk resi dan dalam perjalanan ya kak.',
    });
    await tx.query(`update conversations set assignee_id = $2, status = 'resolved' where tenant_id = $1 and id = $3`,
      [tenantId, agents[1].id, fitri.id]);
  }
});

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
});

// A contact only becomes a "Pelanggan" once someone marks them — the five
// seeded contacts above messaged in, but never went through that step, so
// Pelanggan opens empty on a fresh dev-stack. Tag them here, plus two added
// by hand, matching the mix the page's own subtitle promises.
//
// Client page also carries a small set of "toko" fields (nama toko, status
// toko, jadwal meeting, catatan) that have no real source yet — dummy values
// here so the page is not empty columns on a fresh dev-stack, until there is
// somewhere real for these to come from.
function localDT(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

await withTenant(db, tenantId, async (tx) => {
  const ctx = { tx, tenantId, kek };

  const customerTags: [string, string[]][] = [
    ['Bu Sari', ['customer', 'vip']],
    ['Pak Hendra', ['customer', 'korporat']],
    ['Dinda Wardani', ['customer', 'reseller']],
    ['Toko Melati', ['customer', 'grosir']],
    ['Bu Ratna', ['customer', 'baru']],
  ];
  for (const [name, tags] of customerTags) {
    await tx.query(`update contacts set tags = $3 where tenant_id = $1 and display_name = $2`,
      [tenantId, name, tags]);
  }

  const storeDetails: [string, { storeName: string; storeStatus: string; scheduleMeeting: string | null; notes: string }][] = [
    ['Bu Sari', { storeName: 'Toko Sari Batik', storeStatus: 'aktif',
      scheduleMeeting: localDT(new Date(now + 2 * 24 * hour)),
      notes: 'Langganan grosir batik, reorder tiap awal bulan. Minta harga khusus kalau ambil 3+.' }],
    ['Pak Hendra', { storeName: 'PT Hendra Sejahtera', storeStatus: 'aktif', scheduleMeeting: null,
      notes: 'Kontak korporat — pembelian selalu by PO, invoice dikirim ke email.' }],
    ['Dinda Wardani', { storeName: 'Dinda Fashion Reseller', storeStatus: 'prospek',
      scheduleMeeting: localDT(new Date(now + 5 * 24 * hour)),
      notes: 'Reseller baru, masih tanya-tanya warna dan stok sebelum order pertama.' }],
    ['Toko Melati', { storeName: 'Toko Melati Grosir', storeStatus: 'aktif',
      scheduleMeeting: localDT(new Date(now + 3 * 24 * hour)),
      notes: 'Order grosir rutin, biasanya 24 pcs ke atas. Selalu minta penawaran dulu.' }],
    ['Bu Ratna', { storeName: 'Toko Ratna', storeStatus: 'prospek', scheduleMeeting: null,
      notes: 'Komplain pesanan telat 2 hari — perlu ditindaklanjuti sebelum tawarkan order berikutnya.' }],
  ];
  for (const [name, d] of storeDetails) {
    await tx.query(
      `update contacts
          set attributes = attributes || jsonb_build_object(
                'storeName', $3::text, 'storeStatus', $4::text, 'scheduleMeeting', $5::text, 'notes', $6::text)
        where tenant_id = $1 and display_name = $2`,
      [tenantId, name, d.storeName, d.storeStatus, d.scheduleMeeting, d.notes],
    );
  }

  await createContact(ctx, {
    displayName: 'Pak Yusuf Hidayat', phone: '081234511122', email: 'yusuf.hidayat@gmail.com',
    tags: ['customer', 'grosir'], address: 'Jl. Kopo Sayati No. 45, Bandung',
    notes: 'Langganan reseller batik, biasanya order tiap awal bulan.',
    storeName: 'Toko Yusuf Batik', storeStatus: 'aktif', scheduleMeeting: localDT(new Date(now + 1 * 24 * hour)),
  });
  await createContact(ctx, {
    displayName: 'Ibu Wulan Sari', phone: '081234522233', email: null,
    tags: ['customer', 'vip'], address: 'Jl. Kaliurang KM 7, Yogyakarta',
    notes: 'Sering repeat order dress linen, respon cepat kalau dihubungi pagi.',
    storeName: 'Wulan Linen Store', storeStatus: 'aktif', scheduleMeeting: null,
  });
});

// Broadcast needs a contact to both consent to marketing AND already have a
// conversation on the chosen number — most contacts above have neither yet,
// so the feature would look permanently empty without a couple seeded here.
// Bu Sari gets both (shows up "eligible"); Ibu Wulan Sari consents but has no
// thread on either wa-bridge number (shows up skipped "no_conversation"); the
// rest are left alone on purpose (skipped "no_consent") for a realistic mix.
await withTenant(db, tenantId, async (tx) => {
  const ctx = { tx, tenantId, kek };

  await tx.query(
    `update contacts set consent = jsonb_build_object('marketing', true, 'source', 'seed', 'at', now())
      where tenant_id = $1 and display_name in ('Bu Sari', 'Ibu Wulan Sari')`,
    [tenantId],
  );

  const buSari = await tx.query<{ id: string }>(
    `select id from contacts where tenant_id = $1 and display_name = 'Bu Sari'`, [tenantId]);
  if (buSari[0]) {
    await ensureConversation(ctx, { contactId: buSari[0].id, channelId: waBridgeChannels[0]!.id });
  }
});

// A brand outreach list spanning every stage of the funnel and both sources
// — mostly scraped, a couple added by hand — so the Brand page's counters
// and status filters aren't staring at zero.
await withTenant(db, tenantId, async (tx) => {
  const ctx = { tx, tenantId, kek };

  const brands: {
    name: string; picName?: string; phone?: string; email?: string; instagram?: string; website?: string;
    category: string; city: string; source: 'scrape' | 'manual' | 'referral' | 'other';
    status: 'not_contacted' | 'contacted' | 'replied' | 'interested' | 'rejected';
    assignee?: 0 | 1; notes?: string;
  }[] = [
    { name: 'Batik Nusantara Store', picName: 'Ayu Lestari', instagram: '@batiknusantara',
      category: 'Fashion', city: 'Bandung', source: 'scrape', status: 'not_contacted' },
    { name: 'Kopi Kenangan Partner', picName: 'Reza Pratama', phone: '081234500011',
      instagram: '@kopikenanganptr', category: 'F&B', city: 'Jakarta',
      source: 'scrape', status: 'contacted', assignee: 0 },
    { name: 'Skinlogy Beauty', picName: 'Nadia Putri', email: 'nadia@skinlogy.id', instagram: '@skinlogy.id',
      category: 'Skincare', city: 'Surabaya', source: 'manual', status: 'replied', assignee: 1,
      notes: 'Tertarik program reseller, minta katalog harga grosir.' },
    { name: 'Rumah Tenun Ikat', picName: 'Made Wirawan', phone: '081234500022',
      website: 'https://rumahtenunikat.id', category: 'Fashion', city: 'Yogyakarta',
      source: 'referral', status: 'interested', assignee: 0,
      notes: 'Siap kolaborasi, tinggal nego harga dan minimum order.' },
    { name: 'Sepatu Lokal Jaya', picName: 'Fajar Hidayat', instagram: '@sepatulokaljaya',
      category: 'Footwear', city: 'Jakarta', source: 'scrape', status: 'rejected', assignee: 1,
      notes: 'Sudah punya distributor tetap, belum butuh partner baru.' },
    { name: 'Kerajinan Rotan Asri', picName: 'Dewi Anggraini',
      category: 'Kerajinan', city: 'Cirebon', source: 'manual', status: 'not_contacted' },
    { name: 'Teh Herbal Sehat', picName: 'Bagus Setiawan', phone: '081234500033', instagram: '@tehherbalsehat',
      category: 'F&B', city: 'Semarang', source: 'scrape', status: 'contacted', assignee: 0 },
  ];

  for (const b of brands) {
    const created = await createBrand(ctx, {
      name: b.name, picName: b.picName ?? null, phone: b.phone ?? null, email: b.email ?? null,
      instagram: b.instagram ?? null, website: b.website ?? null, category: b.category, city: b.city,
      source: b.source, assigneeId: b.assignee !== undefined ? agents[b.assignee].id : null,
      notes: b.notes ?? null, createdBy: agents[0].id,
    });
    if (b.status !== 'not_contacted') {
      await setBrandStatus(ctx, { brandId: created.id, status: b.status, actorId: agents[0].id });
    }
  }
});

// Deals across the board, brand-first — every one of these is a brand
// opportunity now, not a WA customer's order, so none of them carry a
// Contact. Brands only exist from here on, hence this waits until now.
await withTenant(db, tenantId, async (tx) => {
  const ctx = { tx, tenantId, kek };
  const brandRows = await tx.query<{ id: string; name: string }>(
    `select id, name from brands where tenant_id = $1`, [tenantId]);
  const brandIdByName = (name: string) => brandRows.find((b) => b.name === name)?.id ?? null;
  const stages = await tx.query<{ id: string; name: string }>(
    'select id, name from pipeline_stages where tenant_id = $1 order by position asc', [tenantId]);

  const deals: [string, string, number, string][] = [
    ['Rumah Tenun Ikat', 'Paket reseller starter', 3_150_000, 'Baru'],
    ['Batik Nusantara Store', 'Batik Parang grosir — 3 pcs', 1_440_000, 'Berminat'],
    ['Sepatu Lokal Jaya', 'Restock 24 pcs', 12_400_000, 'Penawaran'],
    ['Kerajinan Rotan Asri', 'PO korporat Q1', 24_900_000, 'Nego'],
    ['Teh Herbal Sehat', 'Pesanan ulang — 6 pcs', 2_880_000, 'Berhasil'],
  ];
  for (const [brandName, title, amount, stageName] of deals) {
    const brandId = brandIdByName(brandName);
    const stage = stages.find((s) => s.name === stageName);
    if (!brandId) continue;
    const deal = await createDeal(ctx, { brandId, title, amountIdr: amount, ownerId: agents[0].id });
    if (stage) {
      await tx.query(
        `update deals set stage_id = $3, status = case when $4 then 'won' else 'open' end where tenant_id = $1 and id = $2`,
        [tenantId, deal.id, stage.id, stageName === 'Berhasil']);
    }
  }
  await tx.query(
    `update deals set rots_at = now() - interval '2 days' where tenant_id = $1 and title like 'Paket reseller%'`,
    [tenantId]);

  // Notes and a target close date on a couple of deals, so Deal Detail opens
  // with real content instead of two empty fields.
  const dealRows = await tx.query<{ id: string; title: string }>(
    `select id, title from deals where tenant_id = $1`, [tenantId]);
  const dealByTitle = (title: string) => dealRows.find((d) => d.title === title)?.id;

  const poKorporat = dealByTitle('PO korporat Q1');
  if (poKorporat) {
    await updateDeal({ tx, tenantId, kek }, {
      dealId: poKorporat,
      notes: 'Sudah kirim katalog dan harga grosir. Menunggu PO resmi dari bagian pembelian.',
      expectedCloseOn: new Date(now + 5 * 24 * hour).toISOString().slice(0, 10),
    });
  }
  const restock = dealByTitle('Restock 24 pcs');
  if (restock) {
    await updateDeal({ tx, tenantId, kek }, {
      dealId: restock,
      notes: 'Nego harga grosir untuk 24 pcs, nunggu konfirmasi ukuran per warna.',
      expectedCloseOn: new Date(now + 2 * 24 * hour).toISOString().slice(0, 10),
    });
  }
});

// A handful of follow-ups spanning overdue, due today and upcoming, so Tugas
// opens with a real spread across its table, kanban and calendar views —
// each one against the same brand its matching deal above is about, no
// Contact involved.
await withTenant(db, tenantId, async (tx) => {
  const ctx = { tx, tenantId, kek };
  const brandRows = await tx.query<{ id: string; name: string }>(
    `select id, name from brands where tenant_id = $1`, [tenantId]);
  const byName = (name: string) => brandRows.find((b) => b.name === name)?.id;

  const tasks: [string, string, number, string, string?, string?, string?][] = [
    ['Batik Nusantara Store', 'Follow-up harga grosir batik parang', -1 * 24 * hour, agents[0].id,
      undefined, undefined, 'high'],
    ['Kerajinan Rotan Asri',  'Kirim invoice PO korporat Q1',          2 * hour,        agents[0].id,
      undefined, undefined, 'urgent'],
    ['Sepatu Lokal Jaya',     'Konfirmasi ukuran per warna restock',   1 * 24 * hour,  agents[1].id,
      undefined, undefined, 'medium'],
    ['Teh Herbal Sehat',      'Cek kepuasan setelah pesanan diterima', 3 * 24 * hour,  agents[0].id,
      undefined, undefined, 'low'],
    ['Sepatu Lokal Jaya',     'Meeting nego harga grosir 24 pcs',      4 * hour,       agents[1].id,
      'meeting', 'https://meet.google.com/toko-demo-nego', 'urgent'],
  ];
  for (const [brandName, title, offset, assigneeId, kind, meetingLink, priority] of tasks) {
    const brandId = byName(brandName);
    if (!brandId) continue;
    await createTask(ctx, {
      brandId, title, dueAt: new Date(now + offset), assigneeId, createdBy: agents[0].id,
      kind, meetingLink, priority,
    });
  }
});

// A closed-out history for two brands, so Tugas doesn't just open on a wall
// of open follow-ups — open ones under Upcoming, done/cancelled ones spread
// across a couple of months, same shape whether the party is a Contact or,
// now, a Brand.
await withTenant(db, tenantId, async (tx) => {
  const ctx = { tx, tenantId, kek };
  const brandRows = await tx.query<{ id: string; name: string }>(
    `select id, name from brands where tenant_id = $1`, [tenantId]);
  const byName = (name: string) => brandRows.find((b) => b.name === name)?.id;
  const day = 24 * hour;

  const upcoming: [string, string, number, string, string][] = [
    ['Skinlogy Beauty',       'Follow-up katalog harga grosir',          -1 * day, agents[0].id, 'high'],
    ['Skinlogy Beauty',       'Konfirmasi jadwal kirim sample produk',    2 * day, agents[1].id, 'low'],
    ['Kopi Kenangan Partner', 'Follow-up progres kerja sama bulan ini',   1 * day, agents[0].id, 'medium'],
  ];
  for (const [brandName, title, offset, assigneeId, priority] of upcoming) {
    const brandId = byName(brandName);
    if (!brandId) continue;
    await createTask(ctx, {
      brandId, title, dueAt: new Date(now + offset), assigneeId, createdBy: agents[0].id, priority,
    });
  }

  const closed: [string, string, number, 'done' | 'cancelled', number, string][] = [
    ['Skinlogy Beauty',       'Follow-up minat program reseller', -5 * day,  'done',      -5 * day,  agents[0].id],
    ['Skinlogy Beauty',       'Kirim katalog produk terbaru',      -40 * day, 'done',      -40 * day, agents[1].id],
    ['Skinlogy Beauty',       'Cek ongkir pengiriman sample',      -18 * day, 'cancelled', 0,         agents[0].id],
    ['Kopi Kenangan Partner', 'Follow-up restock kemasan',         -70 * day, 'done',      -70 * day, agents[0].id],
  ];
  for (const [brandName, title, dueOffset, status, completedOffset, assigneeId] of closed) {
    const brandId = byName(brandName);
    if (!brandId) continue;
    const { id } = await createTask(ctx, {
      brandId, title, dueAt: new Date(now + dueOffset), assigneeId, createdBy: agents[0].id,
    });
    await setTaskStatus(ctx, { taskId: id, status, actorId: assigneeId });
    if (status === 'done') {
      await tx.query(`update tasks set completed_at = $2 where id = $1`, [id, new Date(now + completedOffset)]);
    }
  }
});

// A few more Tugas entries the way the app itself creates them: from a
// Brand's own Meeting/Call/Online Meet row, pointing straight at the brand —
// no Contact gets manufactured for it, the brand's own number is what a task
// like this uses. The standalone Tugas Baru form no longer offers a bare
// Pelanggan picker either, so this is the only path a brand prospect's
// follow-up takes today.
await withTenant(db, tenantId, async (tx) => {
  const ctx = { tx, tenantId, kek };
  const brandRows = await tx.query<{ id: string; name: string }>(
    `select id, name from brands where tenant_id = $1`, [tenantId]);
  const brandIdByName = (name: string) => brandRows.find((b) => b.name === name)?.id ?? null;

  const brandTasks: [string, string, number, string, 'meeting' | 'call' | 'online_meet', string?, string?][] = [
    ['Rumah Tenun Ikat', 'Meeting nego harga & minimum order', 5 * hour, agents[0].id,
      'meeting', 'https://meet.google.com/rumah-tenun-nego', 'urgent'],
    ['Kopi Kenangan Partner', 'Follow-up telepon progres kerja sama', 1 * 24 * hour, agents[0].id,
      'call', undefined, 'medium'],
    ['Teh Herbal Sehat', 'Online meet perkenalan program afiliasi', 2 * 24 * hour, agents[1].id,
      'online_meet', 'https://meet.google.com/teh-herbal-intro', 'medium'],
  ];
  for (const [brandName, title, offset, assigneeId, kind, meetingLink, priority] of brandTasks) {
    const brandId = brandIdByName(brandName);
    if (!brandId) continue;
    await createTask(ctx, {
      brandId, title, dueAt: new Date(now + offset), assigneeId, createdBy: agents[0].id,
      kind, meetingLink, priority,
    });
  }
});

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

// Orders across the funnel — one still being built, one waiting on payment,
// one paid, one shipped, one that fell through — so Pesanan is not empty.
//
// Deliberately seeded after the Autopilot draft pass above: Autopilot's own
// `susun_pesanan` tool also calls `upsertDraftOrder` against a conversation's
// draft basket, and Bu Sari's inbound message reads like an order request —
// running this block first meant her seeded draft got silently overwritten
// by whatever Autopilot parsed out of that message.
await withTenant(db, tenantId, async (tx) => {
  const ctx = { tx, tenantId, kek };
  const contactConvs = await tx.query<{ contact_id: string; conversation_id: string; display_name: string }>(
    `select c.contact_id, c.id as conversation_id, ct.display_name
       from conversations c join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id
      where c.tenant_id = $1`, [tenantId]);
  const byName = (name: string) => contactConvs.find((c) => c.display_name === name);

  const seeds: {
    contact: string; sku: string; qty: number; area: string;
    outcome: 'draft' | 'awaiting_payment' | 'paid' | 'fulfilled' | 'cancelled';
  }[] = [
    { contact: 'Bu Sari',        sku: 'BTK-PRG-M', qty: 3,  area: 'Jakarta', outcome: 'draft' },
    { contact: 'Toko Melati',    sku: 'BTK-PRG-M', qty: 5,  area: 'Bekasi',  outcome: 'awaiting_payment' },
    { contact: 'Pak Hendra',     sku: 'KML-01',     qty: 10, area: 'Jakarta', outcome: 'paid' },
    { contact: 'Bu Ratna',       sku: 'DRS-RBY',    qty: 6,  area: 'Bandung', outcome: 'fulfilled' },
    { contact: 'Dinda Wardani',  sku: 'DRS-RBY',    qty: 1,  area: 'Jakarta', outcome: 'cancelled' },
  ];

  // Confirming an order opens its own deal (see `confirmOrder`), titled after
  // the order code rather than a product — same brand-blank problem the named
  // deals above had, so it's linked back to Brand Tracker here too, by which
  // brand actually sells the SKU on the order.
  const skuBrand: Record<string, string> = {
    'BTK-PRG-M': 'Batik Nusantara Store', 'KML-01': 'Rumah Tenun Ikat', 'DRS-RBY': 'Rumah Tenun Ikat',
  };
  const brandRows = await tx.query<{ id: string; name: string }>(
    `select id, name from brands where tenant_id = $1`, [tenantId]);
  const brandIdByName = (name: string) => brandRows.find((b) => b.name === name)?.id ?? null;

  for (const seed of seeds) {
    const contact = byName(seed.contact);
    if (!contact) continue;

    const draft = await upsertDraftOrder(ctx, {
      conversationId: contact.conversation_id, contactId: contact.contact_id,
      lines: [{ sku: seed.sku, qty: seed.qty }],
    });
    if (seed.outcome === 'draft') continue;

    await setDeliveryDetails(ctx, {
      orderId: draft.id, recipient: contact.display_name,
      address: 'Jl. Contoh Raya No. 1', area: seed.area,
    });
    const confirmed = await confirmOrder(ctx, { orderId: draft.id, publicBaseUrl: e.PUBLIC_BASE_URL });
    if (!confirmed.ok) continue;

    const brandId = brandIdByName(skuBrand[seed.sku] ?? '');
    if (brandId && confirmed.order.dealId) {
      await tx.query(`update deals set brand_id = $3 where tenant_id = $1 and id = $2`,
        [tenantId, confirmed.order.dealId, brandId]);
    }

    if (seed.outcome === 'cancelled') {
      await releaseOrder(ctx, { orderId: confirmed.order.id, reason: 'Pelanggan membatalkan pesanan' });
      continue;
    }
    if (seed.outcome === 'paid' || seed.outcome === 'fulfilled') {
      await markOrderPaid(ctx, { orderId: confirmed.order.id, actorId: agents[0].id });
    }
    if (seed.outcome === 'fulfilled') {
      await markOrderFulfilled(ctx, { orderId: confirmed.order.id, actorId: agents[0].id });
    }
  }
});

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

} // end of the first-run-only demo seed

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
const igBridge = new IgBridgeClient(e.IG_BRIDGE_URL, e.IG_BRIDGE_SECRET);
const fbBridge = new FbBridgeClient(e.FB_BRIDGE_URL, e.FB_BRIDGE_SECRET);

const realtime = createRealtimeHub();

// Named rather than written inline into `buildApp` so the comment processors
// can dispatch back into it: a sweep queues reply and DM jobs exactly as the
// real worker does, and here they run straight away, in order.
const dispatch: Dispatch = async ({ queue, payload, delayMs }) => {
  // No real queue here to schedule a delayed job on — a plain wait keeps a
  // broadcast's pacing (`sendRatePerSecond`) actually observable locally
  // instead of silently collapsing to "everything at once".
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (queue === 'inbound.normalise') {
    await processInboundWebhook(
      {
        db, control: db, kek,
        dispatch: async (job) => { if (job.queue === 'autopilot.draft') await runAutopilot(job.payload); },
        publish: (tenantId, event) => realtime.publish(tenantId, event),
      },
      (payload as { webhookEventId: string }).webhookEventId);
  }
  if (queue === 'autopilot.draft') await runAutopilot(payload);
  if (queue === 'outbound.send') {
    const job = payload as { tenantId: string; messageId: string };
    // The seeded demo channels (Obrolan's WhatsApp/Instagram) carry no real
    // Meta credentials — there is nowhere for `processOutbound` to actually
    // send those, only a guaranteed failure. A real, live-session-backed
    // channel (WhatsApp Web, or Instagram through the Playwright bridge)
    // is worth routing through the real send path here; everything else
    // stays the no-op it always was in this demo stack.
    const channelKind = await withTenant(db, job.tenantId, async (tx) => {
      const rows = await tx.query<{ kind: string }>(
        `select ch.kind from messages m
           join channels ch on ch.id = m.channel_id and ch.tenant_id = m.tenant_id
          where m.tenant_id = $1 and m.id = $2`,
        [job.tenantId, job.messageId],
      );
      return rows[0]?.kind ?? null;
    }).catch(() => null);

    // messenger_bridge joined the list once the Facebook sender was real:

    // without it a reply typed in the console sat in the outbox as a no-op

    // locally, which made a working send path look broken.

    if (channelKind === 'whatsapp_web' || channelKind === 'instagram_bridge' || channelKind === 'messenger_bridge') {
      await processOutbound({ db, kek, meta, waBridge, igBridge, fbBridge, accessTokenFor }, job)
        .catch((err) => console.error('[dev-stack] outbound send failed:', (err as Error).message));
    }
  }
  if (queue === 'facebook.comment.reply' || queue === 'facebook.comment.dm' || queue === 'facebook.comment.sweep') {
    // The real bridge client, same as outbound.send above: a live Page session
    // is the only thing worth routing these to, and without one the bridge
    // answers 404 and the comment records that in words an agent can read.
    const commentDeps = { db, kek, fbBridge, dispatch, env: e };
    const run = queue === 'facebook.comment.reply'
      ? processCommentPublicReply(commentDeps, payload as CommentActionJob)
      : queue === 'facebook.comment.dm'
        ? processCommentDm(commentDeps, payload as CommentActionJob)
        : processCommentAutopilot(commentDeps, payload as { tenantId: string });
    await run.catch((err) => console.error(`[dev-stack] ${queue} failed:`, (err as Error).message));
  }
};

const app = buildApp({ db, control: db, kek, env: e, realtime, dispatch });

await app.listen({ port: e.PORT, host: '127.0.0.1' });

console.log(`
  MCNASIA dev stack (persistent Postgres in .dev-stack-data/, real API)

  API        http://localhost:${e.PORT}
  workspace  toko-demo
  autopilot  ${process.env.ANTHROPIC_API_KEY ? 'claude (' + e.AUTOPILOT_MODEL + ')' : 'offline stand-in — set ANTHROPIC_API_KEY for the real model'}

  sign in    rani@toko-demo.id      / demo-password-1234   (owner)
             sinta@toko-demo.id     / demo-password-1234   (supervisor)
             dimas@toko-demo.id     / demo-password-1234   (agent)
`);
