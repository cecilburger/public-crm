-- What a Facebook post IS, for a person reading the inbox: its caption and
-- its age. Until now a comment group could only be named by the post's
-- `pfbid…` slug, which identifies the post and tells an agent nothing.
--
-- One row per post, looked up by `post_id` — the slug stays the identity that
-- comments are filed and grouped under; this table only describes it. Rows are
-- written by the bridge from the Page timeline it already re-reads every
-- minute (`/v1/webhooks/fb-bridge/posts`), independently of any comment, so
-- the order in which a post and its first comment arrive does not matter.
--
-- `post_text` is the Page's OWN published caption, not something a customer
-- wrote, so it is stored in the clear like `facebook_comments.page_name`; the
-- commenters' words stay sealed in `facebook_comments`.
--
-- `post_created_at` is only ever derived from Facebook's relative age ("2 days
-- ago" — the markup carries no absolute date), and such a reading can only get
-- coarser as the post ages, landing at or after the true time. The earliest
-- reading is therefore the most precise one, and the writer keeps it.
--
-- No thumbnail: the image URLs Facebook serves are signed and expire within
-- days, so a stored one would soon be a broken link.
--
-- Division-scoped exactly like `facebook_comments` (0059): each division reads
-- its own Page's posts, and the restrictive policy keeps them apart.
create table if not exists facebook_posts (
  tenant_id       uuid not null references tenants(id) on delete cascade,
  division_id     uuid not null default app_default_division(),
  page_id         text not null,
  post_id         text not null,
  post_text       text,
  post_created_at timestamptz,
  primary key (tenant_id, division_id, post_id),
  constraint facebook_posts_division_fk foreign key (division_id, tenant_id)
    references divisions(id, tenant_id) on delete cascade
);

alter table facebook_posts enable row level security;
alter table facebook_posts force row level security;
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'facebook_posts' and policyname = 'tenant_isolation') then
    create policy tenant_isolation on facebook_posts
      using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'facebook_posts' and policyname = 'division_isolation') then
    create policy division_isolation on facebook_posts as restrictive
      using (app_current_division() is null or division_id = app_current_division())
      with check (app_current_division() is null or division_id = app_current_division());
  end if;
end $$;
grant select, insert, update, delete on facebook_posts to kirana_app;
