-- BD flow state — the per-conversation memory of `trained-cb`'s state machine,
-- moved here so the console can show it and an operator can steer it.
--
-- WHY A SIDE TABLE AND NOT COLUMNS ON `conversations`: only BD conversations
-- have a node, a price stage or a gadget loop. A commerce conversation served
-- by Autopilot would carry fourteen null columns forever, and the check
-- constraints below could not be written at all.
--
-- WHAT IS DELIBERATELY NOT HERE: name, brand and category. The brain needs
-- them to render a message, but they already live on `brands`/`contacts`
-- under this schema's encryption, and a second copy would be a second thing
-- to erase when a brand exercises its UU PDP right. They are joined in at
-- call time instead.
--
-- `email` is the one personal field the flow itself captures (the Calendar
-- invite goes to it), so it is sealed like every other personal field rather
-- than stored in the clear for the convenience of a state machine.

-- `id` is here for the key-rotation walker, which pages every encrypted table
-- by `id` and cannot see a table keyed on anything else. `conversation_id`
-- stays unique, so it is still one row per conversation and the upsert below
-- still conflicts on it.
create table if not exists bd_conversation_state (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  conversation_id  uuid not null unique references conversations(id) on delete cascade,

  node             text not null default 'new'
                    check (node in ('new','blasted','inbound_qualify','cold_fu1','cold_fu2',
                                    'cold_fu3','cold_fu4','qna','offer_meeting','warm_d2',
                                    'warm_d5','menunda_h1','menunda_h3','scheduling','scheduled',
                                    'noshow_fu1','noshow_fu2','meeting_done','stopped','handover')),
  outcome          text not null default 'followup'
                    check (outcome in ('acceptance','rejection','followup')),

  gadget_loops     integer not null default 0 check (gadget_loops >= 0),
  unknown_streak   integer not null default 0 check (unknown_streak >= 0),
  price_stage      integer not null default 0 check (price_stage between 0 and 2),

  email_enc        text,
  meet_link        text not null default '',
  stopped_reason   text not null default '',

  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  meeting_at       timestamptz,

  updated_at       timestamptz not null default now()
);

create index if not exists bd_conversation_state_tenant_node
  on bd_conversation_state (tenant_id, node);

alter table bd_conversation_state enable row level security;
alter table bd_conversation_state force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'bd_conversation_state' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on bd_conversation_state
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert, update, delete on bd_conversation_state to kirana_app;
