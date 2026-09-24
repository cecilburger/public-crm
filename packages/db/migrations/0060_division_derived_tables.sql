-- The division boundary on the tables that have no division of their own.
--
-- 0059 gave a `division_id` to every root entity and to `messages`, and left
-- the rows that hang off them — drafts, the outbox, timeline entries, order
-- lines, payment links, broadcast recipients, BD conversation state — to be
-- reached only through their parent. A review found the hole in that: a
-- route that reads or writes such a row by id without first loading the
-- parent (discarding an Autopilot draft did exactly that) crossed divisions
-- unopposed, because only the tenant policy stood in the way.
--
-- So each gets a RESTRICTIVE policy that follows its parent: the row is
-- visible and writable only while its parent is, in the session's division.
-- Unset division still means tenant-wide, as everywhere else, so the worker,
-- the checkout page and the key-rotation walker are unaffected.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('message_drafts',        'conversation_id', 'conversations'),
      ('message_outbox',        'message_id',      'messages'),
      ('timeline_events',       'contact_id',      'contacts'),
      ('order_items',           'order_id',        'orders'),
      ('payment_links',         'order_id',        'orders'),
      ('broadcast_recipients',  'broadcast_id',    'broadcasts'),
      ('bd_conversation_state', 'conversation_id', 'conversations')
    ) as v(child, col, parent)
  loop
    if not exists (
      select 1 from pg_policies where tablename = spec.child and policyname = 'division_isolation'
    ) then
      execute format(
        'create policy division_isolation on %I as restrictive
           using (app_current_division() is null or exists (
             select 1 from %I p where p.id = %I.%I and p.division_id = app_current_division()))
           with check (app_current_division() is null or exists (
             select 1 from %I p where p.id = %I.%I and p.division_id = app_current_division()))',
        spec.child, spec.parent, spec.child, spec.col, spec.parent, spec.child, spec.col);
    end if;
  end loop;
end $$;
