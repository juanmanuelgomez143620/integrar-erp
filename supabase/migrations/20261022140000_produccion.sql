-- 40. Fase 5a (docs/FASE_5_PRODUCCION_Y_COSTOS.md §2 y §3): listas de materiales
-- y orden de producción (liberar reserva los materiales, Depósito los entrega y
-- terminar ingresa el producto al costo real), con los asientos del consumo y de
-- la producción terminada. Traducción de las secciones "Listas de materiales" y
-- "Órdenes de producción" de src/lib/mock/engine.ts y de sus lecturas en
-- queries.ts, con los mismos mensajes y la misma forma de datos.
--
-- El tipo de documento, sus estados, transiciones, tareas, permisos, tipos de
-- movimiento de stock y claves de imputación están en la migración de catálogos
-- siguiente; las listas de la demo y las reglas base, en la de la plantilla.

-- ------------------------------------------------------------------ Catálogos: las acciones nuevas

alter table public.permissions drop constraint permissions_action_check;
alter table public.permissions add constraint permissions_action_check
  check (action in ('read', 'create', 'update', 'approve', 'cancel', 'delete', 'export', 'pay', 'award', 'issue'));
alter table public.document_transitions drop constraint document_transitions_action_check;
alter table public.document_transitions add constraint document_transitions_action_check
  check (action in ('SUBMIT', 'APPROVE', 'REJECT', 'WITHDRAW', 'REOPEN', 'SEND', 'CONFIRM', 'CANCEL', 'CLOSE', 'PAY', 'AWARD',
                    'RELEASE', 'ISSUE', 'FINISH', 'SYSTEM'));

-- ------------------------------------------------------------------ Tablas

-- Lista de materiales de un producto terminado (una por producto): su fórmula.
create table public.boms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  product_id uuid not null,
  notes text not null default '' check (length(notes) <= 300),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, product_id),
  unique (company_id, id),
  foreign key (company_id, product_id) references public.products (company_id, id)
);

-- Un componente: una materia prima o un insumo y cuánto lleva cada unidad.
create table public.bom_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  bom_id uuid not null,
  line_no int not null,
  component_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unique (bom_id, line_no),
  unique (company_id, id),
  foreign key (company_id, bom_id) references public.boms (company_id, id) on delete cascade,
  foreign key (company_id, component_id) references public.products (company_id, id)
);
create index bom_lines_component_idx on public.bom_lines (component_id);

-- Orden de producción: 1 a 1 con documents (tipo PRODUCTION_ORDER).
create table public.production_orders (
  document_id uuid primary key,
  doc_type text not null default 'PRODUCTION_ORDER' check (doc_type = 'PRODUCTION_ORDER'),
  company_id uuid not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),     -- unidades planificadas
  materials_warehouse_id uuid not null,                       -- de dónde salen los materiales: ahí se reservan
  output_warehouse_id uuid not null,                          -- adónde entra el producto terminado
  due_date date,                                              -- fecha prevista de terminación (opcional)
  quantity_produced numeric(14, 3) check (quantity_produced > 0), -- las que salieron bien (al terminarla)
  unit_cost numeric(14, 4),                                   -- costo real de cada una (al terminarla)
  released_at timestamptz,
  issued_at timestamptz,
  finished_at timestamptz,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, product_id) references public.products (company_id, id),
  foreign key (company_id, materials_warehouse_id) references public.warehouses (company_id, id),
  foreign key (company_id, output_warehouse_id) references public.warehouses (company_id, id)
);
create index production_orders_product_idx on public.production_orders (product_id);

-- Un material de la orden: lo previsto según la lista y lo que entregó Depósito.
create table public.production_order_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  product_id uuid not null,                                   -- el componente
  quantity_planned numeric(14, 3) not null check (quantity_planned > 0),
  planned_unit_cost numeric(14, 4) not null,                  -- costo promedio (o estándar) al planificarla
  quantity_issued numeric(14, 3) not null default 0 check (quantity_issued >= 0),
  unit_cost numeric(14, 4) not null default 0,                -- costo promedio con que salió (al entregarlo)
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.production_orders (company_id, document_id) on delete cascade,
  foreign key (company_id, product_id) references public.products (company_id, id)
);
create index production_order_lines_product_idx on public.production_order_lines (product_id);

create trigger boms_audit before insert or update on public.boms
  for each row execute function private.set_audit_fields();

do $$
declare
  t text;
begin
  foreach t in array array['boms', 'bom_lines', 'production_orders', 'production_order_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.prevent_company_change()',
      t || '_same_company', t
    );
  end loop;
end;
$$;

create policy boms_select on public.boms for select to authenticated
  using (company_id in (select private.companies_with_permission('bom.read')));
create policy bom_lines_select on public.bom_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('bom.read')));
create policy production_orders_select on public.production_orders for select to authenticated
  using (company_id in (select private.companies_with_permission('production_order.read')));
create policy production_order_lines_select on public.production_order_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('production_order.read')));

-- ------------------------------------------------------------------ Stock reservado

-- Lo reservado de un producto en un depósito (salvo para un documento): lo que les
-- falta entregar a los pedidos de venta en curso y los materiales de las órdenes
-- de producción liberadas (reservedQuantity).
create or replace function private.reserved_quantity(p_product uuid, p_warehouse uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(
    coalesce((
      select sum(greatest(l.quantity - l.qty_delivered, 0))
        from public.sales_order_lines l
        join public.sales_orders so on so.document_id = l.document_id
        join public.documents d on d.id = l.document_id
       where l.product_id = p_product and so.warehouse_id = p_warehouse
         and d.status = any (private.active_sales_statuses()) and d.id is distinct from p_except), 0)
    + coalesce((
      select sum(l.quantity_planned)
        from public.production_order_lines l
        join public.production_orders o on o.document_id = l.document_id
        join public.documents d on d.id = l.document_id
       where l.product_id = p_product and o.materials_warehouse_id = p_warehouse
         and d.status = 'LIBERADA' and d.id is distinct from p_except), 0),
    3)
$$;

-- ------------------------------------------------------------------ Auxiliares

-- "materia prima", "producto terminado"…: el tipo de producto dentro de una frase (PRODUCT_TYPES en minúscula).
create function private.product_type_label(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'MATERIA_PRIMA' then 'materia prima'
    when 'INSUMO' then 'insumo'
    when 'PRODUCTO_TERMINADO' then 'producto terminado'
    when 'MERCADERIA_REVENTA' then 'mercadería de reventa'
    when 'SERVICIO' then 'servicio'
    else lower(p_type)
  end
$$;

-- "6 componentes" o "1 componente" (componentsLabel).
create function private.components_label(p_count int)
returns text
language sql
immutable
set search_path = ''
as $$ select p_count || ' ' || case when p_count = 1 then 'componente' else 'componentes' end $$;

-- El costo de un material para planificar: su costo promedio en el depósito o,
-- si todavía no hay stock con costo, su costo estándar (plannedUnitCost).
create function private.planned_unit_cost(p_product public.products, p_warehouse uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    nullif((select b.avg_unit_cost from public.stock_balances b
             where b.product_id = p_product.id and b.warehouse_id = p_warehouse), 0),
    p_product.standard_cost)
$$;

-- Costo estimado de los materiales de una unidad (bomMaterialCost).
create function private.bom_material_cost(p_bom uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(round(l.quantity * private.planned_unit_cost(c, c.default_warehouse_id), 2)), 0), 2)
    from public.bom_lines l join public.products c on c.id = l.component_id
   where l.bom_id = p_bom
$$;

-- El costo de los materiales que se entregaron para una orden (productionMaterialCost).
create function private.production_material_cost(p_doc uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(round(l.quantity_issued * l.unit_cost, 2)), 0), 2)
    from public.production_order_lines l where l.document_id = p_doc
$$;

-- Lo que no alcanza de cada material para liberar la orden, en una frase; null si
-- alcanza todo o si la empresa permite el stock negativo (productionShortages y shortageText).
create function private.production_shortages(p_doc public.documents)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select string_agg(
           format('%s necesita %s y hay %s disponibles', p.code, private.format_qty(l.quantity_planned, p.uom_code),
                  private.format_qty(greatest(x.available, 0), p.uom_code))
           || case when x.reserved > 0
                then format(' (%s en el depósito y %s reservados para otras órdenes)',
                            private.format_qty(x.on_hand, p.uom_code), private.format_qty(x.reserved, p.uom_code))
                else '' end,
           '; ' order by l.line_no)
    from public.production_orders o
    join public.production_order_lines l on l.document_id = o.document_id
    join public.products p on p.id = l.product_id
    cross join lateral (
      select y.on_hand, y.reserved, round(y.on_hand - y.reserved, 3) as available
        from (select private.on_hand_quantity(p.id, o.materials_warehouse_id) as on_hand,
                     private.reserved_quantity(p.id, o.materials_warehouse_id, o.document_id) as reserved) as y
    ) as x
   where o.document_id = p_doc.id
     and not coalesce((select (c.settings ->> 'allow_negative_stock')::boolean from public.companies c
                        where c.id = p_doc.company_id), false)
     and l.quantity_planned > x.available + 0.000000001
$$;

-- ------------------------------------------------------------------ Listas de materiales: comandos

