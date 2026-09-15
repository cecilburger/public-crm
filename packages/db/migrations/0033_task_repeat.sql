-- Recurring follow-ups — `repeat_unit is null` (the default) means "does not
-- repeat", so every existing task is unaffected. Marking a repeating task
-- done spawns the next occurrence (see setTaskStatus in packages/db/src/tasks.ts);
-- there's no scheduled job checking for overdue ones on its own.
alter table tasks
  add column if not exists repeat_unit text check (repeat_unit in ('day', 'week', 'month', 'year')),
  add column if not exists repeat_interval integer not null default 1 check (repeat_interval > 0),
  add column if not exists repeat_until timestamptz;
