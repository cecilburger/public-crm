# ADR 0002 — Hand-written SQL migrations, not a generated schema

**Status:** accepted · **Date:** 2026-08-24

## Context

The initial plan was Drizzle with generated migrations. Most of this schema's
security value is in constructs an ORM either does not model or models awkwardly:
RLS policies, `FORCE ROW LEVEL SECURITY`, role-targeted policies, per-role grants,
partial unique indexes with `WHERE` predicates, and `ON CONFLICT` inference over
those partial indexes.

## Decision

SQL-first. Seven numbered migration files applied forward-only with checksums, a
thin typed query layer over a driver seam, and no ORM. Editing an applied
migration is a hard error, because that is how staging and production drift.

## Consequences

**Good.** The security surface is reviewable as SQL by someone who does not know
TypeScript — which is what an auditor is. Migration checksums catch tampering.
The driver seam lets the same SQL run under PGlite in tests and postgres-js in
production.

**Bad.** Row types are hand-declared at each query site; a schema change that is
not reflected there is caught at runtime, not compile time.

**Amended 2026-08-26.** That cost was real: the same mistake — a column added to
the row type and the schema but not to the `SELECT` — got through three times,
each time silently disabling whatever the new column controlled, with no error
anywhere. `tests/sql-drift.test.ts` now parses both halves of every
`query<{…}>(\`…\`)` call and compares them; it covers 123 of 133 queries, skipping
only `select *` and non-literal SQL, and it carries a coverage floor so it cannot
quietly stop checking. A fixture reproduces the original bug to prove the check
would have caught it.

This does not make the decision free, but it converts a silent failure into a
failing test, which is the property that was actually missing.
