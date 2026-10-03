-- 9. Documentos, compras, stock y flujo de trabajo (DATABASE.md §7, §8 y §9).
-- Cabecera común + tabla propia por tipo, unidas por (empresa, id, tipo): una
-- fila de purchase_orders sólo puede colgar de un documento de tipo
-- PURCHASE_ORDER de la misma empresa, y las líneas sólo de su subtipo.
-- Todo se escribe por RPC; los usuarios leen según el permiso del tipo.

create table public.document_sequences (
  company_id uuid not null references public.companies (id) on delete cascade,
  doc_type text not null references public.document_types (code),
  next_number int not null default 1,
  primary key (company_id, doc_type)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  doc_type text not null references public.document_types (code),
  number int not null,
  display_number text not null,
  status text not null,
  document_date date not null, -- fecha de negocio (real o simulada)
  sector_id uuid, -- sector que origina el documento
  supplier_id uuid,
  customer_id uuid,
  subtotal numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  notes text not null default '',
  status_reason text not null default '', -- motivo del último rechazo, anulación o cierre
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, doc_type, number),
  unique (company_id, id),
  unique (company_id, id, doc_type),
  foreign key (doc_type, status) references public.document_statuses (doc_type, code),
  foreign key (company_id, sector_id) references public.sectors (company_id, id),
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  foreign key (company_id, customer_id) references public.customers (company_id, id),
  check (supplier_id is null or customer_id is null)
);
create index documents_company_type_status_idx on public.documents (company_id, doc_type, status);

create table public.document_links (
  company_id uuid not null,
  from_document_id uuid not null,
  to_document_id uuid not null,
  link_type text not null default 'ORIGEN',
  created_at timestamptz not null default now(),
  primary key (from_document_id, to_document_id),
  foreign key (company_id, from_document_id) references public.documents (company_id, id) on delete cascade,
  foreign key (company_id, to_document_id) references public.documents (company_id, id) on delete cascade
);
create index document_links_to_idx on public.document_links (to_document_id);

alter table public.audit_events
  add foreign key (document_id) references public.documents (id) on delete set null;

-- ------------------------------------------------------------------ Solicitud de compra (SC)
create table public.purchase_requisitions (
  document_id uuid primary key,
  doc_type text not null default 'PURCHASE_REQUISITION' check (doc_type = 'PURCHASE_REQUISITION'),
  company_id uuid not null,
  needed_by date,
  priority text not null default 'NORMAL' check (priority in ('BAJA', 'NORMAL', 'ALTA', 'URGENTE')),
  reason text not null, -- por qué se necesita: se enseña a justificar
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade
);

create table public.purchase_requisition_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  qty_ordered numeric(14, 3) not null default 0, -- cubierto por OC que ya no son borrador
  notes text not null default '',
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.purchase_requisitions (company_id, document_id) on delete cascade,
  foreign key (company_id, product_id) references public.products (company_id, id)
);

-- ------------------------------------------------------------------ Orden de compra (OC)
create table public.purchase_orders (
  document_id uuid primary key,
  doc_type text not null default 'PURCHASE_ORDER' check (doc_type = 'PURCHASE_ORDER'),
  company_id uuid not null,
  expected_date date,
  warehouse_id uuid not null,
  payment_terms_days int not null default 0 check (payment_terms_days >= 0),
  delivery_terms text not null default '',
  approved_at timestamptz,
  sent_at timestamptz,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, warehouse_id) references public.warehouses (company_id, id)
);

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  product_id uuid not null,
  requisition_line_id uuid, -- línea de SC que atiende
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_price numeric(14, 4) not null check (unit_price >= 0), -- neto, sin IVA
  vat_rate numeric(5, 2) not null check (vat_rate in (0, 10.5, 21, 27)),
  line_subtotal numeric(14, 2) not null,
  line_tax numeric(14, 2) not null,
  line_total numeric(14, 2) not null,
  qty_received numeric(14, 3) not null default 0 check (qty_received >= 0), -- de recepciones confirmadas
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.purchase_orders (company_id, document_id) on delete cascade,
  foreign key (company_id, product_id) references public.products (company_id, id),
  foreign key (company_id, requisition_line_id) references public.purchase_requisition_lines (company_id, id)
);
create index purchase_order_lines_requisition_idx on public.purchase_order_lines (requisition_line_id);

