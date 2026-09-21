-- 0049 covered the one control-plane read needed for login. Running the
-- ig-bridge/WA-bridge/webhook path for real (not just PGlite tests, where
-- `assumeRole` quietly bypasses all of this — see tests/helpers/db.ts)
-- surfaced the rest: `processInboundWebhook` and the `/v1/webhooks/*` routes
-- do several more `withoutTenant` reads and writes over `ctx.control` before
-- a tenant is known — spooling a webhook, claiming it, resolving which
-- tenant a channel belongs to, recording a dead ig-bridge session — and
-- kirana_provisioner had none of those grants, so every one of them was
-- failing closed under RLS exactly like the tenants lookup did.
--
-- `webhook_events` holds raw provider payloads (message text included), which
-- is why it is normally reachable only by kirana_ingest and not even by
-- kirana_app (0006_rls.sql). Splitting control-plane traffic across a second
-- role here, rather than folding this into kirana_provisioner, would be the
-- more faithful fix; running one `control` connection as kirana_provisioner
-- for everything is the pragmatic version of that, so it gets the same
-- narrow grant kirana_ingest already has instead of a general one.

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'webhook_events' and policyname = 'control_plane'
  ) then
    execute 'create policy control_plane on webhook_events for all to kirana_provisioner using (true) with check (true)';
  end if;
end $$;
grant select, insert, update on webhook_events to kirana_provisioner;

-- Channel → tenant routing. No customer content lives on this table, only
-- provider identity and connection status.
do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'channels' and policyname = 'control_plane_select'
  ) then
    execute 'create policy control_plane_select on channels for select to kirana_provisioner using (true)';
  end if;
  if not exists (
    select 1 from pg_policies where tablename = 'channels' and policyname = 'control_plane_update'
  ) then
    execute 'create policy control_plane_update on channels for update to kirana_provisioner using (true) with check (true)';
  end if;
end $$;
grant select, update on channels to kirana_provisioner;

-- Marking a dead ig-bridge session before any tenant context can exist.
do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'ig_bridge_connections' and policyname = 'control_plane_select'
  ) then
    execute 'create policy control_plane_select on ig_bridge_connections for select to kirana_provisioner using (true)';
  end if;
  if not exists (
    select 1 from pg_policies where tablename = 'ig_bridge_connections' and policyname = 'control_plane_update'
  ) then
    execute 'create policy control_plane_update on ig_bridge_connections for update to kirana_provisioner using (true) with check (true)';
  end if;
end $$;
grant select, update on ig_bridge_connections to kirana_provisioner;

-- retention_days is read by `eachTenant` alongside id/slug/status.
grant select (retention_days) on tenants to kirana_provisioner;

-- `platformHealthSnapshot` (packages/db/src/platform.ts) — counts only, no
-- row content, for the worker's `health.checks` cron.
do $$
declare
  t text;
begin
  foreach t in array array['message_outbox', 'billable_conversations', 'usage_counters', 'security_events'] loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'control_plane') then
      execute format('create policy control_plane on %I for select to kirana_provisioner using (true)', t);
    end if;
    execute format('grant select on %I to kirana_provisioner', t);
  end loop;
end $$;
