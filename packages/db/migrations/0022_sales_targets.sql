-- A goal a supervisor sets for the team or for one agent over a date range —
-- achievement is never stored here, it is always computed fresh from won
-- deals in that range, so the two can never drift out of sync.
create table if not exists sales_targets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  owner_id     uuid references users(id) on delete cascade,
  amount_idr   bigint not null check (amount_idr > 0),
  notes        text,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (period_end >= period_start)
);
create index if not exists sales_targets_tenant_idx on sales_targets (tenant_id, period_start desc);

do $$
begin
  execute 'alter table sales_targets enable row level security';
  execute 'alter table sales_targets force row level security';
  if not exists (select 1 from pg_policies where tablename = 'sales_targets' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on sales_targets using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on sales_targets to kirana_app';
end $$;
