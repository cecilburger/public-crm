# UU PDP compliance notes

Indonesia's Undang-Undang Perlindungan Data Pribadi (UU 27/2022). Kirana is a
**processor** for its tenants, who are the controllers of their customers' data.
This maps the obligations that fall on us to what the code does.

Not legal advice; written to give counsel something concrete to review.

| Obligation | Where it lives | Status |
|---|---|---|
| Lawful basis and consent recorded with the data | `contacts.consent` (basis, source, timestamp) | Schema present; capture UI not built |
| Purpose limitation | Data model holds only what conversations need | Done |
| Retention limits (art. 43) | `tenants.retention_days`, 30–3650, enforced by `retention.purge` | Done |
| Right of access / portability (arts. 26–30) | `dsr_requests` kind `access`/`export` | Tracked with a clock; export artefact generation not built |
| Right to erasure (art. 31) | `POST /v1/dsr/:id/execute` — crypto-shreds identifiers, redacts bodies | Done and tested |
| Right to rectification | `dsr_requests` kind `rectification` | Tracked; applied manually |
| Security of processing (art. 35) | Envelope encryption, RLS, RBAC, audit chain — see SECURITY.md | Done |
| Breach notification within 3×24 hours (art. 46) | Detection depends on alerting | **Gap: alerting not built** |
| Records of processing | `audit_events`, hash-chained and append-only | Done |
| Data residency | `tenants.data_region`, default `id-jkt` | Schema + deployment convention |
| Processor obligations to controller | DPA template | Not written |
| DPO appointment | Organisational | Not applicable to code |

## The erasure path in detail

Because it is the one a regulator will actually test:

1. Request recorded in `dsr_requests` with a statutory due date (3 days default).
2. Execution nulls `phone_enc`, `phone_bidx`, `email_enc`, `email_bidx`,
   `display_name`, attributes and tags; sets `deleted_at`.
3. Message bodies and media are nulled across every conversation of that contact.
4. Clearing the blind index also drops the contact out of the partial unique
   index, so a future message from that number becomes a genuinely new customer
   rather than resurrecting the erased one.
5. An audit event records the erasure, including how many messages were redacted.
6. **Usage counters are deliberately untouched** — they hold counts, not people,
   and invoices already issued must keep reconciling.

`tests/api.test.ts` asserts steps 2, 3 and 6 together.

## Honest gaps

- **Backups still contain erased data** until they age out of the 30-day window.
  This belongs in the privacy policy as a disclosure; it is not fixable without
  destroying point-in-time recovery.
- **Export artefacts** are not generated; the request is tracked, the file is manual.
- **Consent capture** has a schema and no user interface.
- **Breach detection** is the largest compliance gap: a 3×24-hour notification
  clock is meaningless without alerting that starts it.
