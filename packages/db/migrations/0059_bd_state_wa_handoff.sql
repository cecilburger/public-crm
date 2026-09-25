-- `wa_handoff` joins the BD flow's nodes.
--
-- The bot's 24 Sep 2026 training added the inbound funnel comment → DM →
-- WhatsApp → meeting: an Instagram/Facebook DM lead who shows interest is
-- given BD's WhatsApp number and parked at `wa_handoff` (bd_bot.models.Node,
-- apps/bd-brain). The check constraint from 0051 predates that node, so the
-- first DM hand-off the brain returned would have failed the state upsert in
-- apps/worker/src/processors/bdDraft.ts — the reply queued, the node not
-- saved, and the next DM answered as if nothing had been said.
--
-- Same drop-and-recreate shape as 0045's channels_kind_check: the constraint
-- was declared inline in 0051, so its name is whatever Postgres chose.
do $$
declare con text;
begin
  select conname into con from pg_constraint
   where conrelid = 'bd_conversation_state'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%node%';
  if con is not null then
    execute format('alter table bd_conversation_state drop constraint %I', con);
  end if;
end $$;

alter table bd_conversation_state add constraint bd_conversation_state_node_check
  check (node in ('new','blasted','inbound_qualify','cold_fu1','cold_fu2',
                  'cold_fu3','cold_fu4','qna','offer_meeting','warm_d2',
                  'warm_d5','menunda_h1','menunda_h3','scheduling','scheduled',
                  'noshow_fu1','noshow_fu2','wa_handoff','meeting_done','stopped','handover'));
