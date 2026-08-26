-- What Autopilot is allowed to know.
--
-- Deliberately NOT encrypted, unlike contacts and messages: this is business
-- data, not personal data. It has to be searchable, and encrypting a product
-- catalogue buys no privacy while breaking the one thing it exists for.
create table if not exists knowledge_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null check (kind in ('product','faq','policy')),
  title       text not null,
  body        text not null default '',
  -- Products only. These are the numbers the guardrail checks a draft against,
  -- which is why they are columns and not prose inside `body`.
  sku         text,
  price_idr   bigint,
  stock       integer,
  tags        text[] not null default '{}',
  active      boolean not null default true,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists knowledge_tenant_idx on knowledge_items (tenant_id, kind) where active;
create unique index if not exists knowledge_sku_key on knowledge_items (tenant_id, sku) where sku is not null;

-- Per-tenant Autopilot policy. Every field here is a thing a shop owner would
-- reasonably want to decide for themselves.
create table if not exists autopilot_settings (
  tenant_id            uuid primary key references tenants(id) on delete cascade,
  mode                 text not null default 'suggest' check (mode in ('off','suggest','auto')),
  -- Below this, a human always sees it first. 0.75 is deliberately cautious.
  min_confidence       numeric(3,2) not null default 0.75 check (min_confidence between 0 and 1),
  may_offer_discount   boolean not null default false,
  may_promise_delivery boolean not null default false,
  persona              text not null default 'Ramah, sopan, ringkas. Pakai Bahasa Indonesia sehari-hari.',
  escalate_keywords    text[] not null default '{"komplain","tuntut","polisi","pengacara","refund","kecewa"}',
  max_reply_chars      integer not null default 700,
  -- A flood of inbound messages is a cost event, not just a busy inbox. Past
  -- this many generations in an hour the bot stops and people take over.
  max_replies_per_hour integer not null default 120 check (max_replies_per_hour between 0 and 10000),
  -- And a per-customer cap, so one person cannot spend the whole shop's hour.
  max_replies_per_contact_per_hour integer not null default 12
    check (max_replies_per_contact_per_hour between 0 and 1000),
  updated_at           timestamptz not null default now()
);

-- A draft is a proposal, never a sent message. It becomes a message only when a
-- human uses it, or when auto mode passes every guardrail.
create table if not exists message_drafts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  in_reply_to     uuid references messages(id) on delete set null,
  -- A draft is the same personal data as the message it may become, so it is
  -- sealed with the tenant's key exactly the same way.
  body_enc        text not null,
  confidence      numeric(3,2) not null default 0,
  intent          text,
  status          text not null default 'pending'
                  check (status in ('pending','used','edited','discarded','auto_sent','blocked')),
  -- Why it was held back, in words, so a supervisor can tune the policy.
  reasons         jsonb not null default '[]',
  model           text,
  usage           jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references users(id) on delete set null
);
create index if not exists drafts_pending_idx on message_drafts (tenant_id, conversation_id)
  where status = 'pending';

do $$
declare t text;
begin
  foreach t in array array['knowledge_items','autopilot_settings','message_drafts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'tenant_isolation') then
      execute format(
        'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    end if;
    execute format('grant select, insert, update, delete on %I to kirana_app', t);
  end loop;
end $$;
