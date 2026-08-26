-- Append-only, hash-chained. `kirana_app` is granted insert and select and
-- nothing else, so the application literally cannot rewrite its own history.
create table if not exists audit_events (
  id            bigserial primary key,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  actor_type    text not null check (actor_type in ('user','api_key','system','support')),
  actor_id      uuid,
  action        text not null,
  resource_type text not null,
  resource_id   text,
  ip            inet,
  user_agent    text,
  meta          jsonb not null default '{}',
  prev_hash     text,
  hash          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists audit_tenant_idx on audit_events (tenant_id, created_at desc);
create index if not exists audit_resource_idx on audit_events (tenant_id, resource_type, resource_id);

-- UU PDP arts. 26–34: the data subject's rights, tracked as work items with a
-- clock on them rather than an email someone forgot to action.
create table if not exists dsr_requests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  contact_id   uuid references contacts(id) on delete set null,
  subject_ref  text,
  kind         text not null check (kind in ('access','export','erasure','rectification','objection')),
  status       text not null default 'received' check (status in ('received','verifying','in_progress','completed','rejected')),
  requested_by uuid references users(id),
  reason       text,
  -- Statutory clock. Breaching it is the finding an auditor writes down.
  due_at       timestamptz not null default (now() + interval '3 days'),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  artifact_uri text
);
create index if not exists dsr_due_idx on dsr_requests (tenant_id, status, due_at);
