-- Links a brand's own PIC to a Contact record, so a brand prospect can flow
-- into the parts of the app that only know how to talk to a Contact — a
-- Task, a Deal, WA chat/broadcast. Nullable: a brand still being scraped or
-- cold-outreached has no business owning a Contact row yet.
alter table brands add column if not exists contact_id uuid references contacts(id) on delete set null;
create index if not exists brands_contact_idx on brands (tenant_id, contact_id);