-- Crea o reemplaza la lista de materiales de un producto terminado; las órdenes ya
-- cargadas no cambian (cmdSaveBom). p_input: {product_id, notes, lines: [{component_id, quantity}]}
create function public.bom_save(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.boms;
  v_actor private.actor;
  v_p public.products;
  v_c public.products;
  v_notes text := trim(coalesce(p_input ->> 'notes', ''));
  v_line jsonb;
  v_lines jsonb := '[]';
  v_seen uuid[] := '{}';
  v_qty numeric;
  v_bom public.boms;
begin
  -- El permiso se controla antes de mirar el producto (crear o modificar, según tenga lista).
  select * into v_existing from public.boms b
   where b.company_id = p_company_id and b.product_id::text = p_input ->> 'product_id';
  v_actor := private.require_permission(p_company_id, case when v_existing.id is not null then 'bom.update' else 'bom.create' end);
  v_p := private.product_for(p_company_id, nullif(p_input ->> 'product_id', '')::uuid);
  if v_p.product_type <> 'PRODUCTO_TERMINADO' then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s es %s: sólo los productos terminados tienen lista de materiales.', v_p.code,
             private.product_type_label(v_p.product_type)));
  end if;
  if not v_p.is_active then
    perform private.raise_business_error('DATO_INVALIDO', format('%s %s está inactivo.', v_p.code, v_p.name));
  end if;
  if length(v_notes) > 300 then
    perform private.raise_business_error('DATO_INVALIDO', 'Las observaciones tienen hasta 300 caracteres.');
  end if;
  for v_line in
    select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) as l where nullif(l ->> 'component_id', '') is not null
  loop
    v_c := private.product_for(p_company_id, (v_line ->> 'component_id')::uuid);
    if v_c.product_type not in ('MATERIA_PRIMA', 'INSUMO') then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s es %s: no va en una lista de materiales.', v_c.code, private.product_type_label(v_c.product_type)),
        'Los componentes son materias primas e insumos.');
    end if;
    if not v_c.is_active then
      perform private.raise_business_error('DATO_INVALIDO', format('%s %s está inactivo.', v_c.code, v_c.name));
    end if;
    if v_c.id = any (v_seen) then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s está dos veces: sumá las cantidades en un solo componente.', v_c.code));
    end if;
    v_seen := v_seen || v_c.id;
    v_qty := (v_line ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 or round(v_qty, 3) <> v_qty or v_qty >= 1000000 then
      perform private.raise_business_error('DATO_INVALIDO',
        format('La cantidad de %s por unidad debe ser mayor que cero y tener hasta 3 decimales.', v_c.code));
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('component_id', v_c.id, 'quantity', v_qty));
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Agregá al menos un componente.');
  end if;
  if v_existing.id is not null then
    -- Igual a la que hay: no cambia nada ni queda en la auditoría.
    if v_existing.notes = v_notes and (
         select coalesce(jsonb_agg(jsonb_build_object('component_id', l.component_id, 'quantity', l.quantity)
                                   order by l.line_no), '[]')
           from public.bom_lines l where l.bom_id = v_existing.id) = v_lines then
      return jsonb_build_object('id', v_existing.id);
    end if;
    delete from public.bom_lines where bom_id = v_existing.id;
    update public.boms set notes = v_notes where id = v_existing.id returning * into v_bom;
  else
    insert into public.boms (company_id, product_id, notes) values (p_company_id, v_p.id, v_notes) returning * into v_bom;
  end if;
  insert into public.bom_lines (company_id, bom_id, line_no, component_id, quantity)
  select p_company_id, v_bom.id, x.ord, (x.l ->> 'component_id')::uuid, (x.l ->> 'quantity')::numeric
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord);
  perform private.log_audit(p_company_id, v_actor, case when v_existing.id is not null then 'UPDATE' else 'CREATE' end, 'bom',
    v_bom.id, 'Lista de materiales de ' || v_p.code,
    format('%s la lista de materiales de %s %s (%s)', case when v_existing.id is not null then 'Modificó' else 'Creó' end,
           v_p.code, v_p.name, private.components_label(jsonb_array_length(v_lines))));
  return jsonb_build_object('id', v_bom.id);
end;
$$;

-- Una lista desactivada no se usa para planificar órdenes nuevas (cmdSetBomActive).
create function public.bom_set_active(p_company_id uuid, p_bom_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'bom.update');
  v_bom public.boms;
  v_p public.products;
begin
  select * into v_bom from public.boms b where b.id = p_bom_id and b.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La lista de materiales no existe.');
  end if;
  if p_active is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si la lista está activa.');
  end if;
  if v_bom.is_active = p_active then
    return;
  end if;
  v_p := private.product_for(p_company_id, v_bom.product_id);
  update public.boms set is_active = p_active where id = v_bom.id;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, 'bom', v_bom.id,
    'Lista de materiales de ' || v_p.code,
    format('%s la lista de materiales de %s %s', case when p_active then 'Activó' else 'Desactivó' end, v_p.code, v_p.name));
end;
$$;

