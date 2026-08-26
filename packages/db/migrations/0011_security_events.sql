-- Detected security events, with the statutory clock attached.
--
-- The point of this table is that "we became aware at 14:02" is a row rather
-- than a memory. UU PDP art. 46 counts 3×24 hours from that moment.
create table if not exists security_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  kind         text not null,
  severity     text not null check (severity in ('info','warning','critical')),
  -- Whether personal data is plausibly affected, and so whether the clock runs.
  notifiable   boolean not null default false,
  summary      text not null,
  detail       jsonb not null default '{}',
  detected_at  timestamptz not null default now(),
  -- Set when the regulator and the affected people have been told.
  notified_at  timestamptz,
  notified_by  uuid references users(id) on delete set null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references users(id) on delete set null,
  notes        text
);
create index if not exists security_open_idx on security_events (tenant_id, detected_at desc);
create index if not exists security_clock_idx on security_events (tenant_id, detected_at)
  where notifiable and notified_at is null;

alter table security_events enable row level security;
alter table security_events force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'security_events' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on security_events
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
-- Insert and read, never amend: like the audit log, its value is in being
-- something the application cannot quietly tidy away.
grant select, insert, update on security_events to kirana_app;
