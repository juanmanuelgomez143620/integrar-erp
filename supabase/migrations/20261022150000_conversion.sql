-- 44. Fase 5b (docs/FASE_5_PRODUCCION_Y_COSTOS.md §4): centros de trabajo con
-- sus tarifas de mano de obra directa y de carga fabril por hora, horas por
-- unidad en cada lista de materiales, y la conversión aplicada al terminar la
-- orden (horas reales × tarifas de la orden), con su asiento y el costo previsto
-- contra el real. Traducción de las secciones "Centros de trabajo" y de los
-- cambios en "Listas de materiales" y "Órdenes de producción" de
-- src/lib/mock/engine.ts y de sus lecturas en queries.ts.
--
-- Los permisos y la clave de imputación están en la migración de catálogos
-- siguiente; las cuentas, los centros y las horas de la demo, en la de la plantilla.

-- ------------------------------------------------------------------ Tablas

-- Centro de trabajo: un sector del taller con sus tarifas por hora, predeterminadas.
create table public.work_centers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  name text not null check (length(name) between 2 and 60),
  labor_rate numeric(14, 2) not null check (labor_rate >= 0),       -- mano de obra directa por hora
  overhead_rate numeric(14, 2) not null check (overhead_rate >= 0), -- carga fabril por hora
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id)
);

-- Las horas que lleva cada unidad en un centro de trabajo: la ruta simplificada.
create table public.bom_operations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  bom_id uuid not null,
  line_no int not null,
  work_center_id uuid not null,
  hours numeric(14, 3) not null check (hours > 0),
  unique (bom_id, line_no),
  unique (company_id, id),
  foreign key (company_id, bom_id) references public.boms (company_id, id) on delete cascade,
  foreign key (company_id, work_center_id) references public.work_centers (company_id, id)
);
create index bom_operations_center_idx on public.bom_operations (work_center_id);

-- Las horas de la orden en cada centro: previstas, con las tarifas de ese momento, y reales.
create table public.production_order_operations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  work_center_id uuid not null,
  hours_planned numeric(14, 3) not null check (hours_planned > 0),
  labor_rate numeric(14, 2) not null,
  overhead_rate numeric(14, 2) not null,
  hours_actual numeric(14, 3) check (hours_actual >= 0),           -- al terminarla
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.production_orders (company_id, document_id) on delete cascade,
  foreign key (company_id, work_center_id) references public.work_centers (company_id, id)
);
create index production_order_operations_center_idx on public.production_order_operations (work_center_id);

create trigger work_centers_audit before insert or update on public.work_centers
  for each row execute function private.set_audit_fields();

do $$
declare
  t text;
begin
  foreach t in array array['work_centers', 'bom_operations', 'production_order_operations'] loop
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

create policy work_centers_select on public.work_centers for select to authenticated
  using (company_id in (select private.companies_with_permission('work_center.read')));
create policy bom_operations_select on public.bom_operations for select to authenticated
  using (company_id in (select private.companies_with_permission('bom.read')));
create policy production_order_operations_select on public.production_order_operations for select to authenticated
  using (company_id in (select private.companies_with_permission('production_order.read')));

-- ------------------------------------------------------------------ Auxiliares

-- "CORTE Corte y cepillado" (workCenterLabel).
create function private.work_center_label(p_center public.work_centers)
returns text
language sql
immutable
set search_path = ''
as $$ select p_center.code || ' ' || p_center.name $$;

-- El costo de unas horas en un centro: mano de obra y carga fabril, cada una con 2 decimales (conversionCost).
create function private.conversion_cost(p_hours numeric, p_labor numeric, p_overhead numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$ select round(round(p_hours * p_labor, 2) + round(p_hours * p_overhead, 2), 2) $$;

-- Costo estimado de la conversión de una unidad: horas × tarifas actuales de cada centro (bomConversionCost).
create function private.bom_conversion_cost(p_bom uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(private.conversion_cost(o.hours, w.labor_rate, w.overhead_rate)), 0), 2)
    from public.bom_operations o join public.work_centers w on w.id = o.work_center_id
   where o.bom_id = p_bom
$$;

-- Lo que se aplicó de mano de obra y de carga fabril a una orden, con las horas
-- reales o, si no, las previstas (productionConversion).
create function private.production_labor_cost(p_doc uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(round(coalesce(o.hours_actual, o.hours_planned) * o.labor_rate, 2)), 0), 2)
    from public.production_order_operations o where o.document_id = p_doc
