-- What kind of follow-up a task is. Meeting is the one kind that carries an
-- extra field — a video conference link — so it gets its own nullable column
-- rather than a generic key/value bag for one case.
alter table tasks
  add column if not exists kind text not null default 'follow_up'
    check (kind in ('follow_up', 'call', 'meeting', 'other')),
  add column if not exists meeting_link text;
