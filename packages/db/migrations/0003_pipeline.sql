create table if not exists pipelines (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists pipeline_stages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  name        text not null,
  position    integer not null,
  probability numeric(4,3) not null default 0.5 check (probability between 0 and 1),
  -- What advances a deal into this stage without anyone dragging a card:
  -- {"event":"payment.succeeded"} or {"event":"quotation.opened"}.
  auto_advance_on jsonb,
  is_won      boolean not null default false,
  is_lost     boolean not null default false
);
create unique index if not exists pipeline_stages_pos on pipeline_stages (tenant_id, pipeline_id, position);

create table if not exists deals (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  contact_id           uuid not null references contacts(id) on delete cascade,
  pipeline_id          uuid not null references pipelines(id) on delete restrict,
  stage_id             uuid not null references pipeline_stages(id) on delete restrict,
  title                text not null,
  -- Money as integer micros of IDR. No floats anywhere near a deal value.
  amount_micros        bigint not null default 0,
  currency             char(3) not null default 'IDR',
  owner_id             uuid references users(id) on delete set null,
  status               text not null default 'open' check (status in ('open','won','lost')),
  lost_reason          text,
  source_conversation_id uuid references conversations(id) on delete set null,
  expected_close_on    date,
  -- Set forward on every touch; a deal past this is rotting and gets surfaced.
  rots_at              timestamptz,
  closed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists deals_board_idx on deals (tenant_id, pipeline_id, stage_id) where status = 'open';
create index if not exists deals_rot_idx on deals (tenant_id, rots_at) where status = 'open';
