# ADR 0003 — Billing by 24-hour conversation window, not per message or per seat

**Status:** accepted · **Date:** 2026-08-24

## Context

Seat pricing punishes the customer for hiring, which is the opposite of what a
CRM should encourage, and it makes AI deflection a *loss* for us. Per-message
pricing is unpredictable for the buyer — nobody can forecast how chatty their
customers will be. Meta's own model (per business number, per 24h, per category)
is precise and impossible to explain to a warung owner.

## Decision

One billable conversation = one contact talking to one tenant inside a rolling
24-hour window, regardless of message count, agent count or channel. Deliberately
more generous than Meta's model, and simple enough to say in one sentence.

Meta's fee is metered separately in `meta_cost_events` and passed through at cost
on its own invoice line.

The two use different clocks on purpose: the **reply window** follows the
provider's timestamp (Meta's clock decides whether a free-form reply is legal),
while the **billing window** follows arrival time (monotonic, immune to a
redelivered webhook carrying an old timestamp).

## Consequences

**Good.** The pricing page is one sentence. Autopilot deflection makes the
customer cheaper to serve and us more profitable at the same time. Forecasting is
easy for both sides.

**Bad.** A tenant with unusually chatty customers is subsidised by one with
efficient ones. Concurrency is genuinely hard: two messages in the same
millisecond must not open two windows, which needs an advisory lock on
`(tenant, contact)` because a unique index cannot express "one row where
`expires_at > now()`". That lock is tested under a concurrent burst.
