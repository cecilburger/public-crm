# Operations

## Service levels

The commitments the pricing page makes, and what they mean in monitoring terms.

| Objective | Target | Measured as |
|---|---|---|
| API availability | 99.9% monthly | non-5xx / total, excluding provider outages |
| Inbound latency | p95 < 3s, webhook → visible in inbox | spool `received_at` → message `created_at` |
| Outbound latency | p95 < 5s, send → accepted by Meta | outbox insert → `messages.status = 'sent'` |
| Message durability | zero accepted-then-lost | outbox depth alarm, spool `status='received'` age |
| Metering accuracy | exact | nightly recount of `billable_conversations` vs `usage_counters` |

99.9% is 43 minutes a month. Meta's own outages do not count against it and must
not, which is why the error budget is measured excluding provider 5xx.

## Metrics and checks

`GET /metrics` serves Prometheus text: default process metrics, plus request
counts and durations by **route pattern**, webhook outcomes, billable
conversations and Autopilot outcomes. Set `METRICS_TOKEN` in production — the
endpoint returns 404 without it, so a scraper that is not supposed to be there
does not even learn it exists. Traffic volumes and error rates are commercially
interesting to a competitor.

**No metric carries a tenant label.** A label per workspace is unbounded
cardinality that will eventually take the monitoring system down, and it turns a
scrape into a customer list. Per-tenant numbers live behind the authenticated
usage endpoint.

The `health.checks` job evaluates the six alerts below against the live database
and delivers anything failing to the alert sink. Thresholds live in
`packages/core/src/health.ts` so they can be tuned and tested without a database.

## Alerts that should page

1. `webhook_events` with `status='received'` older than 5 minutes — ingestion stalled.
1a. `emails` rows with `status='failed'` accumulating — mail is not going out,
   and invoices are being issued into silence.
1b. Orders stuck in `awaiting_payment` beyond the expiry window with the
   `orders.expire` job not running — stock is being held off the shelf.
2. `message_outbox` depth > 1,000 or oldest row > 10 minutes — sending stalled.
3. Audit chain verification failure — history was altered out of band.
4. Any channel at `quality='flagged'` — a WABA is about to be lost.
5. Postgres connection saturation > 80%.
6. Nightly metering recount disagreeing with counters by more than zero.

## Alerts that should not page

Usage threshold crossings (80%, 100% of plan), DSR requests approaching their
statutory due date, and failed sends with permanent 4xx classifications. These are
work items for business hours.

## Runbooks

**Ingestion stalled.** Check Redis reachability, then worker liveness. The spool
is the buffer — nothing is lost while it grows. Re-enqueue with the ids of rows
still in `received`; processing is idempotent, so replay is safe by construction.

**Sending stalled.** Check the channel's `quality`. If `flagged`, sending is
paused deliberately — Meta has restricted the number and the fix is with Meta, not
with us. Otherwise check `message_outbox.last_error` for the common cause.

**A number goes yellow.** `sendRatePerSecond()` throttles automatically. Look for a
broadcast that ran too hot; pace or pause it. Do not raise the limit.

**Suspected cross-tenant exposure.** Freeze deploys, run `npm test` (the isolation
tests are the fastest signal), then query `audit_events` for the actor and window.
The database is the enforcement point, so a leak means either a `withoutTenant`
misuse — three call sites, grep them — or a superuser session.

**Autopilot went quiet.** Check `max_replies_per_hour` against
`select count(*) from message_drafts where created_at > now() - interval '1 hour'`.
Hitting the cap is by design and shows as `rate_limited` on skipped jobs; raise it
per tenant if the traffic is genuine.

**A customer says their order vanished.** Unpaid orders are released after 24h by
`orders.expire`, which restores stock, cancels the checkout link and writes an
`order.released` audit event. The order row survives as `cancelled` — nothing is
deleted, so the conversation can be reconstructed.

**Suspected key compromise.** The KEK is the unrecoverable secret. Rotate it by
re-wrapping every `tenant_keys` row; data does not need re-encrypting for a KEK
rotation. A leaked *tenant* DEK needs re-encryption, and that job is not built yet.

## Backups and recovery

- Postgres: continuous archiving with point-in-time recovery, 30-day window.
- **RPO 5 minutes, RTO 1 hour.** Neither has been rehearsed in this repository;
  a restore drill is the first thing to schedule before taking real customers.