grant execute on function public.bom_save(uuid, jsonb) to authenticated;
grant execute on function public.bom_set_active(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ Órdenes de producción

-- Liberar: si alcanzan los materiales, la orden los reserva y Depósito recibe la
-- tarea de entregarlos (releaseProductionOrder).
create function private.release_production_order(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shortages text;
  v_o public.production_orders;
  v_p public.products;
begin
  perform private.require_transition(p_doc, 'RELEASE');
  v_shortages := private.production_shortages(p_doc);
  if v_shortages is not null then
    perform private.raise_business_error('STOCK_INSUFICIENTE',
      format('No alcanzan los materiales de %s: %s.', p_doc.display_number, v_shortages),
      'Pedí lo que falta a Compras (o fabricá menos unidades) y liberala cuando llegue.');
  end if;
  select * into v_o from public.production_orders o where o.document_id = p_doc.id;
  select * into v_p from public.products p where p.id = v_o.product_id;
  perform private.transition_document(p_doc.id, 'RELEASE',
    p_summary => format('Liberó %s: reservó los materiales para %s de %s', p_doc.display_number,
                        private.format_qty(v_o.quantity, v_p.uom_code), v_p.code));
  update public.production_orders set released_at = now() where document_id = p_doc.id;
end;
$$;

-- Producción planifica la orden: copia la lista de materiales activa del producto
-- (consumo previsto = cantidad por unidad × unidades) con el costo de cada material
-- en ese momento (cmdCreateProductionOrder).
-- p_input: {product_id, quantity, materials_warehouse_id, output_warehouse_id, due_date, notes}
create function public.opr_create(p_company_id uuid, p_input jsonb, p_release boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'production_order.create');
  v_p public.products;
  v_bom public.boms;
  v_qty numeric := (p_input ->> 'quantity')::numeric;
  v_materials uuid := nullif(p_input ->> 'materials_warehouse_id', '')::uuid;
  v_output uuid := nullif(p_input ->> 'output_warehouse_id', '')::uuid;
  v_due date;
  v_notes text := trim(coalesce(p_input ->> 'notes', ''));
  v_zero text;
  v_number record;
  v_doc public.documents;
begin
  v_p := private.product_for(p_company_id, nullif(p_input ->> 'product_id', '')::uuid);
  if not v_p.is_active then
    perform private.raise_business_error('DATO_INVALIDO', format('%s %s está inactivo.', v_p.code, v_p.name));
  end if;
  select * into v_bom from public.boms b where b.product_id = v_p.id and b.is_active;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', format('%s no tiene una lista de materiales activa.', v_p.code),
      'Producción la arma en Producción → Listas de materiales.');
  end if;
  if v_qty is null or v_qty <= 0 or round(v_qty, 3) <> v_qty or v_qty >= 1000000 then
    perform private.raise_business_error('DATO_INVALIDO', 'La cantidad a fabricar debe ser mayor que cero y tener hasta 3 decimales.');
  end if;
  if not exists (select 1 from public.warehouses w where w.id = v_materials and w.company_id = p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el depósito del que salen los materiales.');
  end if;
  if not exists (select 1 from public.warehouses w where w.id = v_output and w.company_id = p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el depósito al que entra el producto terminado.');
  end if;
  if p_input ->> 'due_date' is not null then
    v_due := private.parse_date(p_input ->> 'due_date');
    if v_due is null then
      perform private.raise_business_error('DATO_INVALIDO', 'La fecha prevista de terminación no es válida.');
    end if;
    if v_due < private.business_date(p_company_id) then
      perform private.raise_business_error('DATO_INVALIDO', 'La fecha prevista de terminación no puede ser anterior a hoy.');
    end if;
  end if;
  if length(v_notes) > 500 then
    perform private.raise_business_error('DATO_INVALIDO', 'Las observaciones tienen hasta 500 caracteres.');
  end if;
  select c.code into v_zero
    from public.bom_lines l join public.products c on c.id = l.component_id
   where l.bom_id = v_bom.id and round(l.quantity * v_qty, 3) <= 0
   order by l.line_no
   limit 1;
  if v_zero is not null then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Con esa cantidad, %s quedaría en cero: fabricá más unidades.', v_zero));
  end if;

  select * into v_number from private.next_document_number(p_company_id, 'PRODUCTION_ORDER');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, notes, created_by)
  values (p_company_id, 'PRODUCTION_ORDER', v_number.number, v_number.display_number, 'BORRADOR',
          private.business_date(p_company_id), (v_actor).sector_id, v_notes, (v_actor).user_id)
  returning * into v_doc;
  insert into public.production_orders (document_id, company_id, product_id, quantity, materials_warehouse_id,
                                        output_warehouse_id, due_date)
  values (v_doc.id, p_company_id, v_p.id, v_qty, v_materials, v_output, v_due);
  insert into public.production_order_lines (company_id, document_id, line_no, product_id, quantity_planned, planned_unit_cost)
  select p_company_id, v_doc.id, row_number() over (order by l.line_no), c.id, round(l.quantity * v_qty, 3),
         private.planned_unit_cost(c, v_materials)
    from public.bom_lines l join public.products c on c.id = l.component_id
   where l.bom_id = v_bom.id;
  -- El costo previsto de los materiales.
  update public.documents d
     set subtotal = t.cost, total = t.cost
    from (select round(coalesce(sum(round(l.quantity_planned * l.planned_unit_cost, 2)), 0), 2) as cost
            from public.production_order_lines l where l.document_id = v_doc.id) as t
   where d.id = v_doc.id
  returning d.* into v_doc;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'production_order', v_doc.id, v_doc.display_number,
    format('Creó %s: %s de %s %s', v_doc.display_number, private.format_qty(v_qty, v_p.uom_code), v_p.code, v_p.name),
    v_doc.id, null, 'BORRADOR');
  if p_release then
    perform private.release_production_order(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.opr_release(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PRODUCTION_ORDER');
  perform private.require_permission(v_doc.company_id, 'production_order.create');
  perform private.release_production_order(v_doc);
end;
$$;

-- Depósito entrega los materiales: lo que realmente sale de cada uno (puede ser más
-- o menos de lo previsto). El stock baja al costo promedio, la reserva se libera y
-- el consumo pasa a productos en proceso (cmdIssueProductionOrder).
-- p_input: {lines: [{line_id, quantity}]}
create function public.opr_issue(p_document_id uuid, p_input jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_o public.production_orders;
  v_p public.products;
  v_c public.products;
  v_line jsonb;
  v_l public.production_order_lines;
  v_issued jsonb := '{}';
  v_qty numeric;
  v_on_hand numeric;
  v_reserved numeric;
  v_warehouse public.warehouses;
  v_negative boolean;
  v_actor private.actor;
  v_unit_cost numeric;
  v_total_cost numeric;
  v_costs jsonb := '{}';
  v_total numeric;
  v_amounts jsonb;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PRODUCTION_ORDER');
  perform private.require_transition(v_doc, 'ISSUE');
  perform private.require_permission(v_doc.company_id, 'production_order.issue');
  for v_line in select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) as l loop
    select * into v_l from public.production_order_lines x
     where x.id::text = v_line ->> 'line_id' and x.document_id = v_doc.id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Uno de los materiales no es de la orden.');
    end if;
    if v_issued ? v_l.id::text then
      perform private.raise_business_error('DATO_INVALIDO', 'Un material está dos veces: indicá una sola cantidad.');
    end if;
    v_qty := (v_line ->> 'quantity')::numeric;
    if v_qty is null or v_qty < 0 or round(v_qty, 3) <> v_qty or v_qty >= 1000000 then
      perform private.raise_business_error('DATO_INVALIDO',
        'Las cantidades que se entregan deben ser números mayores o iguales que cero (hasta 3 decimales).');
    end if;
    v_issued := v_issued || jsonb_build_object(v_l.id::text, v_qty);
  end loop;
  if not exists (select 1 from jsonb_each_text(v_issued) as e where e.value::numeric > 0) then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá lo que sale de al menos un material.');
  end if;
  select * into v_o from public.production_orders o where o.document_id = v_doc.id;
  select * into v_warehouse from public.warehouses w where w.id = v_o.materials_warehouse_id;
  v_negative := coalesce((select (c.settings ->> 'allow_negative_stock')::boolean from public.companies c
                           where c.id = v_doc.company_id), false);
  if not v_negative then
    for v_l in select * from public.production_order_lines x where x.document_id = v_doc.id order by x.line_no loop
      v_qty := coalesce((v_issued ->> v_l.id::text)::numeric, 0);
      continue when v_qty <= 0;
      v_c := private.product_for(v_doc.company_id, v_l.product_id);
      v_on_hand := private.on_hand_quantity(v_c.id, v_warehouse.id);
      v_reserved := private.reserved_quantity(v_c.id, v_warehouse.id, v_doc.id);
      if v_qty > round(v_on_hand - v_reserved, 3) + 0.000000001 then
        perform private.raise_business_error('STOCK_INSUFICIENTE',
          format('%s: hay %s en %s%s: no alcanza para entregar %s.', v_c.code, private.format_qty(v_on_hand, v_c.uom_code),
                 v_warehouse.name,
                 case when v_reserved > 0
                   then format(' y %s están reservados para otras órdenes', private.format_qty(v_reserved, v_c.uom_code))
                   else '' end,
                 private.format_qty(v_qty, v_c.uom_code)));
      end if;
    end loop;
  end if;
  select * into v_p from public.products p where p.id = v_o.product_id;
  v_actor := private.transition_document(v_doc.id, 'ISSUE',
    p_summary => format('Entregó los materiales de %s para %s de %s', v_doc.display_number,
                        private.format_qty(v_o.quantity, v_p.uom_code), v_p.code));
  for v_l in select * from public.production_order_lines x where x.document_id = v_doc.id order by x.line_no loop
    v_qty := coalesce((v_issued ->> v_l.id::text)::numeric, 0);
    continue when v_qty <= 0;
    v_c := private.product_for(v_doc.company_id, v_l.product_id);
    perform private.post_stock_movement(v_doc.company_id, v_c.id, v_warehouse.id, 'CONSUMO_PRODUCCION', -v_qty, null,
      v_doc.id, v_l.id, private.business_date(v_doc.company_id));
    select m.unit_cost, m.total_cost into v_unit_cost, v_total_cost
      from public.stock_movements m
     where m.document_line_id = v_l.id and m.movement_type = 'CONSUMO_PRODUCCION'
     order by m.id desc
     limit 1;
    update public.production_order_lines set quantity_issued = v_qty, unit_cost = coalesce(v_unit_cost, 0) where id = v_l.id;
    v_costs := v_costs || jsonb_build_object(v_c.product_type,
      round(coalesce((v_costs ->> v_c.product_type)::numeric, 0) - coalesce(v_total_cost, 0), 2));
  end loop;
  update public.production_orders set issued_at = now() where document_id = v_doc.id;
  v_total := round(coalesce((select sum(e.value::numeric) from jsonb_each_text(v_costs) as e
                              where e.key in ('MATERIA_PRIMA', 'INSUMO') and e.value::numeric > 0), 0), 2);
  if v_total > 0 then
    -- Productos en proceso al debe; materias primas e insumos al haber (en el orden de los tipos).
    select jsonb_build_array(jsonb_build_object('key', 'PRODUCCION_EN_PROCESO', 'debit', v_total, 'credit', 0))
           || coalesce(jsonb_agg(jsonb_build_object('key', t.type, 'debit', 0, 'credit', (v_costs ->> t.type)::numeric)
                                 order by t.ord), '[]')
      into v_amounts
      from unnest(array['MATERIA_PRIMA', 'INSUMO']) with ordinality as t (type, ord)
     where coalesce((v_costs ->> t.type)::numeric, 0) > 0;
    perform private.post_event(v_actor, v_doc, 'CONSUMO_PRODUCCION',
      format('Consumo de materiales de %s (%s de %s %s).', v_doc.display_number,
             private.format_qty(v_o.quantity, v_p.uom_code), v_p.code, v_p.name),
      v_amounts);
  end if;
end;
$$;

-- Producción termina la orden: las unidades que salieron bien entran al stock a su
-- costo real (lo consumido dividido las unidades terminadas) y el costo pasa de
-- productos en proceso a productos terminados (cmdFinishProductionOrder).
create function public.opr_finish(p_document_id uuid, p_quantity numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_o public.production_orders;
  v_p public.products;
  v_warehouse public.warehouses;
  v_total numeric;
  v_unit_cost numeric;
  v_actor private.actor;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PRODUCTION_ORDER');
  perform private.require_transition(v_doc, 'FINISH');
  perform private.require_permission(v_doc.company_id, 'production_order.create');
  select * into v_o from public.production_orders o where o.document_id = v_doc.id;
  select * into v_p from public.products p where p.id = v_o.product_id;
  if p_quantity is null or p_quantity <= 0 or round(p_quantity, 3) <> p_quantity then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá las unidades que salieron bien: más de cero, con hasta 3 decimales.');
  end if;
  if p_quantity > v_o.quantity + 0.000000001 then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Se planificaron %s: no pueden salir más.', private.format_qty(v_o.quantity, v_p.uom_code)),
      'Si se fabricó de más, Producción carga otra orden.');
  end if;
  select * into v_warehouse from public.warehouses w where w.id = v_o.output_warehouse_id;
  v_total := private.production_material_cost(v_doc.id);
  v_unit_cost := round(v_total / p_quantity, 4);
  v_actor := private.transition_document(v_doc.id, 'FINISH',
    p_summary => format('Terminó %s: ingresaron %s de %s a %s por unidad', v_doc.display_number,
                        private.format_qty(p_quantity, v_p.uom_code), v_p.code, private.format_money(v_unit_cost)));
  perform private.post_stock_movement(v_doc.company_id, v_p.id, v_warehouse.id, 'INGRESO_PRODUCCION', p_quantity, v_unit_cost,
    v_doc.id, null, private.business_date(v_doc.company_id));
  update public.production_orders
     set quantity_produced = p_quantity, unit_cost = v_unit_cost, finished_at = now()
   where document_id = v_doc.id;
  if v_total > 0 then
    perform private.post_event(v_actor, v_doc, 'PRODUCCION_TERMINADA',
      format('Producción terminada de %s: %s de %s %s.', v_doc.display_number,
             private.format_qty(p_quantity, v_p.uom_code), v_p.code, v_p.name),
      jsonb_build_array(
        jsonb_build_object('key', 'PRODUCTO_TERMINADO', 'debit', v_total, 'credit', 0),
        jsonb_build_object('key', 'PRODUCCION_EN_PROCESO', 'debit', 0, 'credit', v_total)));
  end if;
  perform private.notify_roles(v_doc.company_id, array['VENTAS'], 'PRODUCCION_TERMINADA',
    format('Ingresaron %s de %s', private.format_qty(p_quantity, v_p.uom_code), v_p.code),
    format('Producción terminó %s: %s %s en %s.', v_doc.display_number, v_p.code, v_p.name, v_warehouse.name),
    private.doc_path(v_doc.id), v_doc.id, null, (v_actor).user_id);
end;
$$;

-- La planificada o la liberada se anulan sin más (se libera la reserva). La que
-- está en proceso devuelve los materiales al depósito al costo con que salieron,
-- con el contraasiento del consumo. Una terminada no se anula (cmdCancelProductionOrder).
create function public.opr_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
  v_o public.production_orders;
  v_warehouse public.warehouses;
  v_entry public.documents;
  v_reversal public.documents;
  v_l public.production_order_lines;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PRODUCTION_ORDER');
  if v_doc.status <> 'EN_PROCESO' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'production_order.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  select * into v_o from public.production_orders o where o.document_id = v_doc.id;
  select * into v_warehouse from public.warehouses w where w.id = v_o.materials_warehouse_id;
  v_entry := private.automatic_entry_of(v_doc.id);
  if v_entry.id is not null then
    v_reversal := private.reverse_journal_entry(v_entry, v_actor, format('%s anulada: %s', v_doc.display_number, v_comment), true);
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', v_comment, p_actor => v_actor,
    p_summary => format('Anuló %s: los materiales volvieron a %s%s — %s', v_doc.display_number, v_warehouse.name,
                        case when v_reversal.id is not null
                          then format(' y el contraasiento %s revirtió el consumo', v_reversal.display_number) else '' end,
                        v_comment));
  for v_l in select * from public.production_order_lines x where x.document_id = v_doc.id order by x.line_no loop
    continue when v_l.quantity_issued <= 0;
    perform private.post_stock_movement(v_doc.company_id, v_l.product_id, v_warehouse.id, 'DEVOLUCION_PRODUCCION',
      v_l.quantity_issued, v_l.unit_cost, v_doc.id, v_l.id, private.business_date(v_doc.company_id));
  end loop;
end;
$$;

grant execute on function public.opr_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.opr_release(uuid) to authenticated;
grant execute on function public.opr_issue(uuid, jsonb) to authenticated;
grant execute on function public.opr_finish(uuid, numeric) to authenticated;
grant execute on function public.opr_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas de producción

-- Los productos terminados y su lista de materiales, si tienen (listBoms).
create function public.boms_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'bom.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'product', jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'uom_code', p.uom_code,
                                           'is_active', p.is_active),
             'bom', case when b.id is not null
                      then jsonb_build_object('id', b.id, 'is_active', b.is_active, 'updated_at', b.updated_at) end,
             'components', (select count(*) from public.bom_lines l where l.bom_id = b.id),
             'material_cost', case when b.id is not null then private.bom_material_cost(b.id) else 0 end)
           order by p.code collate "C")
      from public.products p
      left join public.boms b on b.product_id = p.id
     where p.company_id = p_company_id and p.product_type = 'PRODUCTO_TERMINADO'
  ), '[]');
end;
$$;

