-- Manual file upload turned out not to be the shape this needed — a document
-- is now generated from code (see packages/core/src/documentModels), so the
-- uploaded-file columns from 0026 come back off, and `model` records which
-- coded generator built it (today just 'standar'; room for more later).
alter table documents
  drop column if exists file_name,
  drop column if exists file_mime,
  drop column if exists file_size,
  drop column if exists file_data,
  add column if not exists model text not null default 'standar' check (model in ('standar'));
