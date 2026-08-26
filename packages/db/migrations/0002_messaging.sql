create table if not exists channels (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  kind          text not null check (kind in ('whatsapp','instagram','messenger','tiktok','telegram','tokopedia','shopee','email','webchat')),
  display_name  text not null,
  -- Provider identity: WhatsApp phone_number_id, IG page id, shop id…
  external_id   text,
  phone_e164    text,
  waba_id       text,
  credentials_enc text,
  status        text not null default 'connected' check (status in ('connecting','connected','error','disabled')),
  quality       text not null default 'green' check (quality in ('green','yellow','red','flagged')),
  created_at    timestamptz not null default now()
);
create unique index if not exists channels_provider_key on channels (kind, external_id) where external_id is not null;
create index if not exists channels_tenant_idx on channels (tenant_id, kind);

-- Personal data is encrypted; lookup happens through the per-tenant blind index.
create table if not exists contacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  display_name  text,
  phone_enc     text,
  phone_bidx    text,
  email_enc     text,
  email_bidx    text,
  tags          text[] not null default '{}',
  attributes    jsonb not null default '{}',
  -- UU PDP art. 20: lawful basis and consent, recorded with the data itself.
  consent       jsonb not null default '{"marketing":false,"source":null,"at":null}',
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists contacts_tenant_phone_key on contacts (tenant_id, phone_bidx) where phone_bidx is not null;
create index if not exists contacts_tenant_seen_idx on contacts (tenant_id, last_seen_at desc);

create table if not exists conversations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  contact_id       uuid not null references contacts(id) on delete cascade,
  channel_id       uuid not null references channels(id) on delete restrict,
  status           text not null default 'open' check (status in ('open','pending','snoozed','resolved')),
  priority         text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assignee_id      uuid references users(id) on delete set null,
  -- 'inherit' means "no opinion, use the workspace setting". A per-conversation
  -- value can only ever be *narrower* than the workspace one, never wider.
  autopilot_mode   text not null default 'inherit' check (autopilot_mode in ('inherit','off','suggest','auto')),
  last_inbound_at  timestamptz,
  last_message_at  timestamptz,
  first_response_at timestamptz,
  sla_due_at       timestamptz,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
-- At most one live thread per contact per channel. Makes the ingest path an
-- idempotent upsert instead of a check-then-insert race.
create unique index if not exists conversations_open_thread
  on conversations (tenant_id, contact_id, channel_id) where status <> 'resolved';
create index if not exists conversations_inbox_idx on conversations (tenant_id, status, last_message_at desc);
create index if not exists conversations_assignee_idx on conversations (tenant_id, assignee_id) where status <> 'resolved';
create index if not exists conversations_contact_idx on conversations (tenant_id, contact_id);

create table if not exists messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  conversation_id     uuid not null references conversations(id) on delete cascade,
  channel_id          uuid not null references channels(id) on delete restrict,
  direction           text not null check (direction in ('inbound','outbound')),
  sender_type         text not null check (sender_type in ('contact','agent','autopilot','system')),
  sender_id           uuid,
  body_enc            text,
  media               jsonb not null default '[]',
  template_name       text,
  provider_message_id text,
  status              text not null default 'received' check (status in ('received','queued','sent','delivered','read','failed')),
  error               jsonb,
  meta_category       text check (meta_category in ('service','utility','marketing','authentication')),
  provider_ts         timestamptz,
  created_at          timestamptz not null default now()
);
-- Providers retry; this is what makes ingestion idempotent.
create unique index if not exists messages_provider_key
  on messages (tenant_id, channel_id, provider_message_id) where provider_message_id is not null;
create index if not exists messages_conversation_idx on messages (tenant_id, conversation_id, created_at);

-- Transactional outbox: a reply is committed with the conversation update in one
-- transaction, then relayed. No "saved but never sent" and no "sent twice".
create table if not exists message_outbox (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  message_id    uuid not null references messages(id) on delete cascade,
  attempts      integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);
create index if not exists message_outbox_due_idx on message_outbox (next_attempt_at) where locked_until is null;

create table if not exists timeline_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  contact_id  uuid not null references contacts(id) on delete cascade,
  kind        text not null,
  payload     jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index if not exists timeline_contact_idx on timeline_events (tenant_id, contact_id, occurred_at desc);

-- Raw provider payloads. Deliberately outside tenant RLS and readable only by
-- the ingest role: the spool is evidence, and tenant sessions cannot reach it.
create table if not exists webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,
  external_id  text not null,
  signature_ok boolean not null,
  payload      jsonb not null,
  status       text not null default 'received' check (status in ('received','processed','failed','ignored')),
  error        text,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);
create unique index if not exists webhook_events_dedupe on webhook_events (provider, external_id);
