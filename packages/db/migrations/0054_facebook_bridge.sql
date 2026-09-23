-- Facebook, driven by `apps/fb-bridge` (a real Chromium profile on the real
-- facebook.com UI) rather than Meta's Graph API — the same unofficial shape as
-- `apps/ig-bridge`, and deliberately its own `kind` for the same reason 0045
-- gave: an official Messenger connection may arrive later, and the two must be
-- able to exist side by side without colliding on `channels_provider_key`
-- (unique on `(kind, external_id)`, which would otherwise pair a scraped Page
-- with an API-connected one under the same key).
--
-- Inbound only, by design. Nothing here creates an outbound path: the bridge
-- cannot send, and `apps/worker`'s `outboundSend` has no `messenger_bridge`
-- branch, so a reply queued against this channel would fall through to the
-- Meta Graph path this whole feature exists to avoid.

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
  check (kind in ('whatsapp','instagram','instagram_bridge','messenger','messenger_bridge',
                   'tiktok','telegram','tokopedia','shopee','email','webchat','whatsapp_web'));

-- A fourth identity dimension alongside phone, ig_psid and ig_username. Unlike
-- Instagram's scraped side — where the only identity on offer is an @username —
-- a Messenger thread URL carries the other party's own numeric id
-- (`/messages/t/<id>`), which is stable across display-name changes and is what
-- this keys on. Its own column pair, never reusing `ig_psid_*`: the two are
-- different namespaces and a shared column would collide two real people onto
-- one contact row.
alter table contacts add column if not exists fb_user_id_enc text;
alter table contacts add column if not exists fb_user_id_bidx text;
create unique index if not exists contacts_tenant_fb_user_id_key
  on contacts (tenant_id, fb_user_id_bidx) where fb_user_id_bidx is not null;

-- The thread's own id, so a future reply path can open the right conversation
-- directly instead of searching for the person again. Same role as
-- `ig_thread_id_enc`; on a 1:1 Messenger thread it is usually equal to
-- `fb_user_id`, but that is a Facebook implementation detail and not something
-- to depend on, so it is stored separately.
alter table contacts add column if not exists fb_thread_id_enc text;

-- One row per tenant, like `ig_bridge_connections` — a single business Page,
-- not a list of numbers the way WhatsApp channels are.
--
-- NOTHING SENSITIVE IS STORED HERE. There is no password column and no cookie
-- column, because the operator logs in by hand in a real browser window; the
-- resulting session lives only as a Chromium profile on the bridge's own disk.
-- The Page id and name are the tenant's own business identity — the same thing
-- already sitting in `channels.display_name` in the clear — so unlike
-- `ig_bridge_connections.username_enc` (a personal handle) they need no
-- encryption, which also keeps this table out of the key-rotation walker.
create table if not exists fb_bridge_connections (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  page_id       text,
  page_name     text,
  status        text not null default 'disconnected'
                 check (status in ('disconnected','awaiting_login','ready','checkpoint_required','error')),
  last_error    text,
  last_seen_at  timestamptz,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references users(id) on delete set null
);

alter table fb_bridge_connections enable row level security;
alter table fb_bridge_connections force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'fb_bridge_connections' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on fb_bridge_connections
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert, update, delete on fb_bridge_connections to kirana_app;

-- WHY COMMENTS ARE THEIR OWN TABLE AND NOT `messages`:
--
--   1. `conversations` is unique on (tenant_id, contact_id, channel_id) where
--      status <> 'resolved'. That cannot express "one thread per (person,
--      post)" — the same person commenting on five different posts would
--      collapse into a single CRM thread.
--   2. `messages` has nowhere to put a post id or a permalink; only a free-form
--      `media` jsonb, which no index or query could reach.
--   3. Every message ingest calls `recordConversationActivity`, which opens a
--      *billable* conversation window. Ingesting comments as messages would
--      charge the tenant for each one.
--   4. Routing a comment to a DM later then becomes "promote this author into a
--      conversation" rather than a schema migration.
--
-- Inbound only and inert: nothing reads this to auto-reply, auto-DM, or hand
-- over to a chatbot.
--
-- `id` exists for the key-rotation walker, which pages every encrypted table by
-- `id` and cannot see a table keyed on anything else (same reason 0048 gives).
-- `comment_id` stays unique per tenant, so it is still one row per comment and
-- the ingest upsert still conflicts on it.
create table if not exists facebook_comments (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id) on delete cascade,
  -- Page/account context, kept on the row itself rather than joined through a
  -- channel: a comment is not a conversation and has no channel of its own.
  page_id                 text not null,
  page_name               text,
  post_id                 text not null,
  comment_id              text not null,
  -- The commenter is a third party, so every field identifying them is sealed.
  -- The blind index is what lets a future comment-to-DM step match this author
  -- against `contacts.fb_user_id_bidx` without decrypting every row first.
  author_external_id_enc  text,
  author_external_id_bidx text,
  author_name_enc         text,
  body_enc                text,
  commented_at            timestamptz,
  created_at              timestamptz not null default now()
);
-- The idempotency barrier: Facebook's own comment id, so re-reading a post the
-- watcher has already seen updates nothing rather than inserting a second copy.
create unique index if not exists facebook_comments_tenant_comment_key
  on facebook_comments (tenant_id, comment_id);
create index if not exists facebook_comments_recent_idx
  on facebook_comments (tenant_id, commented_at desc);
create index if not exists facebook_comments_author_idx
  on facebook_comments (tenant_id, author_external_id_bidx) where author_external_id_bidx is not null;

alter table facebook_comments enable row level security;
alter table facebook_comments force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'facebook_comments' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on facebook_comments
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert, update, delete on facebook_comments to kirana_app;