-- La lista de materiales de un producto terminado, con el costo estimado de cada
-- componente; null si el código no es de un producto terminado (bomDetail).
create function public.bom_detail(p_company_id uuid, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p public.products;
  v_bom public.boms;
  v_lines jsonb;
begin
  perform private.require_read(p_company_id, 'bom.read');
  select * into v_p from public.products p
   where p.company_id = p_company_id and p.code = p_code and p.product_type = 'PRODUCTO_TERMINADO';
  if not found then
    return null;
  end if;
  select * into v_bom from public.boms b where b.product_id = v_p.id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_no', l.line_no,
           'component', jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name, 'uom_code', c.uom_code,
                                           'product_type', c.product_type),
           'quantity', l.quantity,
           'unit_cost', private.planned_unit_cost(c, c.default_warehouse_id),
           'line_cost', round(l.quantity * private.planned_unit_cost(c, c.default_warehouse_id), 2)) order by l.line_no), '[]')
    into v_lines
    from public.bom_lines l join public.products c on c.id = l.component_id
   where l.bom_id = v_bom.id;
  return jsonb_build_object(
    'product', jsonb_build_object('id', v_p.id, 'code', v_p.code, 'name', v_p.name, 'uom_code', v_p.uom_code,
                                  'is_active', v_p.is_active, 'standard_cost', v_p.standard_cost),
    'bom', case when v_bom.id is not null
             then jsonb_build_object('id', v_bom.id, 'notes', v_bom.notes, 'is_active', v_bom.is_active,
                                     'created_at', v_bom.created_at, 'updated_at', v_bom.updated_at) end,
    'lines', v_lines,
    'material_cost', round(coalesce((select sum((x ->> 'line_cost')::numeric) from jsonb_array_elements(v_lines) as x), 0), 2),
    'open_orders', (
      select count(*) from public.production_orders o join public.documents d on d.id = o.document_id
       where o.product_id = v_p.id and d.status in ('BORRADOR', 'LIBERADA', 'EN_PROCESO')));
end;
$$;

-- Lo que Producción puede planificar: los productos activos con lista activa, con
-- lo disponible de cada material en cada depósito (productionCatalog).
create function public.production_catalog(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'production_order.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'code', p.code, 'name', p.name, 'uom_code', p.uom_code,
             'default_warehouse_id', p.default_warehouse_id,
             'components', (
               select coalesce(jsonb_agg(jsonb_build_object(
                        'component', jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name, 'uom_code', c.uom_code,
                                                        'default_warehouse_id', c.default_warehouse_id),
                        'quantity', l.quantity,
                        'stock', private.availability_of(p_company_id, c.id)) order by l.line_no), '[]')
                 from public.bom_lines l join public.products c on c.id = l.component_id
                where l.bom_id = b.id))
           order by p.code collate "C")
      from public.products p join public.boms b on b.product_id = p.id and b.is_active
     where p.company_id = p_company_id and p.is_active
  ), '[]');
end;
$$;

grant execute on function public.boms_list(uuid) to authenticated;
grant execute on function public.bom_detail(uuid, text) to authenticated;
grant execute on function public.production_catalog(uuid) to authenticated;

-- ------------------------------------------------------------------ Empresas desde la plantilla: también las listas de materiales

-- Igual que antes, y además las listas de materiales, con los productos de la empresa nueva (mismo código).
create or replace function private.clone_company(p_template uuid, p_course uuid, p_slug text, p_owner uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_member uuid;
begin
  insert into public.companies (id, course_id, slug, legal_name, trade_name, tax_id, vat_condition, activity, address_line,
                                city, province, start_date, simulation_date, is_template, status, settings)
  select v_id, p_course, p_slug, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.activity, c.address_line,
         c.city, c.province, c.start_date, c.simulation_date, false, 'ACTIVA', c.settings
    from public.companies c where c.id = p_template;

  insert into public.islands (company_id, number, name)
  select v_id, i.number, i.name from public.islands i where i.company_id = p_template;
  insert into public.sectors (company_id, code, name, island_id)
  select v_id, s.code, s.name, ni.id
    from public.sectors s
    left join public.islands oi on oi.id = s.island_id
    left join public.islands ni on ni.company_id = v_id and ni.number = oi.number
   where s.company_id = p_template;
  insert into public.warehouses (company_id, code, name, is_active)
  select v_id, w.code, w.name, w.is_active from public.warehouses w where w.company_id = p_template;
  insert into public.company_modules (company_id, module_code, is_enabled)
  select v_id, m.module_code, m.is_enabled from public.company_modules m where m.company_id = p_template;
  insert into public.approval_rules (company_id, doc_type, level, min_amount, max_amount, approver_role,
                                     require_different_user, description, is_active)
  select v_id, r.doc_type, r.level, r.min_amount, r.max_amount, r.approver_role, r.require_different_user, r.description, r.is_active
    from public.approval_rules r where r.company_id = p_template;

  insert into public.suppliers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, lead_time_days, category, notes, is_active)
  select v_id, s.code, s.legal_name, s.trade_name, s.tax_id, s.vat_condition, s.address_line, s.city, s.province,
         s.phone, s.email, s.contact_name, s.payment_terms_days, s.lead_time_days, s.category, s.notes, s.is_active
    from public.suppliers s where s.company_id = p_template;
  insert into public.customers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, credit_limit, notes, is_active)
  select v_id, c.code, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.address_line, c.city, c.province,
         c.phone, c.email, c.contact_name, c.payment_terms_days, c.credit_limit, c.notes, c.is_active
    from public.customers c where c.company_id = p_template;
  -- El proveedor y el depósito habituales apuntan a los de la empresa nueva (mismo código).
  insert into public.products (company_id, code, name, description, category, product_type, uom_code, is_stockable,
                               standard_cost, sale_price, vat_rate, min_stock, reorder_qty, default_supplier_id,
                               default_warehouse_id, location, is_active)
  select v_id, p.code, p.name, p.description, p.category, p.product_type, p.uom_code, p.is_stockable,
         p.standard_cost, p.sale_price, p.vat_rate, p.min_stock, p.reorder_qty, ns.id, nw.id, p.location, p.is_active
    from public.products p
    left join public.suppliers os on os.id = p.default_supplier_id
    left join public.suppliers ns on ns.company_id = v_id and ns.code = os.code
    left join public.warehouses ow on ow.id = p.default_warehouse_id
    left join public.warehouses nw on nw.company_id = v_id and nw.code = ow.code
   where p.company_id = p_template;
  -- Las listas de materiales, con los productos de la empresa nueva.
  insert into public.boms (company_id, product_id, notes, is_active)
  select v_id, np.id, b.notes, b.is_active
    from public.boms b
    join public.products op on op.id = b.product_id
    join public.products np on np.company_id = v_id and np.code = op.code
   where b.company_id = p_template;
  insert into public.bom_lines (company_id, bom_id, line_no, component_id, quantity)
  select v_id, nb.id, l.line_no, nc.id, l.quantity
    from public.bom_lines l
    join public.boms ob on ob.id = l.bom_id
    join public.products op on op.id = ob.product_id
    join public.products np on np.company_id = v_id and np.code = op.code
    join public.boms nb on nb.company_id = v_id and nb.product_id = np.id
    join public.products oc on oc.id = l.component_id
    join public.products nc on nc.company_id = v_id and nc.code = oc.code
   where l.company_id = p_template;
  insert into public.accounts (company_id, code, name, account_type, normal_side, level, is_imputable, description, is_active)
  select v_id, a.code, a.name, a.account_type, a.normal_side, a.level, a.is_imputable, a.description, a.is_active
    from public.accounts a where a.company_id = p_template;
  insert into public.posting_rules (company_id, event, key, account_id)
  select v_id, r.event, r.key, na.id
    from public.posting_rules r
    join public.accounts oa on oa.id = r.account_id
    join public.accounts na on na.company_id = v_id and na.code = oa.code
   where r.company_id = p_template;

  if p_owner is not null then
    insert into public.company_members (company_id, user_id, job_title)
    values (v_id, p_owner, 'Docente a cargo') returning id into v_member;
    insert into public.member_roles (company_id, member_id, role_code) values (v_id, v_member, 'DOCENTE');
  end if;
  return v_id;
end;
$$;

-- ------------------------------------------------------------------ Documentos: la orden de producción en las lecturas comunes

-- Orden de producción: qué se fabrica, de qué depósito a cuál, y su costo previsto y real (productionOrderView).
create function private.production_order_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'product', jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'uom_code', p.uom_code),
    'quantity', o.quantity,
    'quantity_produced', o.quantity_produced,
    'materials_warehouse', jsonb_build_object('id', mw.id, 'code', mw.code, 'name', mw.name),
    'output_warehouse', jsonb_build_object('id', ow.id, 'code', ow.code, 'name', ow.name),
    'due_date', o.due_date,
    'released_at', o.released_at,
    'issued_at', o.issued_at,
    'finished_at', o.finished_at,
    'planned_cost', p_doc.subtotal,
    'material_cost', private.production_material_cost(p_doc.id),
    'unit_cost', o.unit_cost)
    from public.production_orders o
    join public.products p on p.id = o.product_id
    join public.warehouses mw on mw.id = o.materials_warehouse_id
    join public.warehouses ow on ow.id = o.output_warehouse_id
   where o.document_id = p_doc.id
$$;

