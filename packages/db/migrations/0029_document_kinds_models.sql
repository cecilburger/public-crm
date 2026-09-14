-- "Template" (the closed penawaran/invoice/kwitansi/lainnya field) is
-- relabelled "Jenis" in the UI and, like tasks.kind before it, opened up so a
-- tenant can add their own on top of the four built in. The column itself is
-- renamed to `kind` so the name matches what it now means — a fresh "Template"
-- field (a plain yes/no) takes its old name instead.
alter table documents rename column template to kind;

create table if not exists document_kinds (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists document_kinds_name_key on document_kinds (tenant_id, lower(name));
create index if not exists document_kinds_tenant_idx on document_kinds (tenant_id, created_at desc);

-- Same idea for `model`, today locked to 'standar' — a tenant can name their
-- own on top of it, same as document_kinds.
create table if not exists document_models (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists document_models_name_key on document_models (tenant_id, lower(name));
create index if not exists document_models_tenant_idx on document_models (tenant_id, created_at desc);

do $$
begin
  execute 'alter table document_kinds enable row level security';
  execute 'alter table document_kinds force row level security';
  if not exists (select 1 from pg_policies where tablename = 'document_kinds' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on document_kinds using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on document_kinds to kirana_app';

  execute 'alter table document_models enable row level security';
  execute 'alter table document_models force row level security';
  if not exists (select 1 from pg_policies where tablename = 'document_models' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on document_models using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on document_models to kirana_app';
end $$;

-- A plain yes/no the Dokumen form now asks for, unrelated to the renamed
-- column above beyond reusing its old name.
alter table documents add column if not exists use_template boolean not null default true;

-- `kind` (renamed from `template` above) and `model` were closed enums;
-- opened up to free text so a custom name from document_kinds/document_models
-- can be stored the same way the built-ins already are — no foreign key, same
-- reasoning as task_kinds: a document keeps whichever string was picked even
-- if the saved name is later renamed or removed.
do $$
declare
  con text;
begin
  select conname into con
    from pg_constraint
   where conrelid = 'documents'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%kind%';
  if con is not null then
    execute format('alter table documents drop constraint %I', con);
  end if;

  select conname into con
    from pg_constraint
   where conrelid = 'documents'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%model%';
  if con is not null then
    execute format('alter table documents drop constraint %I', con);
  end if;
end $$;
