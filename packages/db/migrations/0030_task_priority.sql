-- A follow-up's urgency, separate from whether it's overdue — a closed enum
-- like `kind` started as, since there's no "add your own priority" request
-- for this one.
alter table tasks
  add column if not exists priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent'));
