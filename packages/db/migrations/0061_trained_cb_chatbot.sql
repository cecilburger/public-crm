-- The trained-cb DM chatbot as a conversation-level layer: an on/off switch
-- per division, an opt-in per connected account, who is handling each
-- conversation (the bot, a human, or nobody yet because the bot handed it
-- over), and one run row per inbound message so a redelivered job never
-- answers twice and two messages on one thread never race each other.
--
-- Backfills preserve today's behaviour: Marketing keeps the bot it already
-- had on its WhatsApp Web and Instagram bridge accounts, Messenger and the
-- Meta Cloud channels stay off, AI starts off, and conversations the engine
-- had already handed over, or whose contact opted out, stop being the bot's. Historical
-- `sender_type` values are left exactly as they are; only new trained-cb
-- replies are written as `bot`.
--
-- As in 0059, the migrating role owns these tables and is subject to FORCE
-- ROW LEVEL SECURITY with no tenant set, so each backfill lifts it around
-- its own statement. The column backfills run only in the run that adds the
-- column, so re-running this file never undoes a switch someone flipped.

create table if not exists chatbot_settings (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  division_id uuid not null,
  enabled     boolean not null default false,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references users(id) on delete set null,
  primary key (tenant_id, division_id),
  foreign key (division_id, tenant_id) references divisions(id, tenant_id) on delete cascade
);

alter table chatbot_settings enable row level security;
alter table divisions no force row level security;
alter table chatbot_settings no force row level security;
insert into chatbot_settings (tenant_id, division_id, enabled)
  select d.tenant_id, d.id, d.key = 'marketing' from divisions d
  on conflict (tenant_id, division_id) do nothing;
alter table chatbot_settings force row level security;
alter table divisions force row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'chatbot_settings' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on chatbot_settings
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'chatbot_settings' and policyname = 'division_isolation') then
    create policy division_isolation on chatbot_settings as restrictive
      using (app_current_division() is null or division_id = app_current_division())
      with check (app_current_division() is null or division_id = app_current_division());
  end if;
end $$;
grant select, insert, update on chatbot_settings to kirana_app;

-- Per connected account. New channels start off; the accounts trained-cb
-- already answered on start on.
do $$
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'channels'::regclass and attname = 'chatbot_enabled' and not attisdropped
  ) then
    alter table channels add column chatbot_enabled boolean not null default false;
    alter table channels no force row level security;
    update channels set chatbot_enabled = true where kind in ('whatsapp_web', 'instagram_bridge');
    alter table channels force row level security;
  end if;
end $$;

-- Taken from the engine's own state, not from assignment: today's bot
-- answers assigned threads too.
--
-- The engine never wrote `stopped_reason = 'opt_out'` itself: an opt-out left
-- the thread at `stopped` with no reason, and the old worker stored the
-- acknowledgement it sent under its template key. That key is what marks
-- those threads as opted out here, so the bot never writes to them again.
do $$
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'conversations'::regclass and attname = 'handling' and not attisdropped
  ) then
    alter table conversations add column handling text not null default 'bot'
      check (handling in ('bot', 'human', 'needs_human'));
    alter table conversations no force row level security;
    alter table bd_conversation_state no force row level security;
    alter table messages no force row level security;
    update bd_conversation_state s
       set stopped_reason = 'opt_out'
     where s.node = 'stopped' and s.stopped_reason = ''
       and exists (
         select 1 from messages m
          where m.conversation_id = s.conversation_id and m.tenant_id = s.tenant_id
            and m.direction = 'outbound' and m.template_name = 'REPLY_OPT_OUT');
    alter table messages force row level security;
    update conversations c
       set handling = case when s.node in ('handover', 'meeting_done') then 'needs_human' else 'human' end
      from bd_conversation_state s
     where s.conversation_id = c.id
       and (s.node in ('handover', 'meeting_done') or (s.node = 'stopped' and s.stopped_reason = 'opt_out'));
    alter table bd_conversation_state force row level security;
    alter table conversations force row level security;
  end if;
end $$;

create index if not exists conversations_handling_idx
  on conversations (tenant_id, division_id, last_message_at desc) where handling <> 'bot';

-- One row per inbound message the bot was asked to answer. The unique key is
-- the idempotency guard; the partial unique index is the per-conversation
-- lease — at most one run in flight per thread.
create table if not exists chatbot_runs (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  conversation_id      uuid not null references conversations(id) on delete cascade,
  inbound_message_id   uuid not null references messages(id) on delete cascade,
  status               text not null default 'running'
                        check (status in ('running', 'replied', 'skipped', 'handover', 'failed')),
  skip_reason          text,
  error                text,
  intent               text,
  escalation_reason    text,
  actions              jsonb not null default '[]',
  reply_message_ids    uuid[] not null default '{}',
  booking_attempted_at timestamptz,
  attempts             integer not null default 0,
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  unique (tenant_id, inbound_message_id)
);

create unique index if not exists chatbot_runs_running_lease
  on chatbot_runs (conversation_id) where status = 'running';
create index if not exists chatbot_runs_conversation_idx
  on chatbot_runs (tenant_id, conversation_id, started_at desc);

alter table chatbot_runs enable row level security;
alter table chatbot_runs force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'chatbot_runs' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on chatbot_runs
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
  -- Follows its conversation, like the tables in 0060.
  if not exists (select 1 from pg_policies where tablename = 'chatbot_runs' and policyname = 'division_isolation') then
    create policy division_isolation on chatbot_runs as restrictive
      using (app_current_division() is null or exists (
        select 1 from conversations p where p.id = chatbot_runs.conversation_id and p.division_id = app_current_division()))
      with check (app_current_division() is null or exists (
        select 1 from conversations p where p.id = chatbot_runs.conversation_id and p.division_id = app_current_division()));
  end if;
end $$;
grant select, insert, update on chatbot_runs to kirana_app;

-- `bot` is trained-cb; `autopilot` stays the legacy Autopilot.
do $$
declare
  con text;
begin
  select conname into con
    from pg_constraint
   where conrelid = 'messages'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%sender_type%';
  if con is not null then
    execute format('alter table messages drop constraint %I', con);
  end if;
end $$;

alter table messages add constraint messages_sender_type_check
  check (sender_type in ('contact', 'agent', 'autopilot', 'system', 'bot'));
