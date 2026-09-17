-- Instagram DMs identify a person by an opaque Instagram-scoped ID (IGSID),
-- never a phone number — `contacts` needs a second identity column, blind-
-- indexed the same way phone/email already are, so a contact who only ever
-- messaged over Instagram still resolves to one row instead of colliding
-- with (or requiring) a phone number that doesn't exist for them.

alter table contacts add column if not exists ig_psid_enc text;
alter table contacts add column if not exists ig_psid_bidx text;
create unique index if not exists contacts_tenant_ig_psid_key on contacts (tenant_id, ig_psid_bidx) where ig_psid_bidx is not null;
