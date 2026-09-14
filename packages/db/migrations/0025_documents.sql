-- The Customize > Dokumen list: named documents a tenant keeps on file, each
-- built from one of a few fixed kinds. Just the record for now — no content
-- or layout yet, that's the PDF template editor landing on top of this later.
create table if not exists documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  template    text not null check (template in ('penawaran', 'invoice', 'kwitansi', 'lainnya')),
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists documents_tenant_idx on documents (tenant_id, created_at desc);

do $$
begin
  execute 'alter table documents enable row level security';
  execute 'alter table documents force row level security';
  if not exists (select 1 from pg_policies where tablename = 'documents' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on documents using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on documents to kirana_app';
end $$;
