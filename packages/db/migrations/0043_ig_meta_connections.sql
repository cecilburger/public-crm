-- Instagram via Meta's official "Instagram API with Instagram Login" — a
-- second, sanctioned way to connect Instagram alongside
-- `ig_bridge_connections` (the Playwright one). One row per tenant: the
-- long-lived Instagram user access token is the credential that actually
-- matters here, so it's the one field that's encrypted; the rest is just
-- what the Settings page shows. No Facebook Page is involved in this
-- product — the token is scoped straight to the Instagram account.

create table if not exists ig_meta_connections (
  tenant_id          uuid primary key references tenants(id) on delete cascade,
  access_token_enc   text,
  ig_user_id         text,
  ig_username        text,
  status             text not null default 'disconnected'
                      check (status in ('disconnected','connected','error')),
  last_error         text,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references users(id) on delete set null
);

alter table ig_meta_connections enable row level security;
alter table ig_meta_connections force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'ig_meta_connections' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on ig_meta_connections
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert, update, delete on ig_meta_connections to kirana_app;
