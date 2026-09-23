-- The idempotency barrier for the BD chatbot's own auto-booked meetings.
--
-- Confirmed live: `bd.draft`'s job could run past BullMQ's lock before
-- lockDuration was raised (see apps/worker/src/main.ts), so the same
-- already-booked meeting got handed to `createTask` twice from two workers
-- running the same job concurrently. Both writes carried the exact same
-- `conversation_id`, `meeting_link` (Google's own Meet URL for the one real
-- event that got booked) and `due_at` — two rows, one meeting.
--
-- Narrower than "one meeting task per conversation": a conversation can be
-- rebooked into a different slot later, or hold a genuinely recurring
-- meeting task whose next occurrence reuses the same `meeting_link` at a
-- new `due_at` (packages/db/src/tasks.ts's own repeat-on-completion path
-- does exactly that) — both are legitimate second rows the index must not
-- block. Only the exact triple repeating is the bug.
--
-- The lock-duration fix is what stops the double run; this is what stops a
-- double run — from this cause, or any future one — from ever landing as
-- two rows.
create unique index if not exists tasks_meeting_booking_key
  on tasks (tenant_id, conversation_id, meeting_link, due_at)
  where kind = 'meeting' and conversation_id is not null and meeting_link is not null;
