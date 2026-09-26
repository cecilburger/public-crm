-- A Facebook comment that answers another one keeps the id of the comment it
-- answers.
--
-- The live Page renders a reply's own permalink as
-- `comment_id=<parent>&reply_comment_id=<reply>`, and the bridge now reads both.
-- Nullable: a top-level comment has no parent, and every row written before
-- this migration stays exactly as it was. Covered by the table's existing
-- tenant and division policies and grants — a column adds no new access.
alter table facebook_comments add column if not exists parent_comment_id text;
