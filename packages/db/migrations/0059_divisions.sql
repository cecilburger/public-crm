-- Marketing / AI divisions: a second, nested boundary inside a tenant.
--
-- "Workspace" already means tenant in this codebase (the login slug, 0049),
-- so the new concept is a *division*. Every tenant has exactly two —
-- `marketing` and `ai` — and everything that existed before this migration
-- belongs to Marketing; AI starts empty. The two share users, billing,
-- security and configuration (catalogue, templates, pipeline stages) and are
-- isolated from each other on everything that hangs off a channel, a
-- contact or a brand: connections, conversations, messages, comments,
-- contacts, brands, deals, tasks, orders, broadcasts, calendar connections.
--
-- Isolation is enforced the same way tenant isolation is (0006): a session
-- setting, `app.division_id`, read by `app_current_division()`, and a policy
-- on every division-scoped table. The policy is RESTRICTIVE on purpose —
-- permissive policies are OR-ed together, so a permissive division policy
-- next to `tenant_isolation` would let the tenant policy alone admit every
-- division's rows. Restrictive policies are AND-ed with it instead.
--
-- Unset division means tenant-wide: background jobs (billing, retention,
-- rotation, comment sweeps) and the control plane never pick one, and they
-- must keep seeing the whole tenant. The API sets one on every request
-- (`asTenant` in apps/api), so a user-facing read or write is fail-closed to
-- the division the request carries. New rows written without a division set
-- default to Marketing through `app_default_division()` — the same rule as
-- the backfill below, so an unaware caller lands where the data already is
-- rather than nowhere.
--
-- The backfill runs as the migrating role, which owns the tables and is
-- therefore subject to FORCE ROW LEVEL SECURITY with no tenant set — it
-- would update zero rows and then fail `set not null`. Each table is
-- un-forced around its own backfill and re-forced straight after; a
-- superuser (PGlite in tests, the compose stack locally) bypasses RLS anyway
-- and is unaffected. Everything here is re-runnable, like every migration
-- before it, because the version row is recorded in a separate statement.

create table if not exists divisions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  key        text not null check (key in ('marketing','ai')),
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key),
  unique (id, tenant_id)
);

create or replace function app_current_division() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.division_id', true), '')::uuid $$;

-- Where a row lands when nothing chose a division: the request's division if
-- one is set, otherwise the tenant's Marketing division. Legal as a column
-- default because it is a function call, not a bare subquery.
create or replace function app_default_division() returns uuid
  language sql stable
  as $$
    select coalesce(
      app_current_division(),
      (select d.id from divisions d where d.tenant_id = app_current_tenant() and d.key = 'marketing'))
  $$;

-- The identity a browser-session bridge (fb-bridge, ig-bridge) files a
-- division's profile under. Marketing keeps the bare tenant id — that is what
-- every existing profile directory is already named, so nothing on disk has
-- to move and nobody logs in again — and any other division gets a suffix.
create or replace function app_bridge_session_key(division uuid) returns text
  language sql stable
  as $$
    select case when d.key = 'marketing' then d.tenant_id::text
                else d.tenant_id::text || '-' || d.key end
      from divisions d where d.id = division
  $$;

-- Every tenant gets its two divisions. Row-level security on `tenants` is
-- forced for the owner too, so it is lifted for exactly this statement.
alter table tenants no force row level security;
insert into divisions (tenant_id, key, name)
  select t.id, d.key, d.name
    from tenants t
   cross join (values ('marketing', 'Marketing'), ('ai', 'AI')) as d(key, name)
  on conflict (tenant_id, key) do nothing;
alter table tenants force row level security;

-- The scoped tables: add the column without a default first (a stable
-- default is evaluated once at ALTER time, with no tenant set), point every
-- existing row at Marketing, then lock it down.
do $$
declare
  t text;
  scoped text[] := array[
    'channels', 'contacts', 'conversations', 'messages',
    'brands', 'deals', 'tasks', 'orders', 'broadcasts',
    'facebook_comments', 'ig_comments',
    'fb_bridge_connections', 'ig_bridge_connections', 'ig_meta_connections',
    'google_calendar_connections'
  ];
