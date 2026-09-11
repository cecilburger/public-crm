-- Follow-ups and reminders. A task is always about a customer — the deal or
-- conversation it grew out of is optional context, not the anchor, because
-- "call her back Thursday" is worth tracking even before there is a deal.
create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  contact_id      uuid not null references contacts(id) on delete cascade,
  deal_id         uuid references deals(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  title           text not null,
  notes           text,
  due_at          timestamptz not null,
  assignee_id     uuid references users(id) on delete set null,
  status          text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_by      uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index if not exists tasks_due_idx on tasks (tenant_id, status, due_at);
create index if not exists tasks_assignee_idx on tasks (tenant_id, assignee_id, status);
create index if not exists tasks_contact_idx on tasks (tenant_id, contact_id);

do $$
begin
  execute 'alter table tasks enable row level security';
  execute 'alter table tasks force row level security';
  if not exists (select 1 from pg_policies where tablename = 'tasks' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on tasks using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on tasks to kirana_app';
end $$;
