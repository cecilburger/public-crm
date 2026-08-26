-- Roles. The application never connects as an owner or superuser: `kirana_app`
-- is subject to row-level security, `kirana_ingest` may only spool raw webhooks,
-- and neither can read the other's tables.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kirana_app') then
    create role kirana_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'kirana_ingest') then
    create role kirana_ingest nologin;
  end if;
  -- Control plane. Its only privilege over `kirana_app` is the right to create a
  -- tenant row; everything after that runs inside the new tenant's own context.
  if not exists (select 1 from pg_roles where rolname = 'kirana_provisioner') then
    create role kirana_provisioner nologin;
  end if;
end $$;

-- Tenant context, set per transaction with set_config('app.tenant_id', …, true).
-- Unset means NULL means no rows: isolation fails closed.
create or replace function app_current_tenant() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create table if not exists tenants (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  name           text not null,
  status         text not null default 'active' check (status in ('trial','active','past_due','suspended','closed')),
  data_region    text not null default 'id-jkt',
  -- UU PDP art. 43: personal data is kept only as long as it is needed.
  retention_days integer not null default 730 check (retention_days between 30 and 3650),
  billing_email  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Wrapped data keys. The KEK that unwraps these lives in KMS/env, never here,
-- so a stolen database dump is ciphertext.
create table if not exists tenant_keys (
  tenant_id         uuid primary key references tenants(id) on delete cascade,
  wrapped_dek       text not null,
  wrapped_index_key text not null,
  key_version       integer not null default 1,
  created_at        timestamptz not null default now(),
  rotated_at        timestamptz
);

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  email         text not null,
  name          text not null,
  password_hash text,
  role          text not null default 'agent' check (role in ('owner','admin','supervisor','agent','viewer')),
  status        text not null default 'active' check (status in ('invited','active','disabled')),
  mfa_secret_enc text,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists users_tenant_email_key on users (tenant_id, lower(email));

-- Rotating refresh tokens. Only the hash is stored; reuse of a rotated token
-- revokes the whole family, which is how a stolen token gets caught.
create table if not exists refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  family_id   uuid not null,
  token_hash  text not null unique,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  revoke_reason text,
  replaced_by uuid references refresh_tokens(id),
  ip          inet,
  user_agent  text
);
create index if not exists refresh_tokens_user_idx on refresh_tokens (tenant_id, user_id, expires_at);

create table if not exists api_keys (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null,
  prefix       text not null unique,
  secret_hash  text not null,
  scopes       text[] not null default '{}',
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