-- Igual que antes, con la cabecera de la orden de producción (document_json).
create or replace function private.document_json(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(p_doc)
    || coalesce((
      select jsonb_build_object('pr', jsonb_build_object('needed_by', x.needed_by, 'priority', x.priority, 'reason', x.reason))
        from public.purchase_requisitions x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('po', jsonb_build_object(
               'expected_date', x.expected_date, 'warehouse_id', x.warehouse_id, 'payment_terms_days', x.payment_terms_days,
               'delivery_terms', x.delivery_terms, 'approved_at', x.approved_at, 'sent_at', x.sent_at))
        from public.purchase_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('gr', jsonb_build_object(
               'purchase_order_id', x.purchase_order_id, 'warehouse_id', x.warehouse_id,
               'supplier_delivery_note', x.supplier_delivery_note, 'carrier_name', x.carrier_name, 'received_at', x.received_at))
        from public.goods_receipts x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('sa', jsonb_build_object('warehouse_id', x.warehouse_id, 'reason_code', x.reason_code))
        from public.stock_adjustments x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('je', jsonb_build_object(
               'description', x.description, 'origin', x.origin, 'fiscal_year_id', x.fiscal_year_id,
               'entry_number', x.entry_number, 'posted_at', x.posted_at, 'reverses_id', x.reverses_id))
        from public.journal_entries x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('si', jsonb_build_object(
               'purchase_order_id', x.purchase_order_id, 'letter', x.letter, 'point_of_sale', x.point_of_sale,
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at))
        from public.supplier_invoices x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('op', jsonb_build_object(
               'treasury_account_id', x.treasury_account_id, 'payment_reference', x.payment_reference, 'paid_on', x.paid_on,
               'payment_method', x.payment_method))
        from public.payment_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rq', jsonb_build_object(
               'response_due', x.response_due, 'warehouse_id', x.warehouse_id, 'award_reason', x.award_reason))
        from public.rfqs x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('sq', jsonb_build_object(
               'rfq_id', x.rfq_id, 'supplier_reference', x.supplier_reference, 'valid_until', x.valid_until,
               'delivery_days', x.delivery_days, 'payment_terms_days', x.payment_terms_days))
        from public.supplier_quotes x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('ft', jsonb_build_object(
               'from_account_id', x.from_account_id, 'to_account_id', x.to_account_id, 'reference', x.reference,
               'transferred_on', x.transferred_on))
        from public.funds_transfers x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('br', jsonb_build_object(
               'account_id', x.account_id, 'statement_date', x.statement_date, 'statement_balance', x.statement_balance,
               'book_balance', x.book_balance, 'pending_debits', x.pending_debits, 'pending_credits', x.pending_credits))
        from public.bank_reconciliations x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('so', jsonb_build_object(
               'warehouse_id', x.warehouse_id, 'delivery_date', x.delivery_date, 'payment_terms_days', x.payment_terms_days,
               'customer_reference', x.customer_reference, 'credit_reason', x.credit_reason, 'confirmed_at', x.confirmed_at))
        from public.sales_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('dn', jsonb_build_object(
               'sales_order_id', x.sales_order_id, 'warehouse_id', x.warehouse_id, 'carrier_name', x.carrier_name,
               'dispatched_at', x.dispatched_at))
        from public.delivery_notes x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('fv', jsonb_build_object(
               'sales_order_id', x.sales_order_id, 'letter', x.letter, 'point_of_sale', x.point_of_sale,
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at))
        from public.sales_invoices x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rc', jsonb_build_object(
               'treasury_account_id', x.treasury_account_id, 'payment_method', x.payment_method, 'reference', x.reference,
               'received_on', x.received_on))
        from public.customer_receipts x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('qt', jsonb_build_object(
               'valid_until', x.valid_until, 'warehouse_id', x.warehouse_id, 'payment_terms_days', x.payment_terms_days,
               'customer_reference', x.customer_reference))
        from public.sales_quotes x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('pd', jsonb_build_object(
               'product_id', x.product_id, 'quantity', x.quantity, 'materials_warehouse_id', x.materials_warehouse_id,
               'output_warehouse_id', x.output_warehouse_id, 'due_date', x.due_date, 'quantity_produced', x.quantity_produced,
               'unit_cost', x.unit_cost, 'released_at', x.released_at, 'issued_at', x.issued_at, 'finished_at', x.finished_at))
        from public.production_orders x where x.document_id = p_doc.id), '{}')
$$;

-- Igual que antes, con la orden de producción: sus materiales y lo que fabrica.
create or replace function private.document_item(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select l.line_no, l.product_id from public.purchase_requisition_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.purchase_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.goods_receipt_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.stock_adjustment_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.supplier_invoice_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.rfq_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.supplier_quote_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.sales_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.delivery_note_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.sales_invoice_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.sales_quote_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.production_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.journal_entry_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.payment_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.customer_receipt_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.bank_reconciliation_lines l where l.document_id = p_doc.id
  ),
  codes as (
    select array_agg(p.code order by l.line_no) as list, count(*) as n
      from lines l join public.products p on p.id = l.product_id
  ),
  invoices as (
    select array_agg(d.display_number order by l.line_no) as list, count(*) as n
      from (
        select x.line_no, x.invoice_id from public.payment_order_lines x where x.document_id = p_doc.id
        union all
        select x.line_no, x.invoice_id from public.customer_receipt_lines x where x.document_id = p_doc.id
      ) as l
      join public.documents d on d.id = l.invoice_id
  )
  select private.document_json(p_doc) || jsonb_build_object(
    'status_info', private.status_info(p_doc.doc_type, p_doc.status),
    'supplier_name', coalesce((select s.legal_name from public.suppliers s where s.id = p_doc.supplier_id), ''),
    'customer_name', coalesce((select c.legal_name from public.customers c where c.id = p_doc.customer_id), ''),
    'sector_name', coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), '—'),
    'created_by_name', private.full_name(p_doc.created_by),
    'line_count', (select count(*) from lines),
    'summary', coalesce(
      (select je.description from public.journal_entries je where je.document_id = p_doc.id),
      case when p_doc.doc_type in ('PAYMENT_ORDER', 'CUSTOMER_RECEIPT') then
        (select coalesce(array_to_string(i.list[1:3], ', '), '') || case when i.n > 3 then format(' y %s más', i.n - 3) else '' end
           from invoices i)
      end,
      (select fa.name || ' → ' || ta.name
         from public.funds_transfers t
         join public.accounts fa on fa.id = t.from_account_id
         join public.accounts ta on ta.id = t.to_account_id
        where t.document_id = p_doc.id),
      (select a.name || ' al ' || to_char(r.statement_date, 'DD/MM/YYYY')
         from public.bank_reconciliations r join public.accounts a on a.id = r.account_id
        where r.document_id = p_doc.id),
      (select p.code || ' ' || p.name
         from public.production_orders o join public.products p on p.id = o.product_id
        where o.document_id = p_doc.id),
      (select coalesce(array_to_string(c.list[1:3], ', '), '') || case when c.n > 3 then format(' y %s más', c.n - 3) else '' end
         from codes c)),
    'pending_approver', (
      select r.name from public.approval_requests a join public.roles r on r.code = a.approver_role
       where a.document_id = p_doc.id and a.status = 'PENDIENTE'),
    'reference_label', (
      select string_agg(o.display_number, ', ' order by o.display_number collate "C")
        from public.document_links k join public.documents o on o.id = k.from_document_id
       where k.to_document_id = p_doc.id),
    'path', private.doc_path(p_doc.id)
  )
$$;

-- Igual que antes, con la orden de producción: los materiales que faltan, quién entrega y quién termina (nextStep).
create or replace function private.next_step(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sector text := coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), 'el sector solicitante');
  v_req public.approval_requests;
  v_rule text;
  v_loaded int;
  v_invited int;
  v_awarded public.documents;
  v_rfq_number text;
