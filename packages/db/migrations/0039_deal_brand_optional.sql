-- A deal can now belong to a Brand with no Contact at all — matching what
-- tasks already do (see 0038). The mark-customer flow still opens a deal
-- straight off a Contact with no Brand involved, so contact_id stays valid
-- on its own; this just stops it being mandatory.
alter table deals alter column contact_id drop not null;
alter table deals add constraint deals_contact_or_brand check (contact_id is not null or brand_id is not null);
