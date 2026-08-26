# Kirana

A multi-tenant conversational CRM for Indonesian teams. WhatsApp, Instagram,
TikTok, Tokopedia and Shopee chats land in one inbox; deals are derived from the
conversation; billing is metered per 24-hour conversation window.

CRM is the first module of a wider suite — the marketing site in
`apps/marketing/` is the public face of it.

## Quick start

```bash
npm install
npm test          # 306 tests, no Docker required — Postgres runs in-process
npm run typecheck

# see the console, no Docker needed: two terminals
npm run dev:stack     # API + seeded workspace on an in-memory Postgres
npm run dev:console   # console → http://localhost:3000

# the real stack
cp .env.example .env
make up           # postgres + redis + api + worker + console
make seed
```

Sign in at http://localhost:3000 with workspace `toko-demo`,
`rani@toko-demo.id` / `demo-password-1234`.

The console is in Bahasa Indonesia — it is used by shop staff, not by engineers.
The marketing site stays in English, since it sells to a different audience.

Sign in to the seeded workspace:

```bash
curl -s localhost:8080/v1/auth/login -H 'content-type: application/json' \
  -d '{"workspace":"toko-demo","email":"owner@toko-demo.id","password":"demo-password-change-me"}'
```

The public price calculator needs no authentication and returns the same numbers
the website shows:

```bash
curl -s 'localhost:8080/v1/billing/estimate?plan=growth&extraNumbers=2&extraSeats=3'
```

## Layout

```
apps/
  api/         Fastify: auth, reads, command intake, webhook ingress
  worker/      BullMQ: normalise inbound, send outbound, billing, retention
  console/     Next.js 15 agent console, in Bahasa Indonesia
  marketing/   the public site + pricing configurator
packages/
  core/        domain rules, no I/O — pricing, permissions, metering, crypto, WhatsApp policy
  db/          SQL migrations, row-level security, tenant context, repositories
docs/          architecture, security, threat model, operations, compliance, ADRs
tests/         isolation, metering, pricing, crypto, permissions, end-to-end API
```

## The four decisions worth knowing

1. **Tenant isolation is enforced by Postgres**, not by remembering a `WHERE`
   clause. Row-level security on every tenant table, `FORCE`d, with the app
   connecting as an unprivileged role. An unset context returns zero rows —
   isolation fails closed. ([ADR 0001](docs/adr/0001-row-level-security-for-tenancy.md))

2. **Billing is one conversation per contact per rolling 24 hours**, regardless
   of message count, agent count or channel. Meta's own fee is metered separately
   and passed through at cost on its own invoice line.
   ([ADR 0003](docs/adr/0003-conversation-window-billing.md))

3. **Outbound messages go through a transactional outbox**, never a provider call
   inside a request. No state where a reply is saved but unsendable, or sent but
   unsaved. ([ADR 0004](docs/adr/0004-transactional-outbox.md))

4. **Personal data is encrypted with per-tenant keys** wrapped by a KEK held
   outside the database, with HMAC blind indexes for lookup. A stolen dump is
   ciphertext, and erasure is crypto-shredding.
   ([ADR 0005](docs/adr/0005-application-level-field-encryption.md))

## Tests

The suite runs real Postgres semantics in-process via PGlite — roles, RLS
policies, advisory locks and partial indexes included — so the isolation and
metering guarantees are executed, not asserted in prose.

