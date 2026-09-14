-- Where a customized Dokumen's canvas layout lives — a plain array of
-- positioned text/image elements (see packages/core/src/documentModels),
-- same jsonb convention as messages.media/audit_events.meta.
alter table documents add column if not exists layout jsonb;
