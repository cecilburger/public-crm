-- Login needs one read that happens before any session exists: turning a
-- workspace slug into a tenant id (`resolveWorkspace` in platform.ts). The
-- API's tenant connection (`kirana_app`) cannot do this — with no tenant
-- context yet, `tenant_isolation` on `tenants` hides every row, including
-- the one being searched for. That is by design (ADR 0001, "fails closed"),
-- so the fix is not to loosen kirana_app; it is the same shape as the
-- existing `checkout_lookup` policy on `payment_links` (0009_orders.sql):
-- a policy scoped to the control-plane role, `kirana_provisioner`, which
-- already has no access to any tenant's actual data — only the ability to
-- create a tenant row and (as of 0009) look up a payment link by its code.
do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'tenants' and policyname = 'workspace_lookup'
  ) then
    execute
      'create policy workspace_lookup on tenants for select to kirana_provisioner using (true)';
  end if;
end $$;

-- Deliberately not a blanket `select on tenants`: only the columns
-- `resolveWorkspace` actually reads leave this role's reach.
grant select (id, slug, status) on tenants to kirana_provisioner;