$$;

create function private.production_overhead_cost(p_doc uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(round(coalesce(o.hours_actual, o.hours_planned) * o.overhead_rate, 2)), 0), 2)
    from public.production_order_operations o where o.document_id = p_doc
$$;

-- ------------------------------------------------------------------ Centros de trabajo: comandos

-- Crea o modifica un centro de trabajo; las órdenes ya cargadas conservan las
-- tarifas con que se planificaron (cmdSaveWorkCenter).
-- p_input: {id ('' si es nuevo), code, name, labor_rate, overhead_rate}
create function public.work_center_save(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'work_center.update');
  v_id text := coalesce(p_input ->> 'id', '');
  v_existing public.work_centers;
  v_code text := upper(trim(coalesce(p_input ->> 'code', '')));
  v_name text := trim(coalesce(p_input ->> 'name', ''));
  v_labor numeric := (p_input ->> 'labor_rate')::numeric;
  v_overhead numeric := (p_input ->> 'overhead_rate')::numeric;
  v_center public.work_centers;
  v_changes jsonb;
begin
  if v_id <> '' then
    select * into v_existing from public.work_centers w where w.id::text = v_id and w.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'El centro de trabajo no existe.');
    end if;
  end if;
  if v_code !~ '^[A-Z0-9-]{1,12}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El código del centro tiene de 1 a 12 letras, números o guiones.');
  end if;
  if exists (select 1 from public.work_centers w
              where w.company_id = p_company_id and w.code = v_code and w.id is distinct from v_existing.id) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe un centro de trabajo con el código %s.', v_code));
  end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'El nombre del centro tiene de 2 a 60 caracteres.');
  end if;
  if v_labor is null or v_labor < 0 or round(v_labor, 2) <> v_labor or v_labor >= 1000000000 then
    perform private.raise_business_error('DATO_INVALIDO',
      'La tarifa de mano de obra por hora debe ser un importe mayor o igual que cero, con hasta 2 decimales.');
  end if;
  if v_overhead is null or v_overhead < 0 or round(v_overhead, 2) <> v_overhead or v_overhead >= 1000000000 then
    perform private.raise_business_error('DATO_INVALIDO',
      'La tasa de carga fabril por hora debe ser un importe mayor o igual que cero, con hasta 2 decimales.');
  end if;
  if v_existing.id is not null then
    v_changes := private.diff(to_jsonb(v_existing),
      to_jsonb(v_existing) || jsonb_build_object('code', v_code, 'name', v_name, 'labor_rate', v_labor, 'overhead_rate', v_overhead),
      array['code', 'name', 'labor_rate', 'overhead_rate']);
    if v_changes = '{}'::jsonb then
      return jsonb_build_object('id', v_existing.id);
    end if;
    update public.work_centers
       set code = v_code, name = v_name, labor_rate = v_labor, overhead_rate = v_overhead
     where id = v_existing.id
    returning * into v_center;
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'work_center', v_center.id, private.work_center_label(v_center),
      format('Modificó el centro de trabajo %s', private.work_center_label(v_center)), null, null, null, v_changes);
    return jsonb_build_object('id', v_center.id);
  end if;
  insert into public.work_centers (company_id, code, name, labor_rate, overhead_rate)
  values (p_company_id, v_code, v_name, v_labor, v_overhead)
  returning * into v_center;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'work_center', v_center.id, private.work_center_label(v_center),
    format('Creó el centro de trabajo %s: %s de mano de obra y %s de carga fabril por hora', private.work_center_label(v_center),
           private.format_money(v_labor), private.format_money(v_overhead)));
  return jsonb_build_object('id', v_center.id);
end;
$$;

-- Un centro desactivado no se usa en las listas nuevas (cmdSetWorkCenterActive).
create function public.work_center_set_active(p_company_id uuid, p_work_center_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'work_center.update');
  v_center public.work_centers;
begin
  select * into v_center from public.work_centers w where w.id = p_work_center_id and w.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'El centro de trabajo no existe.');
  end if;
  if p_active is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si el centro está activo.');
  end if;
  if v_center.is_active = p_active then
    return;
  end if;
  update public.work_centers set is_active = p_active where id = v_center.id;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, 'work_center',
    v_center.id, private.work_center_label(v_center),
    format('%s el centro de trabajo %s', case when p_active then 'Activó' else 'Desactivó' end, private.work_center_label(v_center)));