begin
  case p_doc.doc_type || ':' || p_doc.status
    when 'PURCHASE_REQUISITION:BORRADOR' then
      return jsonb_build_object('who', v_sector,
        'text', 'Completar los ítems, justificar la necesidad y enviar la solicitud a Compras.');
    when 'PURCHASE_REQUISITION:SOLICITADO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Debe pedir cotizaciones o incluir la solicitud en una orden de compra a un proveedor, o rechazarla indicando el motivo.');
    when 'PURCHASE_REQUISITION:ORDENADO_PARCIAL' then
      return jsonb_build_object('who', 'Compras', 'text', 'Resta ordenar el saldo pendiente o cerrarlo con motivo.');
    when 'PURCHASE_REQUISITION:ORDENADO' then
      return jsonb_build_object('who', 'Compras y Depósito',
        'text', 'La necesidad ya está cubierta por órdenes de compra. Seguí su avance en "Flujo documental".');
    when 'PURCHASE_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Revisar proveedor, precios, cantidades y fecha de entrega, y enviar la orden a aprobación.');
    when 'PURCHASE_ORDER:PENDIENTE_APROBACION' then
      select * into v_req from public.approval_requests a where a.document_id = p_doc.id and a.status = 'PENDIENTE';
      select r.description into v_rule from public.approval_rules r where r.id = v_req.rule_id;
      return jsonb_build_object(
        'who', coalesce((select ro.name from public.roles ro where ro.code = v_req.approver_role), 'Aprobador'),
        'text', trim(coalesce(v_rule, '') || ' Quien creó la orden no puede aprobarla: es un control de separación de funciones.'));
    when 'PURCHASE_ORDER:RECHAZADO' then
      return jsonb_build_object('who', 'Compras',
        'text', format('Motivo del rechazo: "%s". Reabrir, corregir y reenviar, o anular la orden.', p_doc.status_reason));
    when 'PURCHASE_ORDER:APROBADO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Comunicar la orden al proveedor (imprimirla o enviarla) y marcarla como enviada.');
    when 'PURCHASE_ORDER:ENVIADO' then
      return jsonb_build_object('who', 'Depósito',
        'text', 'Cuando llegue la mercadería, controlarla contra esta orden y el remito del proveedor, y registrar la recepción.');
    when 'PURCHASE_ORDER:RECIBIDO_PARCIAL' then
      return jsonb_build_object('who', 'Depósito o Compras',
        'text', 'Falta recibir el saldo. Si no va a llegar, Compras puede cerrar el saldo con motivo.');
    when 'PURCHASE_ORDER:RECIBIDO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Llegó todo lo pedido. Cuando llegue la factura del proveedor, se registra contra esta orden y lo recibido.');
    when 'GOODS_RECEIPT:BORRADOR' then
      return jsonb_build_object('who', 'Depósito',
        'text', 'Revisar cantidades contra el remito y confirmar la recepción para que ingrese al stock.');
    when 'GOODS_RECEIPT:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', 'La mercadería ingresó al stock (ver kardex). Compras y el solicitante fueron notificados.');
    when 'STOCK_ADJUSTMENT:BORRADOR' then
      return jsonb_build_object('who', 'Depósito', 'text', 'Revisar y confirmar el ajuste.');
    when 'STOCK_ADJUSTMENT:CONFIRMADO' then
      return jsonb_build_object('who', '—', 'text', 'El ajuste impactó en el stock y quedó documentado.');
    when 'SUPPLIER_INVOICE:BORRADOR' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Controlar el comprobante del proveedor contra la orden de compra y lo recibido, y registrar la factura.');
    when 'SUPPLIER_INVOICE:REGISTRADA', 'SUPPLIER_INVOICE:PAGADA_PARCIAL' then
      return jsonb_build_object('who', 'Contabilidad y Tesorería',
        'text', format('La deuda está en la cuenta corriente del proveedor y vence el %s. Se cancela con una orden de pago.',
                       (select to_char(si.due_date, 'DD/MM/YYYY') from public.supplier_invoices si where si.document_id = p_doc.id)));
    when 'PAYMENT_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Contabilidad o Tesorería',
        'text', 'Revisar las facturas, los importes y la caja o el banco, y enviar la orden a aprobación.');
    when 'PAYMENT_ORDER:PENDIENTE_APROBACION' then
      return jsonb_build_object('who', 'Gerencia',
        'text', 'Autorizar el pago o rechazarlo con motivo. Quien preparó la orden no puede aprobarla: es un control de separación de funciones.');
    when 'PAYMENT_ORDER:APROBADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar desde %s y registrar el pago: el asiento se genera solo. Quien registró una de las facturas no puede pagarla.',
                       coalesce((select a.code || ' ' || a.name from public.payment_orders po
                                   join public.accounts a on a.id = po.treasury_account_id
                                  where po.document_id = p_doc.id), 'la caja o el banco')));
    when 'PAYMENT_ORDER:PAGADA' then
      return jsonb_build_object('who', '—',
        'text', format('Se pagó el %s: la deuda bajó en la cuenta corriente del proveedor y el pago está en el libro diario.',
                       (select to_char(po.paid_on, 'DD/MM/YYYY') from public.payment_orders po where po.document_id = p_doc.id)));
    when 'PAYMENT_ORDER:RECHAZADA' then
      return jsonb_build_object('who', 'Contabilidad o Tesorería',
        'text', format('Motivo del rechazo: "%s". Si igual hay que pagar, se prepara otra orden.', p_doc.status_reason));
    when 'RFQ:BORRADOR' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Revisar los ítems, las cantidades y los proveedores invitados, y enviar la solicitud. Si algo está mal, se anula y se prepara otra.');
    when 'RFQ:ENVIADA' then
      select count(*) into v_loaded from private.rfq_quotes(p_doc.id);
      select count(*) into v_invited from public.rfq_suppliers s where s.document_id = p_doc.id;
      return jsonb_build_object('who', 'Compras', 'text', case when v_loaded > 0
        then format('Hay %s de %s cotizaciones cargadas. Compararlas en el cuadro y adjudicar: se genera la orden de compra en borrador. Si no es la más conveniente por precio, hay que justificar la elección.',
                    v_loaded, v_invited)
        else format('Mandar la solicitud impresa a cada proveedor invitado y cargar sus cotizaciones a medida que lleguen (responden hasta el %s).',
                    (select to_char(r.response_due, 'DD/MM/YYYY') from public.rfqs r where r.document_id = p_doc.id))
      end);
    when 'RFQ:ADJUDICADA' then
      select * into v_awarded from private.rfq_quotes(p_doc.id) q where q.status = 'ADJUDICADA' order by q.number limit 1;
      return jsonb_build_object('who', 'Compras',
        'text', format('Se adjudicó a %s (%s) y se generó %s: la compra sigue en esa orden.',
                       coalesce((select s.legal_name from public.suppliers s where s.id = v_awarded.supplier_id), '—'),
                       coalesce(v_awarded.display_number, '—'),
                       coalesce((select d.display_number from public.documents d where d.id = private.order_from_quote(v_awarded.id)),
                                'la orden de compra')));
    when 'SUPPLIER_QUOTE:RECIBIDA' then
      select r.display_number into v_rfq_number
        from public.supplier_quotes q join public.documents r on r.id = q.rfq_id where q.document_id = p_doc.id;
      return jsonb_build_object('who', 'Compras',
        'text', format('Participa del cuadro comparativo de %s. Se adjudica desde la solicitud; si se cargó mal, se anula y se carga de nuevo.',
                       coalesce(v_rfq_number, '—')));
    when 'SUPPLIER_QUOTE:ADJUDICADA' then
      select r.display_number into v_rfq_number
        from public.supplier_quotes q join public.documents r on r.id = q.rfq_id where q.document_id = p_doc.id;
      return jsonb_build_object('who', '—',
        'text', format('Fue la elegida en %s: de ella nació %s.', coalesce(v_rfq_number, '—'),
                       coalesce((select d.display_number from public.documents d where d.id = private.order_from_quote(p_doc.id)),
                                'la orden de compra')));
    when 'BANK_RECONCILIATION:CONFIRMADA' then
      return jsonb_build_object('who', '—',
        'text', (select format('Cierra con el extracto al %s. Lo pendiente (%s en pagos sin debitar y %s en entradas sin acreditar) se controla en la próxima conciliación.',
                               to_char(r.statement_date, 'DD/MM/YYYY'), private.format_money(r.pending_credits),
                               private.format_money(r.pending_debits))
                   from public.bank_reconciliations r where r.document_id = p_doc.id));
    when 'FUNDS_TRANSFER:BORRADOR' then
      return jsonb_build_object('who', 'Tesorería',
        'text', 'Revisar las cuentas y el importe, y confirmar la transferencia: se controla el saldo de la cuenta de origen y se genera el asiento.');
    when 'FUNDS_TRANSFER:CONFIRMADA' then
      return jsonb_build_object('who', '—',
        'text', (select format('Se transfirió el %s de %s a %s: el movimiento está en el libro diario y no cambia el total de los fondos.',
                               coalesce(to_char(t.transferred_on, 'DD/MM/YYYY'), '—'), fa.name, ta.name)
                   from public.funds_transfers t
                   join public.accounts fa on fa.id = t.from_account_id
                   join public.accounts ta on ta.id = t.to_account_id
                  where t.document_id = p_doc.id));
    when 'SALES_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Ventas',
        'text', 'Revisar el cliente, los ítems, los precios y el depósito, y confirmar el pedido: se controla el stock disponible y el crédito del cliente, y se reserva la mercadería.');
    when 'SALES_ORDER:PENDIENTE_APROBACION' then
      return jsonb_build_object('who', 'Gerencia',
        'text', trim(coalesce((select so.credit_reason from public.sales_orders so where so.document_id = p_doc.id), '')
                     || ' Autorizar el crédito o rechazar el pedido con motivo; mientras tanto, la mercadería queda reservada. Quien cargó el pedido no puede autorizarlo: es un control de separación de funciones.'));
    when 'SALES_ORDER:CONFIRMADO' then
      return jsonb_build_object('who', 'Depósito',
        'text', format('La mercadería está reservada en %s. Prepararla, cargar el remito y despacharlo.',
                       coalesce((select w.name from public.sales_orders so join public.warehouses w on w.id = so.warehouse_id
                                  where so.document_id = p_doc.id), 'el depósito')));
    when 'SALES_ORDER:ENTREGADO_PARCIAL' then
      return jsonb_build_object('who', 'Depósito o Ventas',
        'text', 'Falta entregar el saldo, que sigue reservado. Si no se va a entregar, Ventas puede cerrar el saldo con motivo.');
    when 'SALES_ORDER:ENTREGADO' then
      if private.uninvoiced_delivery(p_doc.id) then
        return jsonb_build_object('who', 'Ventas', 'text', 'Se entregó todo lo pedido: falta facturar lo entregado.');
      end if;
      return jsonb_build_object('who', '—',
        'text', 'Se entregó y se facturó todo lo pedido: la deuda está en la cuenta corriente del cliente.');
    when 'SALES_ORDER:CERRADO' then
      if private.uninvoiced_delivery(p_doc.id) then
        return jsonb_build_object('who', 'Ventas',
          'text', 'Se cerró con saldo sin entregar: falta facturar lo que sí se entregó.');
      end if;
      return jsonb_build_object('who', '—', 'text', coalesce((
        select s.description from public.document_statuses s where s.doc_type = 'SALES_ORDER' and s.code = 'CERRADO'), ''));
    when 'SALES_INVOICE:BORRADOR' then
      return jsonb_build_object('who', 'Ventas',
        'text', 'Revisar las cantidades contra lo entregado y registrar la factura: se le asigna el número y se generan el asiento de venta y la deuda del cliente.');
    when 'SALES_INVOICE:REGISTRADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('La deuda está en la cuenta corriente del cliente y vence el %s. Se cancela cuando el cliente paga, con un recibo de cobro.',
                       (select to_char(x.due_date, 'DD/MM/YYYY') from public.sales_invoices x where x.document_id = p_doc.id)));
    when 'SALES_INVOICE:COBRADA_PARCIAL' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('El cliente pagó una parte: quedan %s en su cuenta corriente (vence el %s). El saldo se cancela con otro recibo de cobro.',
                       private.format_money(private.sales_invoice_pending(p_doc.id)),
                       (select to_char(x.due_date, 'DD/MM/YYYY') from public.sales_invoices x where x.document_id = p_doc.id)));
    when 'PRODUCTION_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Producción', 'text', case when private.production_shortages(p_doc) is not null
        then format('Faltan materiales: %s. Pedíselos a Compras (o fabricá menos unidades) y liberá la orden cuando lleguen.',
                    private.production_shortages(p_doc))
        else 'Revisar el producto, la cantidad y los materiales, y liberar la orden: se controla que haya materiales y quedan reservados para Depósito.'
      end);
    when 'PRODUCTION_ORDER:LIBERADA' then
      return jsonb_build_object('who', 'Depósito',
        'text', format('Los materiales están reservados en %s. Prepararlos, entregárselos a Producción y registrar lo que sale de cada uno.',
                       coalesce((select w.name from public.production_orders o join public.warehouses w on w.id = o.materials_warehouse_id
                                  where o.document_id = p_doc.id), 'el depósito')));
    when 'PRODUCTION_ORDER:EN_PROCESO' then
      return jsonb_build_object('who', 'Producción',
        'text', 'Fabricar y, al terminar, registrar las unidades que salieron bien: entran al stock a su costo real.');
    when 'PRODUCTION_ORDER:TERMINADA' then
      return (
        select jsonb_build_object('who', '—',
          'text', format('Ingresaron %s de %s a %s por unidad (ver kardex): el costo pasó de productos en proceso a productos terminados.',
                         private.format_qty(coalesce(o.quantity_produced, 0), p.uom_code), p.code,
                         private.format_money(coalesce(o.unit_cost, 0))))
          from public.production_orders o join public.products p on p.id = o.product_id
         where o.document_id = p_doc.id);
    when 'SALES_QUOTE:BORRADOR' then
      return jsonb_build_object('who', 'Ventas', 'text', case when private.sales_quote_expired(p_doc)
        then format('Venció el %s: anularlo y, si hace falta, preparar otro con los precios del día.',
                    (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id))
        else 'Revisar los ítems, los precios y la validez, e imprimir el presupuesto para enviárselo al cliente.'
      end);
    when 'SALES_QUOTE:ENVIADO' then
      return jsonb_build_object('who', 'Ventas', 'text', case when private.sales_quote_expired(p_doc)
        then format('La oferta venció el %s: darlo por vencido y, si el cliente sigue interesado, preparar otro con los precios del día.',
                    (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id))
        else format('El cliente tiene hasta el %s para responder. Si acepta, se registra la aceptación y se genera el pedido de venta; si no, el rechazo con su motivo.',
                    (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id))
      end);
    when 'SALES_QUOTE:ACEPTADO' then
      return jsonb_build_object('who', 'Ventas',
        'text', format('El cliente lo aceptó: se generó %s en borrador. Ventas lo revisa y lo confirma: ahí se controlan el stock y el crédito.',
                       coalesce((private.order_from_sales_quote(p_doc.id)).display_number, 'el pedido de venta')));
    when 'SALES_QUOTE:RECHAZADO' then
      return jsonb_build_object('who', '—', 'text', format('Motivo del cliente: "%s".', p_doc.status_reason));
    when 'CUSTOMER_RECEIPT:BORRADOR' then
      return jsonb_build_object('who', 'Tesorería',
        'text', 'Revisar las facturas, los importes, el medio de cobro y la caja o el banco, y confirmar el cobro: se genera el asiento y baja la deuda del cliente. Quien emitió una de las facturas no puede registrar su cobro.');
    when 'CUSTOMER_RECEIPT:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', (select format('Se cobró el %s: la deuda bajó en la cuenta corriente del cliente y el cobro está en el libro diario.%s',
                               coalesce(to_char(x.received_on, 'DD/MM/YYYY'), '—'),
                               case when x.payment_method = 'CHEQUE'
                                 then ' Para depositar el cheque en el banco, Tesorería prepara una transferencia entre cuentas.' else '' end)
                   from public.customer_receipts x where x.document_id = p_doc.id));
    when 'SALES_ORDER:RECHAZADO' then
      return jsonb_build_object('who', 'Ventas',
        'text', format('Motivo del rechazo: "%s". Si el cliente achica el pedido o paga lo que debe, se carga otro.', p_doc.status_reason));
    when 'DELIVERY_NOTE:BORRADOR' then
      return jsonb_build_object('who', 'Depósito',
        'text', 'Preparar la mercadería, controlarla contra el remito y despacharlo: baja el stock, se libera la reserva y se registra el costo de lo vendido.');
    when 'DELIVERY_NOTE:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', 'La mercadería salió: bajó el stock (ver kardex), el costo de lo vendido está en el libro diario y Ventas fue notificada.');
    when 'JOURNAL_ENTRY:BORRADOR' then
      return jsonb_build_object('who', 'Contabilidad',
        'text', 'Revisar que las cuentas sean las correctas y que el debe y el haber sumen lo mismo, y registrar el asiento en el libro diario.');
    when 'JOURNAL_ENTRY:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', format('Está en el libro diario con el N.º %s. Si tiene un error, no se corrige: se anula con un contraasiento y se registra el asiento correcto.',
                       (select je.entry_number from public.journal_entries je where je.document_id = p_doc.id)));
    else
      return jsonb_build_object('who', '—', 'text', coalesce((
        select s.description from public.document_statuses s where s.doc_type = p_doc.doc_type and s.code = p_doc.status), ''));
  end case;
