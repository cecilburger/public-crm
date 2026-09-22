-- Comments left on our own Instagram posts.
--
-- WHY NOT A CONVERSATION: a comment is not a thread. It has no history, no
-- reply window, and — the part that decides the whole shape of this — the
-- BD team's own rule is that it must never be answered at length in public
-- (see trained-cb/README.md, "the inbound SOP it implements"): one short
-- line on the post, and the real answer in DM. Filing it as a conversation
-- would hand it to the flow, which would answer it the way it answers a DM.
--
-- So it lives here, and `conversation_id` is filled in only once the DM
-- actually lands — that is the moment the comment becomes a conversation
-- and stops being this table's problem.
--
-- The commenter's handle is public on the post, but it is still someone's
-- identity, so it is sealed like every other personal field rather than
-- kept in the clear for the convenience of a list page.
create table if not exists ig_comments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,

  platform       text not null default 'instagram' check (platform in ('instagram','facebook')),
  -- Whatever the source calls this comment and the post it sits under. The
  -- scraper and the Meta webhook name them differently; both are stored as
  -- given, and the pair is what makes a re-read idempotent.
  post_ref       text not null,
  comment_ref    text not null,

  commenter_enc  text not null,
  text_enc       text not null,

  -- Two steps, tracked separately on purpose: "we said something in public"
  -- and "we actually reached them privately" fail independently, and the
  -- second one legitimately fails a lot (Instagram will not let a business
  -- DM someone who never wrote to it first).
  public_status  text not null default 'pending'
                 check (public_status in ('pending','sent','failed','skipped')),
  dm_status      text not null default 'pending'
                 check (dm_status in ('pending','sent','failed','skipped')),

  public_reply_enc text,
  last_error     text,

  conversation_id uuid references conversations(id) on delete set null,
  contact_id      uuid references contacts(id) on delete set null,

  commented_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One row per comment per workspace. A re-read of the same post must update
-- what is already here, never add a second copy — the same guarantee the
-- message spool gets from `(provider, external_id)`.
create unique index if not exists ig_comments_ref
  on ig_comments (tenant_id, platform, comment_ref);
-- The list page opens on "what still needs a human", newest first.
create index if not exists ig_comments_pending
  on ig_comments (tenant_id, public_status, commented_at desc);

alter table ig_comments enable row level security;
alter table ig_comments force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'ig_comments' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on ig_comments
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
end $$;
grant select, insert, update, delete on ig_comments to kirana_app;
