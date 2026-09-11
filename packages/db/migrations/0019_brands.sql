-- Brands a shop is reaching out to for partnerships/reselling — a lead list,
-- not a customer: there is no chat history or consent record here, only what
-- was scraped or typed in by hand while building the target list.
create table if not exists brands (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  name              text not null,
  pic_name          text,
  phone_enc         text,
  phone_bidx        text,
  email_enc         text,
  email_bidx        text,
  instagram         text,
  website           text,
  category          text,
  city              text,
  -- Where the row came from, kept next to the data itself so a scraped batch
  -- is never confused with something a person typed in and vouches for.
  source            text not null default 'manual' check (source in ('scrape', 'manual', 'referral', 'other')),
  status            text not null default 'not_contacted'
                    check (status in ('not_contacted', 'contacted', 'replied', 'interested', 'rejected')),
  assignee_id       uuid references users(id) on delete set null,
  notes             text,
  last_contacted_at timestamptz,
  created_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists brands_tenant_idx on brands (tenant_id, created_at desc);
create index if not exists brands_status_idx on brands (tenant_id, status);
create index if not exists brands_assignee_idx on brands (tenant_id, assignee_id);

do $$
begin
  execute 'alter table brands enable row level security';
  execute 'alter table brands force row level security';
  if not exists (select 1 from pg_policies where tablename = 'brands' and policyname = 'tenant_isolation') then
    execute
      'create policy tenant_isolation on brands using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())';
  end if;
  execute 'grant select, insert, update, delete on brands to kirana_app';
end $$;