begin
  foreach t in array scoped loop
    execute format('alter table %I add column if not exists division_id uuid', t);
    execute format('alter table %I no force row level security', t);
    execute format(
      'update %I x set division_id = d.id from divisions d
        where d.tenant_id = x.tenant_id and d.key = ''marketing'' and x.division_id is null', t);
    execute format('alter table %I force row level security', t);
    execute format('alter table %I alter column division_id set not null', t);
    execute format('alter table %I alter column division_id set default app_default_division()', t);
    if not exists (select 1 from pg_constraint where conname = t || '_division_fk') then
      execute format(
        'alter table %I add constraint %I foreign key (division_id, tenant_id)
           references divisions(id, tenant_id) on delete cascade',
        t, t || '_division_fk');
    end if;
  end loop;
end $$;

-- Bridge connections: one per division rather than one per tenant, each
-- with the profile identity the bridge process files it under.
do $$
declare
  t text;
begin
  foreach t in array array['fb_bridge_connections', 'ig_bridge_connections'] loop
    execute format('alter table %I add column if not exists session_key text', t);
    execute format('alter table %I no force row level security', t);
    execute format(
      'update %I set session_key = app_bridge_session_key(division_id) where session_key is null', t);
    execute format('alter table %I force row level security', t);
    execute format('alter table %I alter column session_key set not null', t);
    execute format('create unique index if not exists %I on %I (session_key)', t || '_session_key', t);
  end loop;
end $$;

-- Primary keys widened from "one per tenant" to "one per division".
do $$
declare
  t text;
begin
  foreach t in array array['fb_bridge_connections', 'ig_bridge_connections', 'ig_meta_connections'] loop
    if exists (
      select 1 from pg_constraint
       where conrelid = t::regclass and contype = 'p' and array_length(conkey, 1) = 1
    ) then
      execute format('alter table %I drop constraint %I', t, t || '_pkey');
      execute format('alter table %I add primary key (tenant_id, division_id)', t);
    end if;
  end loop;
end $$;

-- Calendar tokens: one per user *per division*, since the two divisions
-- book meetings on different calendars. The key-rotation walker pages by a
-- column unique within a tenant, which `user_id` no longer is — hence `id`.
alter table google_calendar_connections add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists google_calendar_connections_id_key on google_calendar_connections (id);
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'google_calendar_connections'::regclass and contype = 'p' and array_length(conkey, 1) = 2
  ) then
    alter table google_calendar_connections drop constraint google_calendar_connections_pkey;
    alter table google_calendar_connections add primary key (tenant_id, division_id, user_id);
  end if;
end $$;

-- Contact identity is per division: the same phone, Instagram handle or
-- Facebook user may be one contact in Marketing and a different one in AI.
-- The upserts in packages/db name these indexes' columns as their conflict
-- target, so the predicate must stay exactly this.
drop index if exists contacts_tenant_phone_key;
drop index if exists contacts_tenant_ig_psid_key;
drop index if exists contacts_tenant_ig_username_key;
drop index if exists contacts_tenant_fb_user_id_key;
create unique index if not exists contacts_division_phone_key
  on contacts (tenant_id, division_id, phone_bidx) where phone_bidx is not null;
create unique index if not exists contacts_division_ig_psid_key
  on contacts (tenant_id, division_id, ig_psid_bidx) where ig_psid_bidx is not null;
create unique index if not exists contacts_division_ig_username_key
  on contacts (tenant_id, division_id, ig_username_bidx) where ig_username_bidx is not null;
create unique index if not exists contacts_division_fb_user_id_key
  on contacts (tenant_id, division_id, fb_user_id_bidx) where fb_user_id_bidx is not null;

-- A row can never point at a parent in another division: composite foreign
-- keys carry the division alongside the id, which needs the pair to be
-- unique on each parent. Nullable pointers (a deal with no contact) are
-- simply not checked, as with any multi-column foreign key.
create unique index if not exists channels_id_division_key on channels (id, division_id);
create unique index if not exists contacts_id_division_key on contacts (id, division_id);
create unique index if not exists conversations_id_division_key on conversations (id, division_id);
create unique index if not exists brands_id_division_key on brands (id, division_id);
create unique index if not exists deals_id_division_key on deals (id, division_id);

