-- A record of what we sent, and to whom.
--
-- Support's first question about any billing dispute is "did they actually get
-- the invoice?", and the honest answer needs a row rather than a shrug. The
-- unique index is also what makes sending idempotent: a retried job finds the
-- template already sent for that reference and stops.
create table if not exists emails (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  template   text not null,
  recipient  text not null,
  subject    text not null,
  -- What it is about: an invoice id, a user id.
  reference  text,
  status     text not null default 'sent' check (status in ('sent','failed')),
  message_id text,
  error      text,
  sent_at    timestamptz not null default now()
);
create unique index if not exists emails_once_key on emails (tenant_id, template, reference)
  where reference is not null and status = 'sent';
create index if not exists emails_recent_idx on emails (tenant_id, sent_at desc);

alter table emails enable row level security;
alter table emails force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'emails' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on emails
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
-- Unlike the audit log, this is an operational record rather than evidence:
-- the row is claimed before sending and then updated with the message id, or
-- marked failed so the next run may retry.
grant select, insert, update on emails to kirana_app;
