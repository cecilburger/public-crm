-- Custom "Jenis" values a tenant can add straight from the task form, on top
-- of the four built into the UI (Follow-up/Telepon/Meeting/Lainnya). Just a
-- saved name list, no foreign key from `tasks.kind` — a task stores whichever
-- string was picked directly, same as it already does for the built-ins, so
-- renaming or removing an entry here never orphans an existing task.
create table if not exists task_kinds (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create unique index if not exists task_kinds_name_key on task_kinds (tenant_id, lower(name));
create index if not exists task_kinds_tenant_idx on task_kinds (tenant_id, created_at desc);

do $$
begin
  execute 'alter table task_kinds enable row level security';
  execute 'alter table task_kinds force row level security';
  if not exists (select 1 from pg_policies where tablename = 'task_kinds' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on task_kinds using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on task_kinds to kirana_app';
end $$;

-- `tasks.kind` was a closed enum (follow_up/call/meeting/other); opened up to
-- free text so a custom name from task_kinds can be stored the same way.
do $$
declare
  con text;
begin
  select conname into con
    from pg_constraint
   where conrelid = 'tasks'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%kind%';
  if con is not null then
    execute format('alter table tasks drop constraint %I', con);
  end if;
end $$;