-- ------------------------------------------------------------------ Recepción (REC)
create table public.goods_receipts (
  document_id uuid primary key,
  doc_type text not null default 'GOODS_RECEIPT' check (doc_type = 'GOODS_RECEIPT'),
  company_id uuid not null,
  purchase_order_id uuid not null,
  warehouse_id uuid not null,
  supplier_delivery_note text not null, -- N.º de remito del proveedor
  carrier_name text not null default '',
  received_at timestamptz,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, purchase_order_id) references public.purchase_orders (company_id, document_id),
  foreign key (company_id, warehouse_id) references public.warehouses (company_id, id)
);
create index goods_receipts_order_idx on public.goods_receipts (purchase_order_id);

create table public.goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  po_line_id uuid not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_cost numeric(14, 4) not null, -- precio neto de la OC: base del PPP
  notes text not null default '',
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.goods_receipts (company_id, document_id) on delete cascade,
  foreign key (company_id, po_line_id) references public.purchase_order_lines (company_id, id),
  foreign key (company_id, product_id) references public.products (company_id, id)
);

-- ------------------------------------------------------------------ Ajuste de stock (AJS)
create table public.stock_adjustments (
  document_id uuid primary key,
  doc_type text not null default 'STOCK_ADJUSTMENT' check (doc_type = 'STOCK_ADJUSTMENT'),
  company_id uuid not null,
  warehouse_id uuid not null,
  reason_code text not null check (reason_code in ('INVENTARIO_INICIAL', 'CONTEO_FISICO', 'ROTURA', 'CONSUMO_INTERNO', 'OTRO')),
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, warehouse_id) references public.warehouses (company_id, id)
);

create table public.stock_adjustment_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  product_id uuid not null,
  quantity_delta numeric(14, 3) not null check (quantity_delta <> 0),
  unit_cost numeric(14, 4) not null,
  notes text not null default '',
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.stock_adjustments (company_id, document_id) on delete cascade,
  foreign key (company_id, product_id) references public.products (company_id, id)
);

-- ------------------------------------------------------------------ Stock: kardex y saldos
create table public.stock_movements (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  product_id uuid not null,
  warehouse_id uuid not null,
  movement_type text not null references public.stock_movement_types (code),
  quantity numeric(14, 3) not null check (quantity <> 0), -- con signo: + entra, − sale
  unit_cost numeric(14, 4) not null,
  total_cost numeric(14, 2) not null,
  balance_qty numeric(14, 3) not null, -- saldo posterior (kardex)
  balance_avg_cost numeric(14, 4) not null, -- PPP posterior
  document_id uuid,
  document_line_id uuid,
  movement_date date not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (company_id, product_id) references public.products (company_id, id),
  foreign key (company_id, warehouse_id) references public.warehouses (company_id, id),
  foreign key (company_id, document_id) references public.documents (company_id, id)
);
create index stock_movements_product_idx on public.stock_movements (company_id, product_id, warehouse_id, id);
create trigger stock_movements_immutable before update or delete on public.stock_movements
  for each row execute function private.forbid_mutation();

create table public.stock_balances (
  company_id uuid not null,
  product_id uuid not null,
  warehouse_id uuid not null,
  qty_on_hand numeric(14, 3) not null default 0,
  qty_reserved numeric(14, 3) not null default 0, -- se usará con Ventas
  avg_unit_cost numeric(14, 4) not null default 0, -- PPP
  last_movement_at timestamptz,
  primary key (product_id, warehouse_id),
  foreign key (company_id, product_id) references public.products (company_id, id),
  foreign key (company_id, warehouse_id) references public.warehouses (company_id, id)
);
create index stock_balances_company_idx on public.stock_balances (company_id);