end;
$$;

-- Igual que antes, con la orden de producción: sus materiales, su vista, su lugar en el flujo y sus firmas.
create or replace function private.document_detail(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lines jsonb;
  v_warehouse uuid;
  v_order public.documents;
begin
  case p_doc.doc_type
    when 'PURCHASE_REQUISITION' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'qty_ordered', l.qty_ordered) order by l.line_no)
        into v_lines
        from public.purchase_requisition_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    when 'PURCHASE_ORDER' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax,
               'line_total', l.line_total, 'qty_received', l.qty_received, 'requisition_label', rd.display_number,
               'requisition_line_id', l.requisition_line_id,
               'requisition_max', case when rl.id is not null then rl.quantity - rl.qty_ordered + l.quantity end) order by l.line_no)
        into v_lines
        from public.purchase_order_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_requisition_lines rl on rl.id = l.requisition_line_id
        left join public.documents rd on rd.id = rl.document_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.purchase_orders x where x.document_id = p_doc.id;
    when 'GOODS_RECEIPT' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'po_line_id', l.po_line_id, 'qty_ordered_po', pl.quantity, 'qty_received', pl.qty_received,
               'unit_cost', l.unit_cost) order by l.line_no)
        into v_lines
        from public.goods_receipt_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_order_lines pl on pl.id = l.po_line_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.goods_receipts x where x.document_id = p_doc.id;
      select d.* into v_order from public.goods_receipts x join public.documents d on d.id = x.purchase_order_id
       where x.document_id = p_doc.id;
    when 'STOCK_ADJUSTMENT' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity_delta, 'notes', l.notes,
               'unit_cost', l.unit_cost) order by l.line_no)
        into v_lines
        from public.stock_adjustment_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.stock_adjustments x where x.document_id = p_doc.id;
    when 'SUPPLIER_INVOICE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'po_line_id', l.po_line_id, 'qty_ordered_po', pl.quantity, 'qty_received', pl.qty_received,
               'unit_price', l.unit_price, 'order_unit_price', pl.unit_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.supplier_invoice_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_order_lines pl on pl.id = l.po_line_id
       where l.document_id = p_doc.id;
      select d.* into v_order from public.supplier_invoices x join public.documents d on d.id = x.purchase_order_id
       where x.document_id = p_doc.id;
    when 'RFQ' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'requisition_label', rd.display_number, 'requisition_line_id', l.requisition_line_id) order by l.line_no)
        into v_lines
        from public.rfq_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_requisition_lines rl on rl.id = l.requisition_line_id
        left join public.documents rd on rd.id = rl.document_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.rfqs x where x.document_id = p_doc.id;
    when 'SUPPLIER_QUOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax,
               'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.supplier_quote_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    when 'SALES_ORDER' then
      select x.warehouse_id into v_warehouse from public.sales_orders x where x.document_id = p_doc.id;
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'list_price', l.list_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total,
               'qty_delivered', l.qty_delivered, 'qty_invoiced', private.sales_invoiced_quantity(l.id),
               'qty_available', case when p.is_stockable then
                 round(private.on_hand_quantity(p.id, v_warehouse) - private.reserved_quantity(p.id, v_warehouse, p_doc.id), 3)
               end) order by l.line_no)
        into v_lines
        from public.sales_order_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    when 'DELIVERY_NOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'so_line_id', l.so_line_id, 'qty_ordered_so', sl.quantity, 'qty_delivered', sl.qty_delivered,
               'unit_price', sl.unit_price, 'unit_cost', l.unit_cost) order by l.line_no)
        into v_lines
        from public.delivery_note_lines l
        join public.products p on p.id = l.product_id
        join public.sales_order_lines sl on sl.id = l.so_line_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.delivery_notes x where x.document_id = p_doc.id;
      select d.* into v_order from public.delivery_notes x join public.documents d on d.id = x.sales_order_id
       where x.document_id = p_doc.id;
    when 'SALES_INVOICE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'so_line_id', l.so_line_id, 'qty_ordered_so', sl.quantity, 'qty_delivered', sl.qty_delivered,
               'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal,
               'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.sales_invoice_lines l
        join public.products p on p.id = l.product_id
        join public.sales_order_lines sl on sl.id = l.so_line_id
       where l.document_id = p_doc.id;
      select d.* into v_order from public.sales_invoices x join public.documents d on d.id = x.sales_order_id
       where x.document_id = p_doc.id;
    when 'SALES_QUOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'list_price', l.list_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.sales_quote_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.sales_quotes x where x.document_id = p_doc.id;
    when 'PRODUCTION_ORDER' then
      select x.materials_warehouse_id into v_warehouse from public.production_orders x where x.document_id = p_doc.id;
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity_planned, 'notes', '',
               'planned_unit_cost', l.planned_unit_cost, 'qty_issued', l.quantity_issued, 'unit_cost', l.unit_cost,
               -- Mientras no se entregó: lo disponible en el depósito, sin lo reservado para otros.
               'qty_available', case when p_doc.status in ('BORRADOR', 'LIBERADA') then
                 round(private.on_hand_quantity(p.id, v_warehouse) - private.reserved_quantity(p.id, v_warehouse, p_doc.id), 3)
               end) order by l.line_no)
        into v_lines
        from public.production_order_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    else
      v_lines := null;
  end case;

  return jsonb_build_object(
    'doc', private.document_item(p_doc),
    'lines', coalesce(v_lines, '[]'),
    'journal', case when p_doc.doc_type = 'JOURNAL_ENTRY' then private.journal_view(p_doc) end,
    'payment', case when p_doc.doc_type = 'PAYMENT_ORDER' then private.payment_view(p_doc) end,
    'receipt', case when p_doc.doc_type = 'CUSTOMER_RECEIPT' then private.receipt_view(p_doc) end,
    'rfq', case when p_doc.doc_type = 'RFQ' then private.rfq_view(p_doc) end,
    'quote', case when p_doc.doc_type = 'SUPPLIER_QUOTE' then private.quote_view(p_doc) end,
    'transfer', case when p_doc.doc_type = 'FUNDS_TRANSFER' then private.transfer_view(p_doc) end,
    'reconciliation', case when p_doc.doc_type = 'BANK_RECONCILIATION' then private.reconciliation_view(p_doc) end,
    'sales_order', case when p_doc.doc_type = 'SALES_ORDER' then private.sales_order_view(p_doc) end,
    'sales_quote', case when p_doc.doc_type = 'SALES_QUOTE' then private.sales_quote_view(p_doc) end,
    'production_order', case when p_doc.doc_type = 'PRODUCTION_ORDER' then private.production_order_view(p_doc) end,
    'delivery', case when p_doc.doc_type = 'DELIVERY_NOTE' then private.delivery_view(p_doc) end,
    'supplier', (select to_jsonb(s) from public.suppliers s where s.id = p_doc.supplier_id),
    'customer', (select to_jsonb(c) from public.customers c where c.id = p_doc.customer_id),
    'warehouse', (select to_jsonb(w) from public.warehouses w where w.id = v_warehouse),
    'related_order', case when v_order.id is not null then private.document_item(v_order) end,
    'approvals', coalesce((
      select jsonb_agg(to_jsonb(a) || jsonb_build_object(
               'approver_role_name', r.name,
               'decided_by_name', case when a.decided_by is not null then private.full_name(a.decided_by) else '' end,
               'requested_by_name', private.full_name(a.requested_by)) order by a.requested_at)
        from public.approval_requests a join public.roles r on r.code = a.approver_role
       where a.document_id = p_doc.id
    ), '[]'),
    'flow', (
      with recursive flow (id) as (
        select p_doc.id
        union
        select case when l.from_document_id = f.id then l.to_document_id else l.from_document_id end
          from flow f join public.document_links l on f.id in (l.from_document_id, l.to_document_id)
      )
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'doc_type', d.doc_type, 'display_number', d.display_number,
               'status_info', private.status_info(d.doc_type, d.status), 'path', private.doc_path(d.id),
               'current', d.id = p_doc.id, 'readable', d.doc_type = any (private.readable_doc_types(p_doc.company_id)),
               'date', d.created_at)
             order by array_position(
                        array['PURCHASE_REQUISITION', 'RFQ', 'SUPPLIER_QUOTE', 'PURCHASE_ORDER', 'GOODS_RECEIPT',
                              'SUPPLIER_INVOICE', 'PAYMENT_ORDER', 'FUNDS_TRANSFER', 'BANK_RECONCILIATION', 'SALES_QUOTE', 'SALES_ORDER',
                              'DELIVERY_NOTE', 'SALES_INVOICE', 'CUSTOMER_RECEIPT', 'PRODUCTION_ORDER', 'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
                        d.doc_type),
                      d.number)
        from flow f join public.documents d on d.id = f.id
    ),
    'history', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.id) from public.audit_events e where e.document_id = p_doc.id
    ), '[]'),
    'actions', private.available_actions(p_doc),
    'next_step', private.next_step(p_doc),
    'signatures', case p_doc.doc_type
      when 'PURCHASE_REQUISITION' then jsonb_build_array(
        private.signature(p_doc.id, 'Solicitó', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Atendió (Compras)', array['SYSTEM']))
      when 'PURCHASE_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Emitió', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Autorizó', array['APPROVE']))
      when 'JOURNAL_ENTRY' then jsonb_build_array(
        private.signature(p_doc.id, 'Registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Revisó', 'name', '', 'sector', '', 'at', ''))
      when 'SUPPLIER_INVOICE' then jsonb_build_array(
        private.signature(p_doc.id, 'Registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
      when 'PAYMENT_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Autorizó', array['APPROVE']),
        private.signature(p_doc.id, 'Pagó', array['PAY']))
      when 'RFQ' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Adjudicó', array['AWARD']))
      when 'SUPPLIER_QUOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Cargó', array['CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
      when 'FUNDS_TRANSFER' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        private.signature(p_doc.id, 'Confirmó', array['CONFIRM']))
      when 'BANK_RECONCILIATION' then jsonb_build_array(
        private.signature(p_doc.id, 'Concilió', array['CREATE']),
        jsonb_build_object('label', 'Revisó', 'name', '', 'sector', '', 'at', ''))
      when 'SALES_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Vendió', array['CONFIRM', 'CREATE']),
        private.signature(p_doc.id, 'Autorizó el crédito', array['APPROVE']))
      when 'DELIVERY_NOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Despachó', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Recibió conforme (cliente)', 'name', '', 'sector', '', 'at', ''))
      when 'SALES_INVOICE' then jsonb_build_array(
        private.signature(p_doc.id, 'Emitió', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
      when 'CUSTOMER_RECEIPT' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        private.signature(p_doc.id, 'Cobró', array['CONFIRM']))
      when 'SALES_QUOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        jsonb_build_object('label', 'Conformidad del cliente', 'name', '', 'sector', '', 'at', ''))
      when 'PRODUCTION_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Planificó', array['CREATE']),
        private.signature(p_doc.id, 'Entregó los materiales', array['ISSUE']),
        private.signature(p_doc.id, 'Terminó', array['FINISH']))
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

