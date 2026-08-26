# ADR 0005 — Envelope encryption with blind indexes for personal data

**Status:** accepted · **Date:** 2026-08-24

## Context

Disk encryption protects against someone stealing the server. It does nothing
about a leaked backup, an over-broad read replica, or a support engineer running
`select * from contacts`. Under UU PDP the phone numbers and message bodies here
are personal data belonging to our customers' customers.

## Decision

Per-tenant data keys, wrapped by a KEK held outside the database. AES-256-GCM
with the tenant id as additional authenticated data, so a row copied into another
tenant fails to decrypt rather than silently revealing itself. Equality lookup on
phone numbers uses a per-tenant HMAC blind index.

## Consequences

**Good.** A stolen dump is ciphertext. One compromised tenant key is one tenant.
Erasure is crypto-shredding — null the fields and the blind index, and the contact
also drops out of the partial unique index so a later message is a new customer.
Cross-tenant row moves fail loudly.

**Bad.** No `LIKE` search on encrypted fields; only exact match through the blind
index. Every read of a body costs a decrypt. Key rotation needs a re-encryption
job, which is designed but **not yet written**. Blind indexes leak equality — an
attacker with the database can tell that two rows share a phone number without
learning it, which is the accepted price of being able to find a customer.
