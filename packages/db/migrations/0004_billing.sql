create table if not exists subscriptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  plan_code     text not null check (plan_code in ('starter','growth','scale','custom')),
  interval      text not null default 'monthly' check (interval in ('monthly','annual')),
  extra_numbers integer not null default 0 check (extra_numbers >= 0),
  extra_seats   integer not null default 0 check (extra_seats >= 0),
  ai_packs      integer not null default 0 check (ai_packs >= 0),
  addons        text[] not null default '{}',
  -- Contract price for `custom`; null means read the catalogue.
  contract_price_idr bigint,
  anchor_at     timestamptz not null default now(),
  status        text not null default 'active' check (status in ('trialing','active','past_due','cancelled')),
  created_at    timestamptz not null default now()
);
create unique index if not exists subscriptions_one_active on subscriptions (tenant_id) where status <> 'cancelled';

create table if not exists billing_periods (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  plan_code  text not null,
  status     text not null default 'open' check (status in ('open','closed','invoiced')),
  closed_at  timestamptz
);
create unique index if not exists billing_periods_range on billing_periods (tenant_id, starts_at);
create index if not exists billing_periods_open on billing_periods (tenant_id, status) where status = 'open';

-- The billable unit: one contact, one rolling 24-hour window, counted once.
create table if not exists billable_conversations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  contact_id        uuid not null references contacts(id) on delete cascade,
  channel_id        uuid not null references channels(id) on delete restrict,
  billing_period_id uuid not null references billing_periods(id) on delete restrict,
  opened_at         timestamptz not null default now(),
  expires_at        timestamptz not null,
  opened_by_message_id uuid references messages(id) on delete set null
);
-- One open window per contact. Enforced by an advisory lock in the writer and
-- by this index for the common case; see packages/db/src/metering.ts.
create index if not exists billable_open_idx on billable_conversations (tenant_id, contact_id, expires_at desc);
create index if not exists billable_period_idx on billable_conversations (tenant_id, billing_period_id);

create table if not exists usage_counters (
  tenant_id         uuid not null references tenants(id) on delete cascade,
  billing_period_id uuid not null references billing_periods(id) on delete cascade,
  metric            text not null check (metric in ('conversations','ai_replies','messages_out','meta_cost_micros','broadcasts')),
  value             bigint not null default 0,
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, billing_period_id, metric)
);

-- Meta's own conversation fee, recorded per conversation so an invoice line can
-- be audited against Meta's billing export. Passed through at cost.
create table if not exists meta_cost_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  channel_id        uuid not null references channels(id) on delete restrict,
  provider_conversation_id text not null,
  category          text not null check (category in ('service','utility','marketing','authentication')),
  cost_micros       bigint not null default 0,
  billing_period_id uuid references billing_periods(id) on delete set null,
  occurred_at       timestamptz not null default now()
);
create unique index if not exists meta_cost_dedupe on meta_cost_events (tenant_id, provider_conversation_id, category);