- Redis is a queue, not a store. Losing it loses in-flight jobs, not data — the
  outbox and the spool are both in Postgres, and both are replayable.
- Restore drills must include verifying an audit chain post-restore.

## Capacity

Rough figures for the plans as priced. A Scale tenant at 5,000 conversations a
month averages ~7 inbound messages per minute at peak, which is nothing for
Postgres; the constraint is Meta's per-number send rate, not our database.

First things to break, in order: `messages` write throughput (answer: partition by
month), per-number send rate (answer: more numbers, not more workers), advisory
lock contention on a single hot contact (bounded by one contact's message rate).

## Cost model

The margin question the pricing rests on, per conversation:

| Item | Rough cost |
|---|---|
| Meta conversation fee | Rp 0 (service) – 900 (marketing), passed through at cost |
| Infrastructure | ~Rp 40–70 |
| Autopilot generation | ~Rp 250–400 per draft at Opus 5 with the catalogue cached |
| **Charged** | **Rp 1,180 – 1,800** |

Autopilot is the lever: a conversation it resolves costs us more in inference and
far less in support salary, and it is the difference between a healthy margin and
a support business wearing software's clothes.

Two things keep that number honest. The catalogue and rules are identical for
every message a tenant receives, so they sit behind a cache breakpoint — the
per-draft input cost after the first is roughly a tenth. And effort is set to
`medium` by default: drafting a reply from a supplied catalogue is a
well-specified task, not a reasoning problem. Raise it per tenant if quality
demands, and watch the margin move.

Note that **every generation is billed to the tenant, including the ones the
guardrails block** — a blocked draft cost us a model call. That is visible in
their usage page as an AI reply, which is the honest presentation.

## Billing runbook

Invoices are issued by `billing.rollup` when a period closes, numbered
`KIR/<year>/<seq>` per tenant, and frozen at issue — the bill-to details and the
totals are snapshotted so a later price change cannot rewrite history. One
invoice per period is enforced by a partial unique index, so a retried job cannot
double-bill.

Collection is a bank transfer today. An operator reads the statement and records
the reference on **Pengaturan → Tagihan**; that marks the invoice paid, restores
a `past_due` tenant to `active`, and writes an audit event with the reference.

`billing.dunning` runs daily: reminders at 3, 7 and 14 days past due, then at 21
days the tenant is flagged `past_due` and a person is alerted. It deliberately
does **not** suspend anyone — cutting a shop off stops *their* customers being
answered, and that call belongs to a human with the account in front of them.

Email is delivered over SMTP (`SMTP_URL`), which every provider speaks — SES,
Mailgun, Resend, Postmark, a Gmail relay — so switching is a connection string
rather than a rewrite. With it unset, mail is logged instead of sent and the
worker says so at boot.

Every message is recorded in `emails` with its template, recipient and provider
message id, because support's first question about a billing dispute is "did they
actually get it?". A unique index on (template, reference) makes sending
idempotent: a retried job cannot mail a shop twice, and each reminder step counts
as its own message. A failed send is marked failed, which frees the index so the
next run retries.

## Connection pooling

Set `DATABASE_POOL_MODE=transaction` when deploying behind PgBouncer or any
transaction-mode pooler — RDS Proxy, Supavisor, pgcat. It disables named prepared
statements, which are bound to one server connection and vanish when the pooler
hands you a different one. Leaving it on `session` behind such a pooler produces
"prepared statement does not exist" under concurrency and nowhere else.

Tenant isolation itself is safe either way: context is set with
`set_config('app.tenant_id', …, true)` and `SET LOCAL ROLE`, both transaction
scoped, so nothing survives COMMIT to be inherited by the next borrower of that
connection. `tests/pooling.test.ts` holds that property in place.

## Deployment

Migrations run as the owner role, separately from and before the application
rolls. Forward-only. The application never has DDL rights, so a bad deploy cannot
alter the schema.

Order: migrate → roll workers → roll API. Workers tolerate old and new message
shapes for one release; the API does not.

## Not yet built

CI, staging, load tests, restore drills, on-call rotation, status page. This is a
functioning core with its operational envelope documented, not a service that has
been run in anger.