end;
$$;

grant execute on function public.work_center_save(uuid, jsonb) to authenticated;
grant execute on function public.work_center_set_active(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ Listas de materiales: con sus horas por centro

-- Igual que antes, y además las horas por unidad en cada centro de trabajo (cmdSaveBom).
-- p_input: {product_id, notes, lines: [{component_id, quantity}], operations: [{work_center_id, hours}]}
create or replace function public.bom_save(p_company_id uuid, p_input jsonb)
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
  v_operation jsonb;
  v_operations jsonb := '[]';
  v_centers uuid[] := '{}';
  v_center public.work_centers;
  v_hours numeric;
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
  for v_operation in
    select o from jsonb_array_elements(coalesce(p_input -> 'operations', '[]')) as o
     where nullif(o ->> 'work_center_id', '') is not null
  loop
    select * into v_center from public.work_centers w
     where w.id::text = v_operation ->> 'work_center_id' and w.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Elegí el centro de trabajo.');
    end if;
    if not v_center.is_active then
      perform private.raise_business_error('DATO_INVALIDO',
        format('El centro de trabajo %s está inactivo.', private.work_center_label(v_center)));
    end if;
    if v_center.id = any (v_centers) then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s está dos veces: sumá las horas en una sola línea.', v_center.code));
    end if;
    v_centers := v_centers || v_center.id;
    v_hours := (v_operation ->> 'hours')::numeric;
    if v_hours is null or v_hours <= 0 or round(v_hours, 3) <> v_hours or v_hours >= 1000 then
      perform private.raise_business_error('DATO_INVALIDO',
        format('Las horas de %s por unidad deben ser más de cero, con hasta 3 decimales.', v_center.code));
    end if;
    v_operations := v_operations || jsonb_build_array(jsonb_build_object('work_center_id', v_center.id, 'hours', v_hours));
  end loop;
  if v_existing.id is not null then
    -- Igual a la que hay: no cambia nada ni queda en la auditoría.
    if v_existing.notes = v_notes and (
         select coalesce(jsonb_agg(jsonb_build_object('component_id', l.component_id, 'quantity', l.quantity)
                                   order by l.line_no), '[]')
           from public.bom_lines l where l.bom_id = v_existing.id) = v_lines
       and (
         select coalesce(jsonb_agg(jsonb_build_object('work_center_id', o.work_center_id, 'hours', o.hours)
                                   order by o.line_no), '[]')
           from public.bom_operations o where o.bom_id = v_existing.id) = v_operations then
      return jsonb_build_object('id', v_existing.id);
    end if;
    delete from public.bom_lines where bom_id = v_existing.id;
    delete from public.bom_operations where bom_id = v_existing.id;
    update public.boms set notes = v_notes where id = v_existing.id returning * into v_bom;
  else
    insert into public.boms (company_id, product_id, notes) values (p_company_id, v_p.id, v_notes) returning * into v_bom;
  end if;
  insert into public.bom_lines (company_id, bom_id, line_no, component_id, quantity)
  select p_company_id, v_bom.id, x.ord, (x.l ->> 'component_id')::uuid, (x.l ->> 'quantity')::numeric
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord);
  insert into public.bom_operations (company_id, bom_id, line_no, work_center_id, hours)
  select p_company_id, v_bom.id, x.ord, (x.o ->> 'work_center_id')::uuid, (x.o ->> 'hours')::numeric
    from jsonb_array_elements(v_operations) with ordinality as x (o, ord);
  perform private.log_audit(p_company_id, v_actor, case when v_existing.id is not null then 'UPDATE' else 'CREATE' end, 'bom',
    v_bom.id, 'Lista de materiales de ' || v_p.code,
    format('%s la lista de materiales de %s %s (%s)', case when v_existing.id is not null then 'Modificó' else 'Creó' end,
           v_p.code, v_p.name, private.components_label(jsonb_array_length(v_lines))
             || case jsonb_array_length(v_operations)
                  when 0 then ''
                  when 1 then ' y 1 centro de trabajo'
                  else format(' y %s centros de trabajo', jsonb_array_length(v_operations))
                end));
  return jsonb_build_object('id', v_bom.id);
end;
$$;

