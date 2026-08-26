# What is left before this can take money

> **Progress, 26 Aug:** the marketing site now lists only what ships; CI is
> written, including a job that runs the whole suite against real Postgres;
> rate limiting and login throttling are Redis-backed behind one interface; and
> server actions carry CSRF tokens; and two-factor sign-in works end to end.
> Struck-through items below are done. **Phase 2's engineering work is
> complete**, and the two Phase 1 items that needed no decision — the catalogue
> UI and the per-contact cap — are done too. What is left in Phase 1 is entirely
> downstream of two choices: WhatsApp access (Meta) and a payment provider.
> Phase 2's remainder is the DPA, terms and privacy policy, which need a lawyer.

Written 2026-08-26, against the code as it stands: 158 tests passing, ~11,500
lines. This is the honest distance between a working core and a business.

Estimates assume **two engineers**. They are estimates.

---

## 1. Where it actually stands

**Built and tested.** Multi-tenant Postgres with row-level security, encrypted
personal data, auth with rotating refresh tokens, hash-chained audit log, the
WhatsApp inbox, conversation-window metering that matches the price list,
conversation-native pipeline, UU PDP erasure, the Indonesian agent console, and
Autopilot — including tool use, order taking, stock reservation, checkout links
and a spend cap.

**Built but never run for real.** Everything above has only ever executed against
PGlite (Postgres compiled to WASM) — there is no Docker on the development
machine. And the live Claude path type-checks against the SDK but has never made
an HTTP request, because no API key was available.

**Sold on the marketing site, not built.** The pricing page's feature table
promises eight things the code does not do:

| Promised | Reality |
|---|---|
| Broadcast campaigns & A/B testing | A permission string. No code. |
| Voice: recording, transcript, AI summary | A plan flag. No code. |
| Revenue analytics & agent leaderboard | A plan flag. No code. |
| Channels: IG, TikTok, Tokopedia, Shopee, email, web | Only the Meta webhook exists |
| Live translation | Nothing |
| Integrations: Midtrans, Xendit, Accurate, Jurnal, n8n, Zapier | Nothing |
| SSO / SAML | Nothing (roles and audit log do exist) |
| WhatsApp green tick service | A line item with no process behind it |

**Metered but never charged.** `closePeriodAndDraftInvoice` produces an invoice
draft. Nothing sends it, and nothing collects payment. Today the product would
serve customers for free indefinitely.

---

## 2. The long pole is not code

**You cannot resell WhatsApp Business API access without Meta's permission.**
Either become a Meta Tech Provider (business verification, app review, a
commercial agreement — weeks to months, mostly waiting) or resell through an
existing provider, which is faster and takes a cut of the margin the pricing page
assumes.

Nothing in engineering removes this dependency, and everything in Phase 1 is
downstream of it. **Start the application this week**, in parallel with all the
work below.

---

## 3. Phases

### Phase 0 — Prove it runs (1 week, blocks everything)

| Task | Why |
|---|---|
| ~~Run migrations and the full suite against real Postgres 16~~ — **CI job written; runs on first push.** No container runtime exists on the dev machine, so it has still never executed | Roles, `FORCE` RLS, advisory locks, partial indexes and `ON CONFLICT … WHERE` are all expected to behave identically. Expected is not verified. |
| Make one live Claude call end to end with a real key | The agent loop has never made an HTTP request |
| ~~CI: typecheck + tests on every push~~ **Done** — four jobs, incl. dependency audit | There was none |
| One restore drill from a point-in-time snapshot, verifying an audit chain afterwards | RPO/RTO are currently aspirations |

### Phase 1 — The gate to a first paying customer (4–6 weeks, gated by Meta)