```
tests/rls.test.ts             tenant isolation, audit immutability, spool access
tests/metering.test.ts        billing windows, dedupe, concurrent bursts
tests/pricing.test.ts         the published price list, pinned
tests/crypto.test.ts          envelope encryption, blind indexes, signatures, passwords
tests/permissions.test.ts     the role matrix and its subset property
tests/whatsapp-rules.test.ts  Meta's 24-hour window, quality pacing, phone normalisation
tests/api.test.ts             login → signed webhook → reply → usage → erasure
tests/console.test.ts         inbox queue rule, session expiry, IDR formatting
tests/autopilot.test.ts       guardrails: invented prices, discounts, stock, injection
tests/autopilot-flow.test.ts  the whole loop, incl. taking an order over 3 turns
tests/orders.test.ts          order arithmetic: stock, merging, bad quantities
tests/ratelimit.test.ts       windows, key strategy, failing open when Redis is down
tests/totp.test.ts            RFC 6238 vectors, drift, replay, backup codes
tests/mfa.test.ts             enrolment, two-step sign-in, recovery, lockout
tests/security-events.test.ts detection, the 3×24h clock, alert delivery
tests/netmask.test.ts         webhook IP allow-listing
tests/rotation.test.ts        key rotation: resumable, readable throughout
tests/invoicing.test.ts       invoice arithmetic, numbering, dunning, payment
tests/email.test.ts           billing templates, idempotent delivery, retries
tests/health.test.ts          operational thresholds, metrics cardinality
tests/architecture.test.ts    layering rules, the cross-tenant allowlist, RLS coverage
tests/sql-drift.test.ts       row types checked against the SQL that fills them
tests/pooling.test.ts         tenant context cannot outlive its transaction
```

CI runs the whole suite twice: once in-process, and once against a real
Postgres 16 service container — the same tests, both engines, because the
guarantees are supposed to hold in both.

These have found real bugs while being written: a check-then-insert race in
contact resolution; the reply window measured on our clock instead of Meta's; a
rupiah parser that read "Rp 1,5jt" as 15 million, which would have let a wrong
price look grounded; and a conversation-level Autopilot default that made
workspace-level `auto` unreachable. All fixed and covered.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, request paths, the two meters, failure behaviour
- [Security](docs/SECURITY.md) — controls, what verifies each one, and the known gaps
- [Threat model](docs/THREAT-MODEL.md) — STRIDE, attack scenarios, accepted risks
- [Operations](docs/OPERATIONS.md) — SLOs, runbooks, capacity, cost model
- [UU PDP compliance](docs/COMPLIANCE-UU-PDP.md) — obligations mapped to code
- [Decisions](docs/adr/) — five ADRs

## Autopilot — the chatbot that finishes the sale

It does not just answer; it takes the order. A real conversation from the demo
stack, start to finish, with nobody at the shop involved:

```
Pelanggan │ malam, kemeja linen pria masih ready?
ROBOT     │ Stok Kemeja Linen Pria masih ada 12 pcs, harganya Rp 320.000 per pcs.
          │ Mau pesan berapa?
Pelanggan │ 2 aja
ROBOT     │ Baik, 2 pcs Kemeja Linen Pria = Rp 640.000. Alamat kirimnya ke mana ya?
Pelanggan │ kirim ke Jl. Melati 12, Bekasi
ROBOT     │ Pesanan INV-5T5Q62 sudah saya buat. Totalnya Rp 652.000 sudah termasuk
          │ ongkir. Ini link pembayarannya: …/bayar/pRsSP67D6FNb2cL0PXW4rQ
```

That link opens a real checkout page, and the order lands on the sales board as
a deal at the same figure.

**The model has hands, but not a calculator.** It calls tools; the server does
every sum:

| Tool | What it does |
|---|---|
| `cari_produk` | Search the catalogue — required before quoting anything |
| `cek_ongkir` | Shipping cost for a city |
| `susun_pesanan` | Build the basket. **Model supplies SKU + quantity only**; prices, shipping and totals are computed here |
| `simpan_alamat` | Save recipient and address (encrypted like every personal field) |
| `konfirmasi_pesanan` | Lock the order, issue a checkout link, create the deal |
| `cek_pesanan` | This customer's recent orders |
| `serahkan_ke_orang` | Hand over to a human |
| `balas` | The **only** way anything reaches the customer |

Every figure a tool computes joins a "grounded amounts" set, and the guardrail
below rejects any rupiah figure that is not in it. So the bot can say
*Rp 652.000* only because the server added 640.000 and 12.000 itself.

