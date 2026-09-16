-- Per-tenant SMTP configuration, so a tenant can point outgoing email (meeting
-- invites today) at its own mailbox/provider from Pengaturan instead of the
-- one shared server-wide SMTP_URL every tenant used to be stuck with. Left
-- unconfigured, sending falls back to that shared default — this table only
-- ever overrides it, never replaces it as a requirement.
create table if not exists tenant_email_settings (
  tenant_id    uuid primary key references tenants(id) on delete cascade,
  -- Holds the connection string (smtps://user:pass@host:port) — encrypted,
  -- the same field-encryption every other credential-shaped column in this
  -- schema uses, since it carries a password.
  smtp_url_enc text,
  email_from   text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references users(id) on delete set null
);

do $$
begin
  execute 'alter table tenant_email_settings enable row level security';
  execute 'alter table tenant_email_settings force row level security';
  if not exists (select 1 from pg_policies where tablename = 'tenant_email_settings' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on tenant_email_settings using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update on tenant_email_settings to kirana_app';
end $$;
