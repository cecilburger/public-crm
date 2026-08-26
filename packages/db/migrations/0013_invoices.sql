-- Charging the shop for their Kirana plan.
--
-- Until now usage was metered perfectly and nobody was ever billed. An invoice
-- is a durable, numbered record — not a computed view — because once it is sent
-- it must never change, even if the price list does.

-- Who the invoice is actually made out to. Separate from `tenants` because a
-- workspace name is not a legal entity, and procurement will ask for both.
create table if not exists billing_profiles (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  legal_name    text not null,
  npwp          text,
  address       text,
  billing_email text,
  -- Payment instructions shown on the invoice while collection is manual.
  bank_details  text,
  updated_at    timestamptz not null default now()
);

create table if not exists invoices (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  number            text not null,
  billing_period_id uuid references billing_periods(id) on delete set null,
  status            text not null default 'draft'
                    check (status in ('draft','issued','paid','overdue','void','written_off')),
  -- Integers, always. Rupiah has no subunit in practice and floats have no place
  -- anywhere near an invoice.
  subtotal_idr      bigint not null default 0,
  ppn_idr           bigint not null default 0,
  total_idr         bigint not null default 0,
  ppn_rate          numeric(4,3) not null default 0.110,
  currency          char(3) not null default 'IDR',
  -- Snapshotted at issue time: the bill must not change when the profile does.
  bill_to_name      text,
  bill_to_npwp      text,
  bill_to_address   text,
  bill_to_email     text,
  faktur_number     text,
  notes             text,
  provider          text,
  payment_ref       text,
  issued_at         timestamptz,
  due_at            timestamptz,
  paid_at           timestamptz,
  paid_by           uuid references users(id) on delete set null,
  reminders_sent    integer not null default 0,
  last_reminder_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists invoices_number_key on invoices (tenant_id, number);
-- One invoice per closed period, so a re-run of the rollup cannot double-bill.
create unique index if not exists invoices_period_key on invoices (tenant_id, billing_period_id)
  where billing_period_id is not null;
create index if not exists invoices_chase_idx on invoices (tenant_id, status, due_at)
  where status in ('issued','overdue');

create table if not exists invoice_lines (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  invoice_id  uuid not null references invoices(id) on delete cascade,
  position    integer not null,
  key         text not null,
  label       text not null,
  qty         integer not null default 1,
  unit_idr    bigint not null default 0,
  amount_idr  bigint not null default 0
);
create index if not exists invoice_lines_idx on invoice_lines (tenant_id, invoice_id, position);

-- Sequential numbering per tenant per year, allocated atomically.
create table if not exists invoice_counters (
  tenant_id uuid not null references tenants(id) on delete cascade,
  year      integer not null,
  last_seq  integer not null default 0,
  primary key (tenant_id, year)
);

do $$
declare t text;
begin
  foreach t in array array['billing_profiles','invoices','invoice_lines','invoice_counters'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'tenant_isolation') then
      execute format(
        'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    end if;
    execute format('grant select, insert, update, delete on %I to kirana_app', t);
  end loop;
end $$;
