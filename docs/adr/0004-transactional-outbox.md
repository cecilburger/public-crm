# ADR 0004 — Outbox for outbound messages, never send-on-request

**Status:** accepted · **Date:** 2026-08-24

## Context

An agent presses send. We must persist the message, update the conversation, and
call Meta. Doing the provider call inside the request means a slow Meta makes the
console slow, a timeout leaves us unsure whether the customer got the message, and
a retry can send it twice.

## Decision

The API writes the message row and a `message_outbox` row in the same transaction
as the conversation update, then returns 202. A worker is the only thing that
talks to Meta. The policy gate (`guardOutbound`) is re-applied in the worker.

## Consequences

**Good.** No state where a reply is saved but unsendable, or sent but unsaved. The
console stays fast while Meta is slow. Retries and backoff live in one place. The
worker gate cannot be bypassed by an automation, a retry or a broadcast.

**Bad.** "Sent" is eventual, so the UI has to show a queued state and reconcile on
delivery receipts. The gate is evaluated twice — once for a fast error message to
the agent, once for real. The duplication is intentional and commented in both places.
