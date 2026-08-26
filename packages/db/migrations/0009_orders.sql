-- Orders the chatbot can actually take.
--
-- The model never supplies a price or a total. It chooses a SKU and a quantity;
-- every number below is computed here from the catalogue. That is the whole
-- safety design: a model that cannot do arithmetic on your behalf cannot get
-- your arithmetic wrong.
create table if not exists orders (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  contact_id      uuid not null references contacts(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  code            text not null,
  status          text not null default 'draft'
                  check (status in ('draft','awaiting_payment','paid','cancelled','fulfilled')),
  subtotal_micros bigint not null default 0,
  shipping_micros bigint not null default 0,
  total_micros    bigint not null default 0,
  ship_area       text,
  -- Delivery details are personal data, sealed like every other personal field.
  recipient_enc   text,
  address_enc     text,
  notes           text,
  deal_id         uuid references deals(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  paid_at         timestamptz
);
create unique index if not exists orders_code_key on orders (tenant_id, code);
-- One order being built per conversation, so a chatbot that calls the tool twice
-- updates the basket instead of creating a second one.
create unique index if not exists orders_open_draft on orders (tenant_id, conversation_id)
  where status = 'draft';
create index if not exists orders_contact_idx on orders (tenant_id, contact_id, created_at desc);

create table if not exists order_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  order_id          uuid not null references orders(id) on delete cascade,
  knowledge_item_id uuid references knowledge_items(id) on delete set null,
  sku               text not null,
  title             text not null,
  unit_price_micros bigint not null,
  qty               integer not null check (qty > 0),
  line_total_micros bigint not null
);
create unique index if not exists order_items_sku_key on order_items (tenant_id, order_id, sku);

create table if not exists shipping_rates (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  area      text not null,
  cost_idr  integer not null check (cost_idr >= 0),
  eta_days  integer not null default 2
);
create unique index if not exists shipping_area_key on shipping_rates (tenant_id, lower(area));

-- A checkout page the customer can open. Its code is looked up before any tenant
-- context exists, so the lookup is scoped to the control-plane role by policy
-- rather than opened up to everyone.
create table if not exists payment_links (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  order_id   uuid not null references orders(id) on delete cascade,
  code       text not null unique,
  provider   text not null default 'manual_transfer',
  status     text not null default 'open' check (status in ('open','paid','expired','cancelled')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);

do $$
declare t text;
begin
  foreach t in array array['orders','order_items','shipping_rates','payment_links'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'tenant_isolation') then
      execute format(
        'create policy tenant_isolation on %I using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
    end if;
    execute format('grant select, insert, update, delete on %I to kirana_app', t);
  end loop;

  if not exists (select 1 from pg_policies where tablename = 'payment_links' and policyname = 'checkout_lookup') then
    create policy checkout_lookup on payment_links for select to kirana_provisioner using (true);
  end if;
end $$;
grant select on payment_links to kirana_provisioner;
