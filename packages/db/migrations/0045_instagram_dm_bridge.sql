-- Instagram DMs driven by `apps/ig-bridge` (Playwright, the same real
-- instagram.com UI a person would use) rather than the official Graph API.
-- It reuses channels/contacts/conversations/messages exactly like every
-- other provider, but needs its own identity column: scraping never sees an
-- IGSID (that's a Meta Graph API concept), only the other party's @username,
-- so contacts get a third identity dimension alongside phone and ig_psid.

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
  check (kind in ('whatsapp','instagram','instagram_bridge','messenger','tiktok','telegram',
                   'tokopedia','shopee','email','webchat','whatsapp_web'));

alter table contacts add column if not exists ig_username_enc text;
alter table contacts add column if not exists ig_username_bidx text;
create unique index if not exists contacts_tenant_ig_username_key
  on contacts (tenant_id, ig_username_bidx) where ig_username_bidx is not null;

-- Instagram's own internal thread id (the `/direct/t/<id>/` segment) — the
-- only thing that lets a send action jump straight to the right DM thread
-- instead of searching for the contact by username every time. Sealed like
-- any other provider identifier tied to a specific contact.
alter table contacts add column if not exists ig_thread_id_enc text;