do $$
declare
  fk record;
begin
  for fk in
    select * from (values
      ('conversations', 'channel_id',             'channels'),
      ('conversations', 'contact_id',             'contacts'),
      ('messages',      'conversation_id',        'conversations'),
      ('messages',      'channel_id',             'channels'),
      ('brands',        'contact_id',             'contacts'),
      ('deals',         'contact_id',             'contacts'),
      ('deals',         'brand_id',               'brands'),
      ('deals',         'source_conversation_id', 'conversations'),
      ('tasks',         'contact_id',             'contacts'),
      ('tasks',         'brand_id',               'brands'),
      ('tasks',         'conversation_id',        'conversations'),
      ('tasks',         'deal_id',                'deals'),
      ('orders',        'contact_id',             'contacts'),
      ('orders',        'conversation_id',        'conversations'),
      ('orders',        'deal_id',                'deals'),
      ('broadcasts',    'channel_id',             'channels'),
      ('ig_comments',   'conversation_id',        'conversations'),
      ('ig_comments',   'contact_id',             'contacts')
    ) as v(child, col, parent)
  loop
    if not exists (select 1 from pg_constraint where conname = fk.child || '_' || fk.col || '_division_fk') then
      execute format(
        'alter table %I add constraint %I foreign key (%I, division_id) references %I (id, division_id)',
        fk.child, fk.child || '_' || fk.col || '_division_fk', fk.col, fk.parent);
    end if;
  end loop;
end $$;

-- A child row belongs to its parent's division, whatever the writer's session
-- says. Rows that hang off a conversation, a channel, a contact, a brand or a
-- deal take that parent's division on insert, so code that never heard of
-- divisions — the Autopilot and BD chatbot processors, which run with only a
-- tenant set — still files an AI conversation's reply, task, deal or order
-- under AI instead of defaulting it to Marketing. Arguments are
-- (column, parent table) pairs, tried in order; the first parent set wins and
-- the composite foreign keys above check the rest agree. The parent is read
-- under the writer's own row-level security, so a parent in another division
-- than the session's is invisible here and the insert falls through to its
-- default — and then fails those foreign keys rather than crossing over.
create or replace function app_inherit_division() returns trigger
  language plpgsql
  as $$
declare
  i integer := 0;
  parent_id uuid;
  inherited uuid;
begin
  while i + 1 < tg_nargs loop
    execute format('select ($1).%I', tg_argv[i]) using new into parent_id;
    if parent_id is not null then
      execute format('select division_id from %I where id = $1', tg_argv[i + 1]) using parent_id into inherited;
      if inherited is not null then
        new.division_id := inherited;
        return new;
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end $$;

create or replace trigger conversations_inherit_division before insert on conversations
  for each row execute function app_inherit_division('channel_id', 'channels', 'contact_id', 'contacts');
create or replace trigger messages_inherit_division before insert on messages
  for each row execute function app_inherit_division('conversation_id', 'conversations', 'channel_id', 'channels');
create or replace trigger deals_inherit_division before insert on deals
  for each row execute function app_inherit_division(
    'source_conversation_id', 'conversations', 'contact_id', 'contacts', 'brand_id', 'brands');
create or replace trigger tasks_inherit_division before insert on tasks
  for each row execute function app_inherit_division(
    'conversation_id', 'conversations', 'deal_id', 'deals', 'contact_id', 'contacts', 'brand_id', 'brands');
create or replace trigger orders_inherit_division before insert on orders
  for each row execute function app_inherit_division(
    'conversation_id', 'conversations', 'contact_id', 'contacts', 'deal_id', 'deals');
create or replace trigger broadcasts_inherit_division before insert on broadcasts
  for each row execute function app_inherit_division('channel_id', 'channels');
