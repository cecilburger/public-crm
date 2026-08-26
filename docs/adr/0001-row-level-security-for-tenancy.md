# ADR 0001 — Tenant isolation lives in Postgres, not in the application

**Status:** accepted · **Date:** 2026-08-24

## Context

Every tenant's conversations sit in one database. A leak between two tenants is
not a bug report, it is the end of the company. The usual approach — add
`WHERE tenant_id = ?` in every query — works until the one query somebody
forgets, and there is no way to test for the query that has not been written yet.

## Options

1. **Filter in application code.** Cheapest, and correct exactly as often as the
   team is perfect.
2. **Database per tenant.** Strongest isolation; migrations across thousands of
   databases, and a small Indonesian SMB customer does not justify a database.
3. **Shared schema with row-level security.** One rule, stated once, enforced by
   the engine under every query including ad-hoc ones.

## Decision

Option 3. RLS on all 20 tenant tables, `FORCE`d so table owners are subject to
it too. The application connects as `kirana_app`, which has no `BYPASSRLS`.
Tenant context is set per transaction with `set_config('app.tenant_id', …, true)`
and the connection drops to the unprivileged role inside the transaction.

Cross-tenant work needs `withoutTenant(db, reason, fn)`, which requires a written
reason at the call site.

**Amended 2026-08-26.** That hole grew from three call sites to twenty-three as
background jobs arrived, at which point "grep it and read them" stopped being a
real review. It is now fronted by three named primitives in
`packages/db/src/platform.ts` — `eachTenant`, `resolveWorkspace` and
`platformHealthSnapshot` — each of which does one thing and, crucially, returns
**identifiers, statuses or counts and never tenant data**. A bug in one of them
cannot leak a customer's messages, because none of them can read a customer's
messages.

Six raw call sites remain, all in operations that run before a tenant context can
exist: spooling a webhook, resolving a checkout link, turning a spooled payload
into a tenant, and creating the tenant row itself. `tests/architecture.test.ts`
pins that list, so growing it is a deliberate act that shows up in review.

## Consequences

**Good.** An unset context returns zero rows — isolation fails closed. The rule
holds for analytics queries, read replicas and psql sessions, not just ORM code.
It is testable: `tests/rls.test.ts` asserts it against real Postgres.

**Bad.** Every connection must set context, so connection pooling in transaction
mode needs care. **Verified 2026-08-26:** context is set with
`set_config(…, true)` and `SET LOCAL ROLE`, both of which end at COMMIT, so a
transaction-mode pooler is safe — `tests/pooling.test.ts` proves context, role
and visibility all reset between transactions on one physical connection.

The same audit found a real hazard beside it: the driver was configured with
named prepared statements, which are bound to a single server connection. Behind
PgBouncer in transaction mode the connection changes between transactions and the
statement is gone — an error that appears only under concurrency, in production,
and never in a test. `DATABASE_POOL_MODE=transaction` now turns them off. Policies add a small planning cost. Creating a tenant needs a
second, differently-privileged role — solved with a role-targeted policy rather
than a `BYPASSRLS` grant.