-- ------------------------------------------------------------------ Aprobaciones, tareas y notificaciones
create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  rule_id uuid not null,
  level int not null,
  approver_role text not null references public.roles (code),
  amount numeric(14, 2) not null, -- monto evaluado (fotografía)
  status text not null default 'PENDIENTE' check (status in ('PENDIENTE', 'APROBADO', 'RECHAZADO', 'CANCELADO')),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  comment text not null default '',
  foreign key (company_id, document_id) references public.documents (company_id, id) on delete cascade,
  foreign key (company_id, rule_id) references public.approval_rules (company_id, id)
);
-- Nunca dos pedidos de aprobación pendientes para el mismo documento.
create unique index approval_requests_one_pending on public.approval_requests (document_id) where status = 'PENDIENTE';

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  document_id uuid,
  task_type text not null,
  title text not null,
  description text not null default '',
  origin_status text, -- estado del documento que la originó
  context jsonb not null default '{}', -- p. ej. {"product_id": "…"} en REPONER_STOCK
  assigned_role text references public.roles (code),
  assigned_user_id uuid references public.profiles (id),
  status text not null default 'PENDIENTE' check (status in ('PENDIENTE', 'EN_CURSO', 'RESUELTA', 'CANCELADA')),
  priority text not null default 'NORMAL' check (priority in ('BAJA', 'NORMAL', 'ALTA', 'URGENTE')),
  source text not null default 'SISTEMA' check (source in ('SISTEMA', 'DOCENTE', 'ESCENARIO')),
  claimed_by uuid,
  claimed_at timestamptz,
  completed_by uuid,
  completed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (company_id, document_id) references public.documents (company_id, id) on delete cascade
);
create index tasks_open_idx on public.tasks (company_id, status, assigned_role);
create index tasks_user_idx on public.tasks (assigned_user_id) where status in ('PENDIENTE', 'EN_CURSO');
create index tasks_document_idx on public.tasks (document_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  recipient_user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null, -- NUEVA_TAREA, OC_APROBADA, STOCK_MINIMO…
  title text not null,
  body text not null default '',
  link_path text not null default '',
  document_id uuid,
  task_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications (recipient_user_id, company_id, created_at desc);

-- ------------------------------------------------------------------ Seguridad
create trigger documents_audit before insert or update on public.documents
  for each row execute function private.set_audit_fields();

do $$
declare
  t text;
begin
  foreach t in array array[
    'document_sequences', 'documents', 'document_links', 'purchase_requisitions', 'purchase_requisition_lines',
    'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'stock_adjustments',
    'stock_adjustment_lines', 'stock_movements', 'stock_balances', 'approval_requests', 'tasks', 'notifications'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    if t <> 'document_sequences' then
      execute format('grant select on table public.%I to authenticated', t);
    end if;
    if t not in ('stock_movements', 'stock_balances', 'tasks', 'notifications', 'document_sequences') then
      execute format(
        'create trigger %I before update on public.%I for each row execute function private.prevent_company_change()',
        t || '_same_company', t
      );
    end if;
  end loop;
end;
$$;

-- Pares (empresa, tipo de documento) que el usuario puede leer (DATABASE.md §11.1).
create function private.readable_document_scopes()
returns table (company_id uuid, doc_type text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, dt.code
    from public.document_types dt
   cross join lateral private.companies_with_permission(dt.resource || '.read') as c (id)
$$;

-- (empresa, rol) del usuario: para ver las tareas asignadas a su rol.
create function private.my_company_roles()
returns table (company_id uuid, role_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.company_id, mr.role_code
    from public.company_members m
    join public.member_roles mr on mr.company_id = m.company_id and mr.member_id = m.id
   where m.user_id = (select auth.uid()) and m.is_active and private.current_app_role() is not null
$$;

grant execute on function private.readable_document_scopes() to authenticated;
grant execute on function private.my_company_roles() to authenticated;

create policy documents_select on public.documents for select to authenticated
  using ((company_id, doc_type) in (select s.company_id, s.doc_type from private.readable_document_scopes() s));
create policy document_links_select on public.document_links for select to authenticated
  using (company_id in (select private.my_companies()));
create policy purchase_requisitions_select on public.purchase_requisitions for select to authenticated
  using (company_id in (select private.companies_with_permission('purchase_requisition.read')));
create policy purchase_requisition_lines_select on public.purchase_requisition_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('purchase_requisition.read')));
create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using (company_id in (select private.companies_with_permission('purchase_order.read')));
create policy purchase_order_lines_select on public.purchase_order_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('purchase_order.read')));
create policy goods_receipts_select on public.goods_receipts for select to authenticated
  using (company_id in (select private.companies_with_permission('goods_receipt.read')));
create policy goods_receipt_lines_select on public.goods_receipt_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('goods_receipt.read')));
create policy stock_adjustments_select on public.stock_adjustments for select to authenticated
  using (company_id in (select private.companies_with_permission('stock_adjustment.read')));
create policy stock_adjustment_lines_select on public.stock_adjustment_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('stock_adjustment.read')));
create policy stock_movements_select on public.stock_movements for select to authenticated
  using (company_id in (select private.companies_with_permission('stock.read')));
create policy stock_balances_select on public.stock_balances for select to authenticated
  using (company_id in (select private.companies_with_permission('stock.read')));
create policy approval_requests_select on public.approval_requests for select to authenticated
  using (company_id in (select private.companies_with_permission('purchase_order.read')));
-- Tareas: las propias, las de mis roles, o todas si tengo task.read (Gerencia, Auditoría).
create policy tasks_select on public.tasks for select to authenticated
  using (
    (assigned_user_id = (select auth.uid()) and company_id in (select private.my_companies()))
    or (company_id, assigned_role) in (select r.company_id, r.role_code from private.my_company_roles() r)
    or company_id in (select private.companies_with_permission('task.read'))
  );
-- Notificaciones: sólo las propias.
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_user_id = (select auth.uid()) and company_id in (select private.my_companies()));