-- Igual que antes, con la orden de producción: no se libera si faltan materiales.
create or replace function private.available_actions(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_supervisor boolean := private.is_supervisor(p_doc.company_id);
  v_roles text[] := array(select private.my_role_codes(p_doc.company_id));
  v_sod boolean := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = p_doc.company_id), false);
  v_req public.approval_requests;
  v_tr public.document_transitions;
  v_reason text;
  v_account public.accounts;
  v_balance numeric;
  v_last public.documents;
  v_order public.documents;
  v_result jsonb := '[]';
begin
  select * into v_req from public.approval_requests a where a.document_id = p_doc.id and a.status = 'PENDIENTE';
  for v_tr in
    select * from public.document_transitions t
     where t.doc_type = p_doc.doc_type and t.from_status = p_doc.status and t.action <> 'SYSTEM'
     order by t.sort
  loop
    continue when v_tr.permission_code is null or not private.has_permission(p_doc.company_id, v_tr.permission_code);
    continue when v_result @> jsonb_build_array(jsonb_build_object('action', v_tr.action));
    v_reason := null;
    if p_doc.doc_type = 'PURCHASE_ORDER' and v_tr.action in ('APPROVE', 'REJECT') then
      if v_req.id is not null and not v_supervisor and not (v_req.approver_role = any (v_roles)) then
        v_reason := format('Por el monto (%s) la aprueba %s.', private.format_money(v_req.amount),
                           (select r.name from public.roles r where r.code = v_req.approver_role));
      elsif not v_supervisor and v_sod and p_doc.created_by = v_uid then
        v_reason := 'Separación de funciones: no podés aprobar ni rechazar una orden que creaste vos.';
      end if;
    end if;
    if p_doc.doc_type = 'PURCHASE_ORDER' and v_tr.action = 'WITHDRAW' and not v_supervisor
       and p_doc.created_by is distinct from v_uid then
      v_reason := 'Sólo quien creó la orden puede retirarla.';
    end if;
    if p_doc.doc_type = 'PURCHASE_ORDER' and v_tr.action = 'CANCEL'
       and exists (select 1 from public.purchase_order_lines l where l.document_id = p_doc.id and l.qty_received > 0) then
      v_reason := 'Tiene recepciones: usá "Cerrar saldo".';
    end if;
    if p_doc.doc_type = 'PURCHASE_REQUISITION' and v_tr.action in ('SUBMIT', 'CANCEL') and not v_supervisor
       and p_doc.created_by is distinct from v_uid
       and (p_doc.sector_id is null or not exists (
         select 1 from public.company_members m join public.member_roles mr on mr.member_id = m.id
          where m.company_id = p_doc.company_id and m.user_id = v_uid and mr.sector_id = p_doc.sector_id)) then
      v_reason := 'Sólo el sector solicitante puede hacerlo.';
    end if;
    if p_doc.doc_type = 'GOODS_RECEIPT' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' and v_sod
       and not v_supervisor and not ('GERENCIA' = any (v_roles)) and p_doc.created_by = v_uid then
      v_reason := 'Separación de funciones: otro integrante de Depósito o Gerencia debe anularla.';
    end if;
    if p_doc.doc_type = 'JOURNAL_ENTRY' and v_tr.action = 'CANCEL'
       and exists (select 1 from public.journal_entries je where je.document_id = p_doc.id and je.origin = 'CONTRAASIENTO') then
      v_reason := 'Un contraasiento no se anula. Si hubo un error, registrá el asiento correcto.';
    end if;
    if p_doc.doc_type = 'PAYMENT_ORDER' and v_tr.action in ('APPROVE', 'REJECT') and not v_supervisor and v_sod
       and p_doc.created_by = v_uid then
      v_reason := 'Separación de funciones: no podés aprobar ni rechazar una orden de pago que preparaste vos.';
    end if;
    if p_doc.doc_type = 'PAYMENT_ORDER' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and exists (select 1 from public.payment_order_lines l
                    where l.document_id = p_doc.id and private.invoice_registrant(l.invoice_id) = v_uid) then
      v_reason := 'Separación de funciones: registraste una de las facturas; tiene que pagarla otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'RFQ' and v_tr.action = 'AWARD'
       and not exists (select 1 from private.rfq_quotes(p_doc.id) q where private.quote_is_valid(q.id)) then
      v_reason := 'Todavía no hay cotizaciones vigentes para adjudicar.';
    end if;
    if p_doc.doc_type = 'FUNDS_TRANSFER' and v_tr.action = 'CONFIRM' then
      select a.* into v_account from public.funds_transfers t join public.accounts a on a.id = t.from_account_id
       where t.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('No alcanza el saldo de %s %s: hay %s.', v_account.code, v_account.name, private.format_money(v_balance));
      end if;
    end if;
    if p_doc.doc_type = 'FUNDS_TRANSFER' and p_doc.status = 'CONFIRMADA' and v_tr.action = 'CANCEL' then
      select a.* into v_account from public.funds_transfers t join public.accounts a on a.id = t.to_account_id
       where t.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('Los fondos ya se usaron: en %s %s hay %s. Para devolverlos, prepará otra transferencia.',
                           v_account.code, v_account.name, private.format_money(v_balance));
      end if;
    end if;
    if p_doc.doc_type = 'BANK_RECONCILIATION' and v_tr.action = 'CANCEL' then
      v_last := private.last_reconciliation((select r.account_id from public.bank_reconciliations r where r.document_id = p_doc.id));
      if v_last.id is not null and v_last.id <> p_doc.id then
        v_reason := format('Sólo se anula la última conciliación de la cuenta (%s).', v_last.display_number);
      end if;
    end if;
    if p_doc.doc_type = 'SALES_ORDER' then
      v_reason := coalesce(private.sales_order_action_reason(p_doc, v_tr.action), v_reason);
    end if;
    if p_doc.doc_type = 'PRODUCTION_ORDER' and v_tr.action = 'RELEASE' and private.production_shortages(p_doc) is not null then
      v_reason := format('Faltan materiales: %s.', private.production_shortages(p_doc));
    end if;
    if p_doc.doc_type = 'SALES_QUOTE' then
      if v_tr.action in ('SEND', 'CONFIRM') and private.sales_quote_expired(p_doc) then
        v_reason := format('La oferta venció el %s: prepará otro presupuesto con los precios del día.',
                           (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id));
      end if;
      if v_tr.action = 'CLOSE' and not private.sales_quote_expired(p_doc) then
        v_reason := format('Vale hasta el %s: todavía no venció.',
                           (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id));
      end if;
    end if;
    if p_doc.doc_type = 'CUSTOMER_RECEIPT' and v_tr.action = 'CONFIRM' and not v_supervisor and v_sod
       and exists (select 1 from public.customer_receipt_lines l
                    where l.document_id = p_doc.id and private.invoice_registrant(l.invoice_id) = v_uid) then
      v_reason := 'Separación de funciones: emitiste una de las facturas; tiene que cobrarla otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'CUSTOMER_RECEIPT' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' then
      select a.* into v_account from public.customer_receipts x join public.accounts a on a.id = x.treasury_account_id
       where x.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('Los fondos ya se usaron: en %s %s hay %s. Primero hay que anular el movimiento que los usó.',
                           v_account.code, v_account.name, private.format_money(v_balance));
      end if;
    end if;
    if p_doc.doc_type = 'DELIVERY_NOTE' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' then
      select d.* into v_order from public.delivery_notes x join public.documents d on d.id = x.sales_order_id
       where x.document_id = p_doc.id;
      if v_sod and not v_supervisor and not ('GERENCIA' = any (v_roles)) and private.invoice_registrant(p_doc.id) = v_uid then
        v_reason := 'Separación de funciones: otro integrante de Depósito o Gerencia debe anularlo.';
      elsif v_order.status = 'CERRADO' then
        v_reason := format('%s está cerrado: ya no se anula el remito.', v_order.display_number);
      end if;
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'action', v_tr.action, 'label', v_tr.label, 'help', v_tr.help_text, 'tone', v_tr.tone,
      'requires_comment', v_tr.requires_comment, 'enabled', v_reason is null, 'reason', v_reason));
  end loop;
  return v_result;
end;
$$;
