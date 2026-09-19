-- Links a meeting task to the Google Calendar event created for it (on the
-- assignee's own connected account — see `google_calendar_connections`).
-- Nullable: most tasks are not meetings, and even a meeting task may have
-- nothing here yet if nobody had Google Calendar connected when it was
-- created, or the write failed — that's a display/notice concern, not a
-- constraint this column should enforce.
alter table tasks add column if not exists calendar_event_id text;
alter table tasks add column if not exists calendar_event_link text;
