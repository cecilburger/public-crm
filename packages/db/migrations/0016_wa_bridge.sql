-- WhatsApp Web bridge: an unofficial channel (whatsapp-web.js + Puppeteer,
-- QR-paired) alongside the official Meta channel. It reuses `channels`,
-- `conversations` and `messages` as-is — the ingest and outbox paths do not
-- know or care which provider a message came from — and adds only what is
-- specific to holding a live browser session: pairing state and the QR code
-- while it waits to be scanned.

do $$
declare
  con text;
begin
  select conname into con
    from pg_constraint
   where conrelid = 'channels'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%kind%';
  if con is not null then
    execute format('alter table channels drop constraint %I', con);
  end if;
end $$;

alter table channels add constraint channels_kind_check
  check (kind in ('whatsapp','instagram','messenger','tiktok','telegram','tokopedia',
                   'shopee','email','webchat','whatsapp_web'));

create table if not exists wa_bridge_sessions (
  channel_id    uuid primary key references channels(id) on delete cascade,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  status        text not null default 'starting'
                 check (status in ('starting','qr_pending','authenticated','ready','disconnected','logged_out','error')),
  -- A data: URL, not the raw QR string — the console renders it directly with
  -- no QR-drawing code of its own. Refreshed every time whatsapp-web.js
  -- rotates the code, roughly every 20-45 seconds until scanned.
  qr_data       text,
  qr_expires_at timestamptz,
  phone_e164    text,
  last_seen_at  timestamptz,
  last_error    text,
  updated_at    timestamptz not null default now()
);
create index if not exists wa_bridge_sessions_tenant_idx on wa_bridge_sessions (tenant_id);

alter table wa_bridge_sessions enable row level security;
alter table wa_bridge_sessions force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'wa_bridge_sessions' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on wa_bridge_sessions
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert, update, delete on wa_bridge_sessions to kirana_app;