`apps/worker` consumes the `autopilot.draft` queue and runs a bounded agent loop
(8 steps) against Claude (`claude-opus-5`); every reply is checked before anyone
sees it.

The design principle is **do not ask the model to be careful — make carelessness
detectable**. The model returns structured claims alongside its text (which
catalogue rows it used, whether it asserted stock), and those claims are verified
against the database:

- Every `Rp` figure must be a catalogue price, a whole multiple of one (a bulk
  quote), or a number already written into a policy. An invented price is caught.
- No discounts or delivery guarantees unless the shop switched them on.
- A stock claim requires stock in the catalogue.
- Links must already exist in the knowledge base.
- An angry customer goes to a person, whatever the draft says.
- An order cannot be confirmed without an address, and totals come from the
  catalogue — never from the model.
- Confirming an order **reserves** the stock atomically, so the last item cannot
  be sold twice; unpaid reservations are released after 24 hours.
- A workspace-level hourly cap stops a message flood becoming a cost event.

**A draft that broke any rule is never auto-sent, at any confidence.** Confidence
is the model's opinion of itself; a guardrail is a fact about the catalogue.
Workspaces start in `suggest` — the model writes, a person presses send — and a
single conversation can be set more cautious than the workspace, never bolder.

Without `ANTHROPIC_API_KEY` the worker runs a deterministic offline stand-in, so
the guardrail, metering and handover paths still work end to end; only the
generation is fake. That is also what the demo stack uses.

## The console

`apps/console` is a Next.js 15 app that server-renders against the API. Tokens
live in httpOnly cookies and every call is made from the server, so an XSS in the
console cannot walk off with a session. Mutations are server actions, so claiming
a chat, replying, resolving and moving a deal all work with JavaScript disabled —
which matters on a cheap phone with a bad connection.

**It is written for someone who has never used a CRM.** Three things in the
sidebar, because an agent does three things:

| | | |
|---|---|---|
| **Obrolan** | Chats | The daily job. Gold marker = this customer is waiting for you. |
| **Penjualan** | Sales | Board by stage. Orange = gone quiet. Move with a dropdown, not a drag. |
| **Tim** | Team | Who can sign in, and what each role may actually do, in sentences. |

Billing, Autopilot, the catalogue, security and history live behind
**Pengaturan** (Settings) — complete, but out of the way of the person answering
customers. The Autopilot page states each mode's consequence in a sentence and
lists every check in plain Indonesian; the Katalog page is where products, FAQs,
policies and shipping rates are edited in place, because that catalogue is the
only thing Autopilot is allowed to answer from.

Nothing was removed to make it simple; the jargon was. Every user-facing string
is in [`apps/console/lib/copy.ts`](apps/console/lib/copy.ts), one file, so the
plain-language pass can be reviewed by someone who does not read React. Two
examples of the rule being applied:

- "The 24-hour conversation window has closed — send an approved template"
  became *"Pelanggan ini terakhir chat lebih dari 24 jam lalu. Ini aturan dari
  WhatsApp, bukan dari kami…"* — because a person who understands **why** a
  button is blocked stops being afraid of it.
- "Unclaimed" became *"Belum dipegang"*, next to one obvious button:
  *"Saya yang tangani"*.

## Status

A working core with its security properties tested. Not yet built, and named as
such in the docs rather than implied away: broadcast campaigns, invoice delivery,
SSO, and a payment provider — invoices exist and are collected by bank transfer;
card and virtual-account charging is one adapter behind `PaymentProvider`. The console updates by polling on a 10-second interval — there is no
streaming endpoint yet, and the UI says "Live / Paused" rather than pretending
otherwise.

The Autopilot code path has been exercised end to end against a real database and
a scripted model, and type-checks against the Anthropic SDK — but it has **not**
been run against the live API from this machine, because no API key was
available. Set `ANTHROPIC_API_KEY` and the same path calls `claude-opus-5`.
