-- A daily send cap per wa-bridge number, plus a read-only breakdown of how
-- this number's chats are currently classified along the outreach funnel
-- shown on the channel settings page. The breakdown counters are maintained
-- by whatever labels a chat (agent action or bot), not derived from
-- `conversations` — the funnel stages here (meeting/minat/balas/belum/tolak/bot)
-- don't correspond to any column that already exists.
alter table wa_bridge_sessions
  add column if not exists max_per_day  integer not null default 150 check (max_per_day >= 0),
  add column if not exists chat_meeting integer not null default 0 check (chat_meeting >= 0),
  add column if not exists chat_minat   integer not null default 0 check (chat_minat >= 0),
  add column if not exists chat_balas   integer not null default 0 check (chat_balas >= 0),
  add column if not exists chat_belum   integer not null default 0 check (chat_belum >= 0),
  add column if not exists chat_tolak   integer not null default 0 check (chat_tolak >= 0),
  add column if not exists chat_bot     integer not null default 0 check (chat_bot >= 0);
