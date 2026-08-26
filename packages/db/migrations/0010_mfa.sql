-- Second factor.
--
-- The secret column already existed and was never used; this adds the state
-- around it: whether it is switched on, the last counter accepted (so a code
-- cannot be replayed inside its own 30-second window), and recovery codes,
-- because a lost phone must not mean a lost workspace.
alter table users add column if not exists mfa_enabled_at   timestamptz;
alter table users add column if not exists mfa_last_counter bigint;

create table if not exists mfa_backup_codes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  -- Hashed, like every other credential in this system.
  code_hash  text not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index if not exists mfa_backup_user_idx on mfa_backup_codes (tenant_id, user_id) where used_at is null;

alter table mfa_backup_codes enable row level security;
alter table mfa_backup_codes force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'mfa_backup_codes' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on mfa_backup_codes
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert, update, delete on mfa_backup_codes to kirana_app;
