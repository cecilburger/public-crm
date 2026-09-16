-- Template Pesan is no longer WhatsApp-only — a channel a tenant can pick
-- per template, so an Email or other-channel template doesn't have to
-- pretend to be a WhatsApp one. Existing rows are all WhatsApp templates
-- (that was the only kind this table ever held), so the default backfills
-- them correctly with no further migration step needed.
alter table message_templates
  add column if not exists channel text not null default 'whatsapp'
    check (channel in ('whatsapp', 'email', 'other'));