-- ------------------------------------------------------------------ Órdenes de producción: la conversión

-- Igual que antes, y además copia las horas de cada centro con sus tarifas (cmdCreateProductionOrder).
create or replace function public.opr_create(p_company_id uuid, p_input jsonb, p_release boolean default false)
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
  select w.code into v_zero
    from public.bom_operations o join public.work_centers w on w.id = o.work_center_id
   where o.bom_id = v_bom.id and round(o.hours * v_qty, 3) <= 0
   order by o.line_no
   limit 1;
  if v_zero is not null then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Con esa cantidad, las horas de %s quedarían en cero: fabricá más unidades.', v_zero));
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
  insert into public.production_order_operations (company_id, document_id, line_no, work_center_id, hours_planned,
                                                  labor_rate, overhead_rate)
  select p_company_id, v_doc.id, row_number() over (order by o.line_no), w.id, round(o.hours * v_qty, 3),
         w.labor_rate, w.overhead_rate
    from public.bom_operations o join public.work_centers w on w.id = o.work_center_id
   where o.bom_id = v_bom.id;
  -- El costo previsto: los materiales y la conversión.
  update public.documents d
     set subtotal = t.cost, total = t.cost
    from (select round(
                   coalesce((select sum(round(l.quantity_planned * l.planned_unit_cost, 2))
                               from public.production_order_lines l where l.document_id = v_doc.id), 0)
                   + coalesce((select sum(private.conversion_cost(o.hours_planned, o.labor_rate, o.overhead_rate))
                                 from public.production_order_operations o where o.document_id = v_doc.id), 0),
                   2) as cost) as t
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

-- Terminar ahora recibe las horas reales: la función anterior se reemplaza.
drop function public.opr_finish(uuid, numeric);

-- Producción termina la orden: registra las horas reales de cada centro (las que
-- no indica son las previstas) y las unidades que salieron bien, que entran al
-- stock a su costo real (materiales consumidos más la conversión aplicada,
-- dividido las unidades terminadas). Asientos: la conversión aplicada a productos
-- en proceso y el pase a productos terminados (cmdFinishProductionOrder).
-- p_hours: [{operation_id, hours}]
create function public.opr_finish(p_document_id uuid, p_quantity numeric, p_hours jsonb default '[]')
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
  v_hour jsonb;
  v_operation public.production_order_operations;
  v_actual jsonb := '{}';
  v_value numeric;
  v_materials numeric;
  v_labor numeric;
  v_overhead numeric;
  v_conversion numeric;
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
  for v_hour in select h from jsonb_array_elements(coalesce(p_hours, '[]')) as h loop
    select * into v_operation from public.production_order_operations o
     where o.id::text = v_hour ->> 'operation_id' and o.document_id = v_doc.id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Una de las horas no es de un centro de trabajo de la orden.');
    end if;
    if v_actual ? v_operation.id::text then
      perform private.raise_business_error('DATO_INVALIDO',
        'Un centro de trabajo está dos veces: indicá una sola cantidad de horas.');
    end if;
    v_value := (v_hour ->> 'hours')::numeric;
    if v_value is null or v_value < 0 or round(v_value, 3) <> v_value or v_value >= 100000 then
      perform private.raise_business_error('DATO_INVALIDO',
        'Las horas trabajadas deben ser números mayores o iguales que cero (hasta 3 decimales).');
    end if;
    v_actual := v_actual || jsonb_build_object(v_operation.id::text, v_value);
  end loop;
  update public.production_order_operations o
     set hours_actual = coalesce((v_actual ->> o.id::text)::numeric, o.hours_planned)
   where o.document_id = v_doc.id;
  select * into v_warehouse from public.warehouses w where w.id = v_o.output_warehouse_id;
  v_materials := private.production_material_cost(v_doc.id);
  v_labor := private.production_labor_cost(v_doc.id);
  v_overhead := private.production_overhead_cost(v_doc.id);
  v_conversion := round(v_labor + v_overhead, 2);
  v_total := round(v_materials + v_conversion, 2);
  v_unit_cost := round(v_total / p_quantity, 4);
  v_actor := private.transition_document(v_doc.id, 'FINISH',
    p_summary => format('Terminó %s: ingresaron %s de %s a %s por unidad', v_doc.display_number,
                        private.format_qty(p_quantity, v_p.uom_code), v_p.code, private.format_money(v_unit_cost)));
  perform private.post_stock_movement(v_doc.company_id, v_p.id, v_warehouse.id, 'INGRESO_PRODUCCION', p_quantity, v_unit_cost,
    v_doc.id, null, private.business_date(v_doc.company_id));
  update public.production_orders
     set quantity_produced = p_quantity, unit_cost = v_unit_cost, finished_at = now()
   where document_id = v_doc.id;
  if v_conversion > 0 then
    perform private.post_event(v_actor, v_doc, 'CONVERSION_PRODUCCION',
      format('Mano de obra y carga fabril aplicadas a %s (%s de %s %s).', v_doc.display_number,
             private.format_qty(p_quantity, v_p.uom_code), v_p.code, v_p.name),
      jsonb_build_array(
        jsonb_build_object('key', 'PRODUCCION_EN_PROCESO', 'debit', v_conversion, 'credit', 0),
        jsonb_build_object('key', 'MANO_DE_OBRA_APLICADA', 'debit', 0, 'credit', v_labor),
        jsonb_build_object('key', 'CARGA_FABRIL_APLICADA', 'debit', 0, 'credit', v_overhead)));
  end if;
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

