-- A reference list of Meta-approved WhatsApp templates, so an agent knows
-- which template name and variable order to use when starting a chat outside
-- the 24-hour window. This only records what Meta has already approved —
-- it does not submit templates for review itself.
create table if not exists message_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  category    text not null check (category in ('marketing', 'utility', 'authentication')),
  language    text not null default 'id',
  body        text not null,
  status      text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'rejected')),
  notes       text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists message_templates_name_key on message_templates (tenant_id, lower(name));
create index if not exists message_templates_tenant_idx on message_templates (tenant_id, created_at desc);

do $$
begin
  execute 'alter table message_templates enable row level security';
  execute 'alter table message_templates force row level security';
  if not exists (select 1 from pg_policies where tablename = 'message_templates' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on message_templates using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on message_templates to kirana_app';
end $$;
