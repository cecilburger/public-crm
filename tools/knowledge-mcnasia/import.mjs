// Loads knowledge.json into a Kirana workspace through the public API.
//
//   API_URL=http://localhost:8080 WORKSPACE=... EMAIL=... PASSWORD=... node import.mjs [--dry-run]
//
// Products upsert by SKU on the server. FAQs and policies have no natural key,
// so an entry whose title already exists (active) is skipped rather than
// duplicated — re-running the script is safe. Nothing is deleted or deactivated.
import { readFile } from 'node:fs/promises';

const { API_URL = 'http://localhost:8080', WORKSPACE, EMAIL, PASSWORD } = process.env;
const dryRun = process.argv.includes('--dry-run');
const { items } = JSON.parse(await readFile(new URL('./knowledge.json', import.meta.url), 'utf8'));

if (dryRun) {
  for (const i of items) console.log(`[dry-run] ${i.kind.padEnd(7)} ${i.sku ?? '-'}  ${i.title}`);
  console.log(`${items.length} items`);
  process.exit(0);
}
if (!WORKSPACE || !EMAIL || !PASSWORD) {
  console.error('Set WORKSPACE, EMAIL and PASSWORD (a user with autopilot:manage).');
  process.exit(1);
}

async function call(method, path, token, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const login = await call('POST', '/v1/auth/login', null, { workspace: WORKSPACE, email: EMAIL, password: PASSWORD });
if (login.mfaRequired) {
  console.error('This account has MFA enabled; use an account without MFA or extend this script.');
  process.exit(1);
}
const token = login.accessToken;

const existing = await call('GET', '/v1/knowledge', token);
const rows = Array.isArray(existing) ? existing : (existing.items ?? []);
const liveTitles = new Set(rows.filter((r) => r.active !== false && !r.sku).map((r) => `${r.kind}|${r.title}`));

let created = 0, skipped = 0;
for (const i of items) {
  if (!i.sku && liveTitles.has(`${i.kind}|${i.title}`)) { skipped++; continue; }
  const { kind, title, body, sku, priceIdr, stock, tags } = i;
  await call('POST', '/v1/knowledge', token, { kind, title, body, sku, priceIdr, stock, tags });
  created++;
  console.log(`ok  ${kind.padEnd(7)} ${sku ?? '-'}  ${title}`);
}
console.log(`done: ${created} upserted, ${skipped} skipped (already present)`);