grant execute on function public.opr_finish(uuid, numeric, jsonb) to authenticated;

-- ------------------------------------------------------------------ Lecturas de producción: con la conversión

-- Igual que antes, con el costo estimado de la conversión de una unidad (listBoms).
create or replace function public.boms_list(p_company_id uuid)
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
             'material_cost', case when b.id is not null then private.bom_material_cost(b.id) else 0 end,
             'conversion_cost', case when b.id is not null then private.bom_conversion_cost(b.id) else 0 end)
           order by p.code collate "C")
      from public.products p
      left join public.boms b on b.product_id = p.id
     where p.company_id = p_company_id and p.product_type = 'PRODUCTO_TERMINADO'
  ), '[]');
end;
$$;

-- Igual que antes, con las horas de cada centro y su costo (bomDetail).
create or replace function public.bom_detail(p_company_id uuid, p_code text)
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
    'operations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_no', o.line_no,
               'work_center', jsonb_build_object('id', w.id, 'code', w.code, 'name', w.name, 'is_active', w.is_active),
               'hours', o.hours, 'labor_rate', w.labor_rate, 'overhead_rate', w.overhead_rate,
               'cost', private.conversion_cost(o.hours, w.labor_rate, w.overhead_rate)) order by o.line_no)
        from public.bom_operations o join public.work_centers w on w.id = o.work_center_id
       where o.bom_id = v_bom.id), '[]'::jsonb),
    'conversion_cost', case when v_bom.id is not null then private.bom_conversion_cost(v_bom.id) else 0 end,
    'open_orders', (
      select count(*) from public.production_orders o join public.documents d on d.id = o.document_id
       where o.product_id = v_p.id and d.status in ('BORRADOR', 'LIBERADA', 'EN_PROCESO')));
end;
$$;

-- Igual que antes, con las horas por unidad de cada centro (productionCatalog).
create or replace function public.production_catalog(p_company_id uuid)
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
                where l.bom_id = b.id),
             'operations', (
               select coalesce(jsonb_agg(jsonb_build_object(
                        'work_center', jsonb_build_object('id', w.id, 'code', w.code, 'name', w.name),
                        'hours', o.hours, 'labor_rate', w.labor_rate, 'overhead_rate', w.overhead_rate) order by o.line_no), '[]')
                 from public.bom_operations o join public.work_centers w on w.id = o.work_center_id
                where o.bom_id = b.id))
           order by p.code collate "C")
      from public.products p join public.boms b on b.product_id = p.id and b.is_active
     where p.company_id = p_company_id and p.is_active
  ), '[]');
end;
$$;

