-- Reference data that is the same for every tenant. Written before RLS matters
-- because it carries no tenant_id.
create table if not exists meta_rate_card (
  category    text primary key check (category in ('service','utility','marketing','authentication')),
  cost_idr    integer not null,
  effective_from date not null default current_date
);
insert into meta_rate_card (category, cost_idr) values
  ('service', 0), ('utility', 350), ('marketing', 900), ('authentication', 500)
on conflict (category) do nothing;
grant select on meta_rate_card to kirana_app, kirana_ingest;

create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now(),
  checksum   text not null
);
