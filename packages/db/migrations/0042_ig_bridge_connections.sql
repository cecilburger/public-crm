-- Instagram bridge: an unofficial connection (Playwright driving the real
-- instagram.com login form, the same idea as the WhatsApp Web bridge) so a
-- tenant can log in from Pengaturan without going through Meta's official
-- Instagram Messaging API. One row per tenant, like `tenant_email_settings` —
-- this is a single shared business account, not a list of numbers the way
-- WhatsApp channels are.
--
-- The password itself is never stored here — `apps/ig-bridge` only ever
-- sees it in-flight to log in, and keeps the live session as a Chromium
-- profile on its own disk. Losing this row loses only the "who's connected"
-- display, never a credential.

create table if not exists ig_bridge_connections (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  username_enc  text,
  status        text not null default 'disconnected'
                 check (status in ('disconnected','challenge_required','ready','error')),
  challenge_type text check (challenge_type in ('two_factor','checkpoint','unknown')),
  last_error    text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references users(id) on delete set null
);

alter table ig_bridge_connections enable row level security;
alter table ig_bridge_connections force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'ig_bridge_connections' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on ig_bridge_connections
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert, update, delete on ig_bridge_connections to kirana_app;