-- Igual que antes, con el costo previsto y el real por elemento, y las horas de cada centro (productionOrderView).
create or replace function private.production_order_view(p_doc public.documents)
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
    'planned_material_cost', (
      select round(coalesce(sum(round(l.quantity_planned * l.planned_unit_cost, 2)), 0), 2)
        from public.production_order_lines l where l.document_id = p_doc.id),
    'planned_conversion_cost', (
      select round(coalesce(sum(private.conversion_cost(x.hours_planned, x.labor_rate, x.overhead_rate)), 0), 2)
        from public.production_order_operations x where x.document_id = p_doc.id),
    'material_cost', private.production_material_cost(p_doc.id),
    'labor_cost', case when o.finished_at is not null then private.production_labor_cost(p_doc.id) end,
    'overhead_cost', case when o.finished_at is not null then private.production_overhead_cost(p_doc.id) end,
    'unit_cost', o.unit_cost,
    'standard_cost', p.standard_cost,
    'operations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'line_no', x.line_no,
               'work_center', jsonb_build_object('id', w.id, 'code', w.code, 'name', w.name),
               'hours_planned', x.hours_planned, 'hours_actual', x.hours_actual,
               'labor_rate', x.labor_rate, 'overhead_rate', x.overhead_rate) order by x.line_no)
        from public.production_order_operations x join public.work_centers w on w.id = x.work_center_id
       where x.document_id = p_doc.id), '[]'::jsonb))
    from public.production_orders o
    join public.products p on p.id = o.product_id
    join public.warehouses mw on mw.id = o.materials_warehouse_id
    join public.warehouses ow on ow.id = o.output_warehouse_id
   where o.document_id = p_doc.id
$$;

-- ------------------------------------------------------------------ Empresas desde la plantilla: también los centros de trabajo

-- Igual que antes, y además los centros de trabajo y las horas de cada lista (por código).
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
  -- Los centros de trabajo y las listas de materiales, con los productos y los centros de la empresa nueva.
  insert into public.work_centers (company_id, code, name, labor_rate, overhead_rate, is_active)
  select v_id, w.code, w.name, w.labor_rate, w.overhead_rate, w.is_active
    from public.work_centers w where w.company_id = p_template;
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
  insert into public.bom_operations (company_id, bom_id, line_no, work_center_id, hours)
  select v_id, nb.id, o.line_no, nw.id, o.hours
    from public.bom_operations o
    join public.boms ob on ob.id = o.bom_id
    join public.products op on op.id = ob.product_id
    join public.products np on np.company_id = v_id and np.code = op.code
    join public.boms nb on nb.company_id = v_id and nb.product_id = np.id
    join public.work_centers ow on ow.id = o.work_center_id
    join public.work_centers nw on nw.company_id = v_id and nw.code = ow.code
   where o.company_id = p_template;
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


-- ------------------------------------------------------------------ Lecturas nuevas

-- Los centros de trabajo de la empresa, por código, y cuántas listas usan cada uno (listWorkCenters).
create function public.work_centers_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'work_center.read');
  return coalesce((
    select jsonb_agg(to_jsonb(w) || jsonb_build_object(
             'boms', (select count(distinct o.bom_id) from public.bom_operations o where o.work_center_id = w.id))
           order by w.code collate "C")
      from public.work_centers w where w.company_id = p_company_id
  ), '[]');
end;
$$;

-- Los costos de producción: las órdenes terminadas en un período (el día del ingreso
-- al stock), con su costo previsto y el real por elemento (productionCosts).
create function public.production_costs(p_company_id uuid, p_from text, p_to text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'production_order.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'order', jsonb_build_object('id', d.id, 'display_number', d.display_number, 'path', private.doc_path(d.id)),
             'product', jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'uom_code', p.uom_code,
                                           'standard_cost', p.standard_cost),
             'finished_on', x.finished_on,
             'quantity', o.quantity,
             'quantity_produced', coalesce(o.quantity_produced, 0),
             'planned_cost', d.subtotal,
             'material_cost', private.production_material_cost(d.id),
             'labor_cost', private.production_labor_cost(d.id),
             'overhead_cost', private.production_overhead_cost(d.id),
             'unit_cost', coalesce(o.unit_cost, 0))
           order by x.finished_on, d.number)
      from public.documents d
      join public.production_orders o on o.document_id = d.id
      join public.products p on p.id = o.product_id
      cross join lateral (
        select coalesce((select m.movement_date::text from public.stock_movements m
                          where m.document_id = d.id and m.movement_type = 'INGRESO_PRODUCCION'
                          order by m.id limit 1), '') as finished_on
      ) as x
     where d.company_id = p_company_id and d.status = 'TERMINADA'
       and x.finished_on >= p_from and x.finished_on <= p_to
  ), '[]');
end;
$$;

grant execute on function public.work_centers_list(uuid) to authenticated;
grant execute on function public.production_costs(uuid, text, text) to authenticated;
