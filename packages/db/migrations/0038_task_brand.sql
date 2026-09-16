-- A task can now belong to a Brand directly, with no Contact in between —
-- the Brand already has its own phone number, so a follow-up/meeting task
-- against a brand prospect no longer needs a Contact record manufactured
-- for it just to satisfy this table's old not-null constraint. Existing
-- (Pelanggan-origin) tasks are untouched: contact_id stays populated for
-- every row that already had it.
alter table tasks add column if not exists brand_id uuid references brands(id) on delete set null;
alter table tasks alter column contact_id drop not null;
alter table tasks add constraint tasks_contact_or_brand check (contact_id is not null or brand_id is not null);
create index if not exists tasks_brand_idx on tasks (tenant_id, brand_id);
