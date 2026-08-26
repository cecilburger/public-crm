-- Rotating a tenant's data key.
--
-- Re-encrypting every ciphertext takes time, so for the duration there are two
-- live keys: rows already moved are under the new one, the rest are still under
-- the old. Readers try the current key and fall back to the previous, which is
-- what makes the job interruptible without taking the workspace offline.
alter table tenant_keys add column if not exists previous_wrapped_dek text;
alter table tenant_keys add column if not exists rotation_started_at  timestamptz;

-- Progress, per table, so a job killed halfway resumes instead of restarting.
create table if not exists key_rotations (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  table_name  text not null,
  last_id     uuid,
  rows_done   bigint not null default 0,
  completed_at timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, table_name)
);

alter table key_rotations enable row level security;
alter table key_rotations force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'key_rotations' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on key_rotations
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert, update, delete on key_rotations to kirana_app;
