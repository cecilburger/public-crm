-- Short canned replies an agent can drop into a chat with one click — the
-- informal, no-approval-needed counterpart to message_templates. These only
-- work inside the 24-hour window (they go through the normal free-form send),
-- so unlike templates they carry no category/status/Meta-approval fields.
create table if not exists quick_replies (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  title       text not null,
  body        text not null,
  shortcut    text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists quick_replies_tenant_idx on quick_replies (tenant_id, created_at desc);

do $$
begin
  execute 'alter table quick_replies enable row level security';
  execute 'alter table quick_replies force row level security';
  if not exists (select 1 from pg_policies where tablename = 'quick_replies' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on quick_replies using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on quick_replies to kirana_app';
end $$;
