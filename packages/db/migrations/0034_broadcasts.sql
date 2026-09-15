-- Broadcast: one approved WhatsApp template sent to a tag-filtered segment.
-- No status column here on purpose — sent/failed/pending is always computed
-- from `messages.status` via `broadcast_recipients.message_id`, so there is
-- nothing to keep in sync and nothing that can go stale.
create table if not exists broadcasts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  name         text not null,
  template_id  uuid not null references message_templates(id) on delete restrict,
  channel_id   uuid not null references channels(id) on delete restrict,
  tags         text[] not null default '{}',
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists broadcasts_tenant_idx on broadcasts (tenant_id, created_at desc);

-- One row per contact the segment matched, whether or not they were actually
-- sent to — `skipped_reason` set means `message_id` stays null, so the detail
-- view can show an honest "X dilewati" instead of only ever showing successes.
create table if not exists broadcast_recipients (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  broadcast_id    uuid not null references broadcasts(id) on delete cascade,
  contact_id      uuid not null references contacts(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  message_id      uuid references messages(id) on delete set null,
  skipped_reason  text check (skipped_reason in ('no_consent', 'no_conversation')),
  created_at      timestamptz not null default now()
);
create index if not exists broadcast_recipients_broadcast_idx on broadcast_recipients (tenant_id, broadcast_id);

do $$
begin
  execute 'alter table broadcasts enable row level security';
  execute 'alter table broadcasts force row level security';
  if not exists (select 1 from pg_policies where tablename = 'broadcasts' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on broadcasts using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on broadcasts to kirana_app';

  execute 'alter table broadcast_recipients enable row level security';
  execute 'alter table broadcast_recipients force row level security';
  if not exists (select 1 from pg_policies where tablename = 'broadcast_recipients' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on broadcast_recipients using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on broadcast_recipients to kirana_app';
end $$;