| Task | Why |
|---|---|
| WhatsApp access — Tech Provider or reseller | Without it there is no product |
| Payment provider (Xendit or Midtrans) — **your decision** | The checkout page is a stub showing bank details. A `PaymentProvider` interface now exists with a working manual-transfer implementation; a provider is one adapter |
| ~~Invoices, faktur pajak fields, dunning, delivery~~ **Done** — numbered, durable, chased, and emailed over SMTP. Card/VA charge still needs a provider choice | We meter perfectly and bill nobody |
| ~~Catalogue management UI~~ **Done** — products, FAQs, policies and shipping rates, edited in place | An owner cannot add a product without `curl`. Autopilot is only as good as its catalogue |
| ~~Per-contact Autopilot cap~~ **Done** — default 12/hour per customer, alongside the workspace cap | One abusive customer can spend a workspace's hourly allowance |

### Phase 2 — Before any real customer data (2–3 weeks)

| Task | Why |
|---|---|
| ~~Redis-backed rate limiting and login throttle~~ **Done**, one store behind one interface, fails open | In-process today; wrong the moment there are two replicas |
| ~~MFA for owner and admin~~ **Done** — TOTP against the RFC vectors, single-use codes, recovery codes, console flow in Bahasa | The column exists, the flow does not |
| ~~CSRF tokens on server actions~~ **Done**, double-submit with an httpOnly cookie | `sameSite=lax` plus Next's Origin check covers the common case, not all of it |
| Webhook IP allow-list and timestamp replay window | A signed-but-old event is currently accepted |
| ~~Breach detection and alerting~~ **Done** — five detectors, statutory clock, hourly chase, console view | UU PDP gives 3×24 hours to notify. A clock nobody starts is not compliance |
| DPA, terms, privacy policy — reviewed by an Indonesian lawyer | Procurement will ask on day one |
| ~~DEK rotation job~~ **Done** — resumable, no maintenance window, index key deliberately left alone | Designed, not written |

### Phase 3 — Close the gap with the price list (6–8 weeks, or one day)

**Resolved: the site was amended.** Every unbuilt promise is gone — broadcasts,
voice, analytics, six of the seven channels, translation, SSO, the green tick
service and the integration list. What replaced them is what actually ships:
Autopilot taking orders, stock reservation, guardrails, the usage dashboard.
Build the features later and raise prices when they land.

If building, the order that matters commercially: broadcasts → analytics →
Tokopedia/Shopee → voice → the rest.

### Phase 4 — Operate it (2 weeks, then ongoing)

~~Monitoring on the six alerts already specified~~ **Done** — `/metrics` in
Prometheus format with bounded cardinality and a token guard, plus a
`health.checks` job that evaluates all six against the live database and alerts
on anything failing. Still to do: a staging environment, a load test at plan
volumes, an on-call rotation, and a status page.

### Phase 5 — Pilot, then launch (4 weeks)

Three to five real shops on Starter, free, watched closely. The four numbers that
decide whether the business works:

1. **Autopilot accept rate** — how often an agent sends the draft unedited
2. **Guardrail block rate** — high means the catalogue is thin, not that the model is bad
3. **Cost per conversation** against the Rp 250–400 assumption in `OPERATIONS.md`
4. **Whether 1.000 conversations/month** is the right Starter allowance for a real shop

---

## 4. The shortest honest path to launch

Roughly six weeks after WhatsApp access lands, if you cut hard:

- WhatsApp only. Drop the other seven channels from the site.
- Autopilot in **suggest** mode only. Auto-send after the accept rate is known.
- Bank transfer only. No payment provider.
- Manual invoicing for the first ten customers — a spreadsheet and a bank account.
- Phase 0 and Phase 2 in full. Neither is optional with real customer data.

That is a real product: an Indonesian WhatsApp CRM with an AI that drafts replies
and takes orders, priced per conversation. Everything else is expansion.

---

## 5. Decisions needed now

1. **Meta:** own Tech Provider status, or resell through an existing provider?
   Decides the timeline more than any engineering choice.
2. **The price list:** build the eight missing features, or cut the site to match
   the product?
3. **Payments:** Xendit or Midtrans.
4. **Launch scope:** WhatsApp-only in six weeks, or full multi-channel in four
   months?
