-- The actual file behind a document row — stored as base64 text in the
-- database rather than on disk or in object storage, since there's no such
-- service wired into this app yet and a quotation/invoice PDF is small.
-- Base64 text, not bytea: both drivers this app runs on (postgres-js in
-- production, PGlite in tests/dev-stack) are proven with plain text params
-- everywhere else in this codebase; bytea parameter marshalling isn't used
-- anywhere yet, and this isn't the place to be the first. Kept in its own
-- column, never selected by the list/detail queries, so browsing the
-- Dokumen table doesn't drag file bytes along for the ride.
alter table documents
  add column if not exists file_name text,
  add column if not exists file_mime text,
  add column if not exists file_size integer,
  add column if not exists file_data text;
