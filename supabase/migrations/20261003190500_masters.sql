-- 6. Maestros: clientes, proveedores y productos (DATABASE.md §6).
-- Lectura por permiso (<recurso>.read). Altas y cambios sólo por RPC
-- (master_save, master_set_active), que valida y deja auditoría.

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code = upper(trim(code)) and code <> ''),
  legal_name text not null check (length(trim(legal_name)) >= 2),
  trade_name text not null default '',
  tax_id text not null default '',
  vat_condition text not null default 'RESPONSABLE_INSCRIPTO'
    check (vat_condition in ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL')),
  address_line text not null default '',
  city text not null default '',
  province text not null default '',
  phone text not null default '',
  email text not null default '',
  contact_name text not null default '',
  payment_terms_days int not null default 0 check (payment_terms_days >= 0),
  credit_limit numeric(14, 2),
  notes text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id)
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code = upper(trim(code)) and code <> ''),
  legal_name text not null check (length(trim(legal_name)) >= 2),
  trade_name text not null default '',
  tax_id text not null default '',
  vat_condition text not null default 'RESPONSABLE_INSCRIPTO'
    check (vat_condition in ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL')),
  address_line text not null default '',
  city text not null default '',
  province text not null default '',
  phone text not null default '',
  email text not null default '',
  contact_name text not null default '',
  payment_terms_days int not null default 0 check (payment_terms_days >= 0),
  lead_time_days int check (lead_time_days >= 0), -- demora habitual de entrega
  category text not null default '', -- aserradero, herrajes, pinturería…
  notes text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code = upper(trim(code)) and code <> ''),
  name text not null check (length(trim(name)) >= 2),
  description text not null default '',
  category text not null default '',
  product_type text not null
    check (product_type in ('MATERIA_PRIMA', 'INSUMO', 'PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO')),
  uom_code text not null references public.units_of_measure (code),
  is_stockable boolean not null,
  standard_cost numeric(14, 4) not null default 0 check (standard_cost >= 0),
  sale_price numeric(14, 2) check (sale_price >= 0),
  vat_rate numeric(5, 2) not null default 21 check (vat_rate in (0, 10.5, 21, 27)),
  min_stock numeric(14, 3) not null default 0 check (min_stock >= 0),
  reorder_qty numeric(14, 3) check (reorder_qty > 0),
  default_supplier_id uuid,
  default_warehouse_id uuid,
  location text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id),
  -- FK compuestas: un producto nunca apunta a un proveedor o depósito de otra empresa.
  foreign key (company_id, default_supplier_id) references public.suppliers (company_id, id),
  foreign key (company_id, default_warehouse_id) references public.warehouses (company_id, id),
  check (is_stockable = (product_type <> 'SERVICIO'))
);

do $$
declare
  t text;
begin
  foreach t in array array['customers', 'suppliers', 'products'] loop
    execute format('create trigger %I before insert or update on public.%I for each row execute function private.set_audit_fields()', t || '_audit', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.prevent_company_change()', t || '_same_company', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end;
$$;

create policy customers_select on public.customers for select to authenticated
  using (company_id in (select private.companies_with_permission('customer.read')));
create policy suppliers_select on public.suppliers for select to authenticated
  using (company_id in (select private.companies_with_permission('supplier.read')));
create policy products_select on public.products for select to authenticated
  using (company_id in (select private.companies_with_permission('product.read')));
