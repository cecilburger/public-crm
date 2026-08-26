-- One draft per inbound message.
--
-- Every other background job was already safe to run twice; this one was not.
-- A retried `autopilot.draft` — after a dispatch failure, a worker restart, a
-- duplicate enqueue — would call the model again and bill the tenant for a
-- second AI reply. Retries are supposed to be free.
--
-- Drafts raised without an originating message (a manual nudge, a seed) are not
-- covered, which is why the index is partial.
create unique index if not exists drafts_one_per_message
  on message_drafts (tenant_id, in_reply_to) where in_reply_to is not null;