create or replace trigger ig_comments_inherit_division before insert on ig_comments
  for each row execute function app_inherit_division('conversation_id', 'conversations', 'contact_id', 'contacts');
create or replace trigger brands_inherit_division before insert on brands
  for each row execute function app_inherit_division('contact_id', 'contacts');

-- The reads the console does on every page, now narrowed by division first.
create index if not exists conversations_division_inbox_idx
  on conversations (tenant_id, division_id, status, last_message_at desc);
create index if not exists contacts_division_seen_idx
  on contacts (tenant_id, division_id, last_seen_at desc);
create index if not exists channels_division_idx
  on channels (tenant_id, division_id, kind);
create index if not exists messages_division_recent_idx
  on messages (tenant_id, division_id, created_at);
create index if not exists tasks_division_due_idx
  on tasks (tenant_id, division_id, status, due_at);
create index if not exists deals_division_board_idx
  on deals (tenant_id, division_id, pipeline_id, stage_id) where status = 'open';
create index if not exists brands_division_idx
  on brands (tenant_id, division_id, created_at desc);
create index if not exists orders_division_idx
  on orders (tenant_id, division_id, created_at desc);
create index if not exists facebook_comments_division_pending_idx
  on facebook_comments (tenant_id, division_id, commented_at)
  where status in ('new', 'public_reply_pending', 'dm_pending');
create index if not exists ig_comments_division_pending_idx
  on ig_comments (tenant_id, division_id, public_status, commented_at desc);

-- Row-level security on the divisions table itself: a tenant sees only its
-- own two rows, and there is deliberately no division policy on it — the
-- switcher has to list both.
alter table divisions enable row level security;
alter table divisions force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'divisions' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on divisions
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
  -- Webhooks and the worker turn a bridge session key into a division before
  -- any tenant context exists — ids and keys only, no customer data.
  if not exists (select 1 from pg_policies where tablename = 'divisions' and policyname = 'control_plane_select') then
    create policy control_plane_select on divisions for select to kirana_provisioner using (true);
  end if;
end $$;
grant select, insert, update on divisions to kirana_app;
grant select on divisions to kirana_provisioner;

-- Same control-plane access on the Facebook connection table as 0050 gave the
-- Instagram one: resolving `session_key` and marking a dead session happen
-- before a tenant is known.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'fb_bridge_connections' and policyname = 'control_plane_select') then
    execute 'create policy control_plane_select on fb_bridge_connections for select to kirana_provisioner using (true)';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'fb_bridge_connections' and policyname = 'control_plane_update') then
    execute 'create policy control_plane_update on fb_bridge_connections for update to kirana_provisioner using (true) with check (true)';
  end if;
end $$;
grant select, update on fb_bridge_connections to kirana_provisioner;

-- The division boundary. Restrictive, so it narrows what `tenant_isolation`
-- admits rather than widening it; unset means tenant-wide (see the header).
do $$
declare
  t text;
  scoped text[] := array[
    'channels', 'contacts', 'conversations', 'messages',
    'brands', 'deals', 'tasks', 'orders', 'broadcasts',
    'facebook_comments', 'ig_comments',
    'fb_bridge_connections', 'ig_bridge_connections', 'ig_meta_connections',
    'google_calendar_connections'
  ];
begin
  foreach t in array scoped loop
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'division_isolation') then
      execute format(
        'create policy division_isolation on %I as restrictive
           using (app_current_division() is null or division_id = app_current_division())
           with check (app_current_division() is null or division_id = app_current_division())', t);
    end if;
  end loop;
end $$;

-- WhatsApp Web sessions carry no division of their own; they follow their
-- channel.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'wa_bridge_sessions' and policyname = 'division_isolation') then
    create policy division_isolation on wa_bridge_sessions as restrictive
      using (app_current_division() is null or exists (
        select 1 from channels c where c.id = wa_bridge_sessions.channel_id and c.division_id = app_current_division()))
      with check (app_current_division() is null or exists (
        select 1 from channels c where c.id = wa_bridge_sessions.channel_id and c.division_id = app_current_division()));
  end if;
end $$;
