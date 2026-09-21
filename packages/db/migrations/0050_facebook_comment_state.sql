-- Processing state for a Facebook comment.
--
-- A comment is no longer only a record of something a customer said; it is work
-- that may be answered publicly and then followed by a private message. Both of
-- those are side effects on someone else's timeline and inbox, so "did we
-- already do this?" has to be a fact in the database rather than something
-- inferred from whatever the Facebook UI happens to render on the next sweep.
--
-- WHY THE STATE LIVES ON THE COMMENT AND NOT IN A QUEUE: the comment row is
-- already unique per `(tenant_id, comment_id)`, which is the same key the
-- watcher rediscovers the comment under on every reconciliation pass. Hanging
-- the state off that row means a re-read cannot start the work twice, no matter
-- how many times the bridge restarts or the sweep re-runs.
--
-- THE TWO STEPS FAIL INDEPENDENTLY, so they are recorded independently. A public
-- reply that succeeded must not be undone or hidden because the private message
-- afterwards could not be sent — Facebook only offers a private reply to a
-- commenter within a limited window and usually once per comment, so "no private
-- message available" is an ordinary outcome, not an error to retry into.

alter table facebook_comments add column if not exists status text not null default 'new';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'facebook_comments'::regclass and conname = 'facebook_comments_status_check'
  ) then
    alter table facebook_comments add constraint facebook_comments_status_check
      check (status in ('new','public_reply_pending','public_replied','dm_pending','dm_sent','failed'));
  end if;
end $$;

-- When each step actually landed. Null means "not done", and for the DM that is
-- the normal resting state while the feature flag is off.
alter table facebook_comments add column if not exists public_reply_at timestamptz;
alter table facebook_comments add column if not exists dm_at timestamptz;

-- Why a step did not land, in words an agent can read. Kept separately per step
-- so a failed DM never overwrites the record of a public reply that worked.
alter table facebook_comments add column if not exists public_reply_error text;
alter table facebook_comments add column if not exists dm_error text;

-- How many times processing has been attempted, and when it was last tried.
-- `attempts` is what stops a permanently-failing comment from being retried
-- forever; `last_attempt_at` is what the cooldown between automated replies is
-- measured from, so pacing survives a restart instead of resetting to zero.
alter table facebook_comments add column if not exists attempts integer not null default 0;
alter table facebook_comments add column if not exists last_attempt_at timestamptz;

-- The claim query: oldest unfinished comments for a tenant. Partial, because
-- everything already finished is dead weight in an index whose only job is to
-- find work.
create index if not exists facebook_comments_pending_idx
  on facebook_comments (tenant_id, commented_at)
  where status in ('new','public_reply_pending','public_replied','dm_pending');
