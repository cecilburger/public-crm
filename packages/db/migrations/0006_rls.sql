-- Tenant isolation is enforced by the database, not by remembering to add
-- `where tenant_id = ?` in 200 query sites. The application role has no way to
-- opt out: policies are FORCEd, and an unset tenant context yields zero rows.

grant usage on schema public to kirana_app, kirana_ingest, kirana_provisioner;

do $$
declare
  t text;
  tenant_tables text[] := array[
    'tenant_keys','users','refresh_tokens','api_keys',
    'channels','contacts','conversations','messages','message_outbox','timeline_events',
    'pipelines','pipeline_stages','deals',
    'subscriptions','billing_periods','billable_conversations','usage_counters','meta_cost_events',
    'dsr_requests'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'tenant_isolation') then
      execute format(
        'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    end if;
    execute format('grant select, insert, update, delete on %I to kirana_app', t);
  end loop;
end $$;

-- The tenant row itself: a session may see and update only its own.
alter table tenants enable row level security;
alter table tenants force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'tenants' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on tenants
      using (id = app_current_tenant()) with check (id = app_current_tenant());
  end if;
end $$;
grant select, update on tenants to kirana_app;

-- Creating a tenant is the one operation that cannot be performed from inside a
-- tenant context. It is scoped to its own role by policy rather than handed a
-- BYPASSRLS grant, so the control plane still cannot read tenant data.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'tenants' and policyname = 'provisioner_create') then
    create policy provisioner_create on tenants for insert to kirana_provisioner with check (true);
  end if;
end $$;
grant insert on tenants to kirana_provisioner;

-- Audit log: append and read, never amend. This grant is the control.
alter table audit_events enable row level security;
alter table audit_events force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'audit_events' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on audit_events
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert on audit_events to kirana_app;
grant usage on sequence audit_events_id_seq to kirana_app;

-- Raw webhook spool: no tenant column to filter on before the payload is
-- parsed, so it is reachable only by the ingest role and never by a tenant session.
revoke all on webhook_events from kirana_app;
grant select, insert, update on webhook_events to kirana_ingest;
