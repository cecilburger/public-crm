-- Which brand/product a deal is actually about — the free-text `title` a deal
-- started with was often already an informal stand-in for this ("Batik Parang
-- grosir — 3 pcs"); this makes it a real link into the same Brand Tracker
-- list (`brands`) instead of a name typed fresh on every deal. Nullable: a
-- deal auto-opened from marking a chat contact "customer" has no brand picked
-- yet, and `title` stays as the fallback until one is.
alter table deals add column if not exists brand_id uuid references brands(id) on delete set null;
create index if not exists deals_brand_idx on deals (tenant_id, brand_id);
