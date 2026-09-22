-- Which comment a comment answers, when it answers one.
--
-- Replies live in a thread under a comment, and Instagram serves them from a
-- separate endpoint — so until the reader learned to fetch them, a real
-- question asked inside a thread never reached the CRM at all.
--
-- It is recorded rather than inferred because it decides something: a thread
-- that already carries our one public line does not get another one. Without
-- this column the bot answers every reply in public, under a brand's post,
-- which turns one short reply into a visible back-and-forth.
alter table ig_comments add column if not exists parent_ref text;

-- "Everything in this thread", for a page that wants to show a reply under
-- the comment it answers rather than as a loose row.
create index if not exists ig_comments_parent
  on ig_comments (tenant_id, parent_ref) where parent_ref is not null;
