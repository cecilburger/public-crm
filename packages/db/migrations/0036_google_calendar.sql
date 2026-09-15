-- One Google Calendar connection per user, not per tenant — the calendar
-- being pulled in belongs to whichever person authorised it, so each agent
-- who wants their own schedule shown connects their own account. Tokens are
-- application-level encrypted the same way a WA channel's credentials are
-- (via `sealField`/`openField`), not left as plain text.
create table if not exists google_calendar_connections (
  tenant_id          uuid not null references tenants(id) on delete cascade,
  user_id            uuid not null references users(id) on delete cascade,
  google_email       text,
  access_token_enc   text not null,
  refresh_token_enc  text not null,
  token_expires_at   timestamptz not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

do $$
begin
  execute 'alter table google_calendar_connections enable row level security';
  execute 'alter table google_calendar_connections force row level security';
  if not exists (
    select 1 from pg_policies
     where tablename = 'google_calendar_connections' and policyname = 'tenant_isolation'
  ) then
    execute
      'create policy tenant_isolation on google_calendar_connections using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on google_calendar_connections to kirana_app';
end $$;
