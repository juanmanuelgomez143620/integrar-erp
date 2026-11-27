-- 131. Fase 8g.1 (docs/FASE_8G_ESCENARIOS.md): los escenarios. El docente inicia uno en la empresa del
-- curso (de a uno por vez): llega el pedido de la situación de partida, recibido, y cada rol de las islas que
-- participan recibe la tarea de su consigna; los criterios de logro se evalúan sobre la auditoría entre el
-- inicio y el fin. Dos escenarios: falta de stock y venta a crédito. Traducción de "Los escenarios" de
-- src/lib/mock/engine.ts (scenarioSituation, scenarioCriteria, cmdStartScenario, cmdEndScenario) y de
-- scenarioView de queries.ts; los textos de las consignas y los criterios viven en src/lib/domain/scenarios.ts.

-- ------------------------------------------------------------------ Tabla

-- Una corrida: el escenario, la situación de partida (el pedido, el cliente, el producto, la cantidad y lo
-- disponible o el límite de crédito), quién la inició y quién la terminó.
create table public.scenario_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  scenario text not null check (scenario in ('FALTA_STOCK', 'VENTA_CREDITO')),
  status text not null default 'EN_CURSO' check (status in ('EN_CURSO', 'TERMINADO')),
  context jsonb not null default '{}',
  started_at timestamptz not null default now(),
  started_by uuid,
  ended_at timestamptz,
  ended_by uuid,
  check ((status = 'TERMINADO') = (ended_at is not null))
);

create index scenario_runs_company_idx on public.scenario_runs (company_id, started_at desc);
-- De a uno por empresa.
create unique index scenario_runs_current_idx on public.scenario_runs (company_id) where status = 'EN_CURSO';

alter table public.scenario_runs enable row level security;
revoke all on table public.scenario_runs from anon, authenticated;
grant select on table public.scenario_runs to authenticated;
-- Las ven los integrantes de la empresa (el escenario en curso es de todos).
create policy scenario_runs_select on public.scenario_runs for select to authenticated
  using (company_id in (select private.my_companies()));

-- ------------------------------------------------------------------ Auxiliares

-- El nombre de un escenario del catálogo (SCENARIOS de src/lib/domain/scenarios.ts); null si no existe.
create function private.scenario_name(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_code when 'FALTA_STOCK' then 'Falta de stock' when 'VENTA_CREDITO' then 'Venta a crédito' end
$$;

-- Los roles que reciben la consigna, en el orden del catálogo.
create function private.scenario_roles(p_code text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_code
           when 'FALTA_STOCK' then array['VENTAS', 'PRODUCCION', 'DEPOSITO']
           when 'VENTA_CREDITO' then array['VENTAS', 'GERENCIA', 'DEPOSITO', 'TESORERIA']
         end
$$;

-- La entrega que pide el cliente (requestedDelivery): el primer día de reparto de su zona desde pasado
-- mañana; sin zona, a la semana.
create function private.requested_delivery(p_customer uuid, p_today date)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select p_today + k
      from generate_series(2, 8) as k
     where exists (select 1 from public.customers c
                     join public.delivery_zones z on z.id = c.zone_id and z.is_active
                    where c.id = p_customer and extract(isodow from p_today + k)::smallint = any (z.delivery_days))
     order by k
     limit 1), p_today + 7)
$$;

-- El total de un ítem con su IVA, como lo calcula el pedido (lineTotalWithVat).
create function private.line_total_with_vat(p_quantity numeric, p_price numeric, p_vat numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(round(p_quantity * p_price, 2) + round(round(p_quantity * p_price, 2) * p_vat / 100, 2), 2)
$$;

-- La situación de partida (scenarioSituation): el pedido que llega del cliente y el contexto de la corrida.
create function private.scenario_situation(p_company uuid, p_code text, p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
  v_product public.products;
  v_product_id uuid;
  v_available numeric := 0;
  v_quantity int := 0;
  v_price numeric;
  v_limit numeric;
begin
  if p_code = 'FALTA_STOCK' then
    select * into v_customer from public.customers c
     where c.company_id = p_company and c.is_active and c.vat_condition <> 'CONSUMIDOR_FINAL'
     order by (c.credit_limit is not null), c.credit_limit desc nulls first, c.code collate "C"
     limit 1;
    select x.id, x.available into v_product_id, v_available
      from (select p.id, p.code, round(private.on_hand_quantity(p.id, p.default_warehouse_id)
                            - private.reserved_quantity(p.id, p.default_warehouse_id), 3) as available
              from public.products p
             where p.company_id = p_company and p.is_active and p.is_stockable and coalesce(p.sale_price, 0) > 0
               and p.default_warehouse_id is not null and p.product_type = 'PRODUCTO_TERMINADO'
               and exists (select 1 from public.boms b where b.company_id = p_company and b.product_id = p.id and b.is_active)) x
     order by x.available, x.code collate "C"
     limit 1;
    select * into v_product from public.products p where p.id = v_product_id;
    if v_product.id is not null then
      v_available := greatest(v_available, 0);
      v_quantity := floor(v_available)::int + 6;
    end if;
  else
    select * into v_customer from public.customers c
     where c.company_id = p_company and c.is_active and c.vat_condition <> 'CONSUMIDOR_FINAL'
       and c.credit_limit is not null and c.credit_limit > 0
     order by c.credit_limit, c.code collate "C"
     limit 1;
    select x.id, x.available into v_product_id, v_available
      from (select p.id, p.code, round(private.on_hand_quantity(p.id, p.default_warehouse_id)
                            - private.reserved_quantity(p.id, p.default_warehouse_id), 3) as available
              from public.products p
             where p.company_id = p_company and p.is_active and p.is_stockable and coalesce(p.sale_price, 0) > 0
               and p.default_warehouse_id is not null
               and p.product_type in ('PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA')) x
     order by x.available desc, x.code collate "C"
     limit 1;
    select * into v_product from public.products p where p.id = v_product_id;
    if v_customer.id is not null and v_product.id is not null then
      v_available := greatest(v_available, 0);
      v_price := private.list_price_for(v_customer.id, v_product.id);
      v_limit := v_customer.credit_limit;
      v_quantity := greatest(1, floor(v_limit / (v_price * (1 + v_product.vat_rate / 100)))::int - 1);
      while private.line_total_with_vat(v_quantity, v_price, v_product.vat_rate) <= v_limit loop
        v_quantity := v_quantity + 1;
      end loop;
      if v_quantity > floor(v_available) then
        perform private.raise_business_error('DATO_INVALIDO',
          format('No hay stock suficiente para armar el escenario: %s tiene %s disponibles y el pedido necesita %s.',
                 v_product.code, private.format_qty(v_available, v_product.uom_code), v_quantity));
      end if;
    end if;
  end if;
  if v_customer.id is null or v_product.id is null then
    perform private.raise_business_error('DATO_INVALIDO', 'La empresa no tiene los clientes o los productos que necesita el escenario.');
  end if;
  return jsonb_build_object(
    'input', jsonb_build_object(
      'customer_id', v_customer.id,
      'warehouse_id', v_product.default_warehouse_id,
      'delivery_date', private.requested_delivery(v_customer.id, p_today),
      'payment_terms_days', v_customer.payment_terms_days,
      'customer_reference', case when p_code = 'FALTA_STOCK' then 'OC 9001' else 'OC 9002' end,
      'notes', format('Pedido del escenario «%s».', private.scenario_name(p_code)),
      'lines', jsonb_build_array(jsonb_build_object(
        'product_id', v_product.id, 'quantity', v_quantity,
        'unit_price', private.list_price_for(v_customer.id, v_product.id)))),
    'context', jsonb_build_object(
      'customer_id', v_customer.id,
      'product_id', v_product.id,
      'quantity', v_quantity,
      'available', case when p_code = 'FALTA_STOCK' then v_available end,
      'credit_limit', case when p_code = 'VENTA_CREDITO' then v_customer.credit_limit end));
end;
$$;

-- Los criterios de logro de una corrida (scenarioCriteria): "tal documento llegó a tal estado" en la
-- auditoría, entre el inicio y el fin del escenario.
create function private.scenario_criteria(p_run public.scenario_runs)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := p_run.started_at;
  v_to timestamptz := coalesce(p_run.ended_at, 'infinity');
  v_order uuid := (p_run.context ->> 'order_id')::uuid;
  v_customer uuid := (p_run.context ->> 'customer_id')::uuid;
  v_product uuid := (p_run.context ->> 'product_id')::uuid;
begin
  if p_run.scenario = 'FALTA_STOCK' then
    return jsonb_build_array(
      jsonb_build_object('key', 'FS_RECHAZO', 'done', exists (
        select 1 from public.audit_events e
         where e.company_id = p_run.company_id and e.document_id = v_order and e.to_status = 'ANULADO'
           and e.occurred_at between v_from and v_to)),
      jsonb_build_object('key', 'FS_DISPONIBLE', 'done', exists (
        select 1 from public.audit_events e join public.documents d on d.id = e.document_id
         where e.company_id = p_run.company_id and e.to_status = 'CONFIRMADO' and e.occurred_at between v_from and v_to
           and d.doc_type = 'SALES_ORDER' and d.id <> v_order and d.customer_id = v_customer and d.created_at >= v_from
           and exists (select 1 from public.sales_order_lines l where l.document_id = d.id and l.product_id = v_product))),
      jsonb_build_object('key', 'FS_FABRICA', 'done', exists (
        select 1 from public.audit_events e
          join public.documents d on d.id = e.document_id
          join public.production_orders po on po.document_id = d.id
         where e.company_id = p_run.company_id and e.to_status = 'TERMINADA' and e.occurred_at between v_from and v_to
           and d.doc_type = 'PRODUCTION_ORDER' and po.product_id = v_product and d.created_at >= v_from)),
      jsonb_build_object('key', 'FS_DESPACHO', 'done', exists (
        select 1 from public.audit_events e join public.documents d on d.id = e.document_id
         where e.company_id = p_run.company_id and e.to_status = 'CONFIRMADO' and e.occurred_at between v_from and v_to
           and d.doc_type = 'DELIVERY_NOTE' and d.customer_id = v_customer and d.created_at >= v_from
           and exists (select 1 from public.delivery_note_lines l where l.document_id = d.id and l.product_id = v_product))),
      jsonb_build_object('key', 'FS_FACTURA', 'done', exists (
        select 1 from public.audit_events e join public.documents d on d.id = e.document_id
         where e.company_id = p_run.company_id and e.to_status = 'REGISTRADA' and e.occurred_at between v_from and v_to
           and d.doc_type = 'SALES_INVOICE' and d.customer_id = v_customer and d.created_at >= v_from)));
  end if;
  return jsonb_build_array(
    jsonb_build_object('key', 'VC_REVISA', 'done', exists (
      select 1 from public.audit_events e
       where e.company_id = p_run.company_id and e.document_id = v_order and e.to_status = 'PENDIENTE_APROBACION'
         and e.occurred_at between v_from and v_to)),
    jsonb_build_object('key', 'VC_DECIDE', 'done', exists (
      select 1 from public.audit_events e
       where e.company_id = p_run.company_id and e.document_id = v_order and e.from_status = 'PENDIENTE_APROBACION'
         and e.to_status in ('CONFIRMADO', 'RECHAZADO') and e.occurred_at between v_from and v_to)),
    jsonb_build_object('key', 'VC_DESPACHO', 'done', exists (
      select 1 from public.audit_events e
        join public.documents d on d.id = e.document_id
        join public.delivery_notes dn on dn.document_id = d.id
       where e.company_id = p_run.company_id and e.to_status = 'CONFIRMADO' and e.occurred_at between v_from and v_to
         and d.doc_type = 'DELIVERY_NOTE' and dn.sales_order_id = v_order)),
    jsonb_build_object('key', 'VC_FACTURA', 'done', exists (
      select 1 from public.audit_events e
        join public.documents d on d.id = e.document_id
        join public.sales_invoices si on si.document_id = d.id
       where e.company_id = p_run.company_id and e.to_status = 'REGISTRADA' and e.occurred_at between v_from and v_to
         and d.doc_type = 'SALES_INVOICE' and si.sales_order_id = v_order)),
    jsonb_build_object('key', 'VC_COBRO', 'done', exists (
      select 1 from public.audit_events e join public.documents d on d.id = e.document_id
       where e.company_id = p_run.company_id and e.to_status = 'CONFIRMADO' and e.occurred_at between v_from and v_to
         and d.doc_type = 'CUSTOMER_RECEIPT' and d.customer_id = v_customer and d.created_at >= v_from)));
end;
$$;

-- Una corrida con los datos que completan sus textos y el estado de cada criterio (scenarioView).
create function private.scenario_run_view(p_run public.scenario_runs)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_run.id,
    'scenario', p_run.scenario,
    'status', p_run.status,
    'started_at', p_run.started_at,
    'started_by_name', private.full_name(p_run.started_by),
    'ended_at', p_run.ended_at,
    'ended_by_name', case when p_run.ended_at is null then null else private.full_name(p_run.ended_by) end,
    'labels', jsonb_build_object(
      'order', coalesce((select d.display_number from public.documents d where d.id = (p_run.context ->> 'order_id')::uuid), ''),
      'customer', coalesce((select c.legal_name from public.customers c where c.id = (p_run.context ->> 'customer_id')::uuid), ''),
      'product', coalesce((select p.code || ' ' || p.name from public.products p where p.id = (p_run.context ->> 'product_id')::uuid), ''),
      'quantity', p_run.context -> 'quantity',
      'available', p_run.context -> 'available',
      'credit_limit', p_run.context -> 'credit_limit'),
    'criteria', private.scenario_criteria(p_run))
$$;

-- ------------------------------------------------------------------ RPC

-- El docente inicia un escenario (cmdStartScenario): el pedido de la situación de partida, recibido y con
-- su tarea para Ventas, y la tarea de la consigna para cada rol que participa.
create function public.scenario_start(p_company_id uuid, p_scenario text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_system private.actor := row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor;
  v_name text := private.scenario_name(p_scenario);
  v_situation jsonb;
  v_doc public.documents;
  v_run public.scenario_runs;
  v_role text;
  v_task uuid;
  v_title text;
  v_description text := 'El docente inició un escenario: la consigna de tu isla y lo que falta están en Mi trabajo, arriba de las tareas.';
begin
  if v_name is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí un escenario.');
  end if;
  if exists (select 1 from public.scenario_runs r where r.company_id = p_company_id and r.status = 'EN_CURSO') then
    perform private.raise_business_error('TRANSICION_INVALIDA', 'Ya hay un escenario en curso: terminalo antes de iniciar otro.');
  end if;
  v_situation := private.scenario_situation(p_company_id, p_scenario, private.business_date(p_company_id));
  v_doc := private.insert_sales_order(p_company_id, v_system, v_situation -> 'input', null, 'RECIBIDO');
  perform private.open_tasks_for_status(v_doc.id, v_system);
  insert into public.scenario_runs (company_id, scenario, status, context, started_by)
  values (p_company_id, p_scenario, 'EN_CURSO', jsonb_build_object('order_id', v_doc.id) || (v_situation -> 'context'),
          (v_actor).user_id)
  returning * into v_run;
  v_title := format('Escenario «%s»', v_name);
  foreach v_role in array private.scenario_roles(p_scenario) loop
    insert into public.tasks (company_id, document_id, task_type, title, description, origin_status, context,
                              assigned_role, status, priority, source, created_by)
    values (p_company_id, v_doc.id, 'CONSIGNA_ESCENARIO', v_title, v_description, null,
            jsonb_build_object('run_id', v_run.id), v_role, 'PENDIENTE', 'ALTA', 'ESCENARIO', (v_actor).user_id)
    returning id into v_task;
    perform private.notify_roles(p_company_id, array[v_role], 'NUEVA_TAREA', 'Nueva tarea: ' || v_title, v_description,
      '/e/' || (select c.slug from public.companies c where c.id = p_company_id) || '/mi-trabajo',
      v_doc.id, v_task, (v_actor).user_id);
  end loop;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'scenario_run', v_run.id, v_title,
    format('Inició el escenario «%s»: llegó el pedido %s de %s', v_name, v_doc.display_number,
           (select c.legal_name from public.customers c where c.id = v_doc.customer_id)));
  return jsonb_build_object('run_id', v_run.id, 'order', v_doc.display_number);
end;
$$;

-- El docente termina el escenario en curso (cmdEndScenario): se cierran las consignas y queda el resultado.
create function public.scenario_end(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_run public.scenario_runs;
  v_criteria jsonb;
  v_done int;
  v_name text;
begin
  select * into v_run from public.scenario_runs r
   where r.company_id = p_company_id and r.status = 'EN_CURSO'
   for update;
  if not found then
    perform private.raise_business_error('TRANSICION_INVALIDA', 'No hay un escenario en curso.');
  end if;
  update public.scenario_runs r set status = 'TERMINADO', ended_at = now(), ended_by = (v_actor).user_id
   where r.id = v_run.id
  returning * into v_run;
  update public.tasks t set status = 'RESUELTA', completed_by = (v_actor).user_id, completed_at = now()
   where t.company_id = p_company_id and t.task_type = 'CONSIGNA_ESCENARIO' and t.context ->> 'run_id' = v_run.id::text
     and t.status in ('PENDIENTE', 'EN_CURSO');
  v_criteria := private.scenario_criteria(v_run);
  select count(*) into v_done from jsonb_array_elements(v_criteria) as x (c) where (x.c ->> 'done')::boolean;
  v_name := private.scenario_name(v_run.scenario);
  perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'scenario_run', v_run.id, format('Escenario «%s»', v_name),
    format('Terminó el escenario «%s»: %s de %s criterios logrados', v_name, v_done, jsonb_array_length(v_criteria)));
  return jsonb_build_object('done', v_done, 'total', jsonb_array_length(v_criteria));
end;
$$;

-- El escenario en curso (lo ven todos los integrantes) y los terminados (los ve el docente), el último primero
-- (scenarioView).
create function public.scenario_view(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  if not exists (select 1 from private.my_companies() as c (id) where c.id = p_company_id) then
    perform private.raise_business_error('SIN_PERMISO', 'No participás en esta empresa.');
  end if;
  return jsonb_build_object(
    'current', (select private.scenario_run_view(r) from public.scenario_runs r
                 where r.company_id = p_company_id and r.status = 'EN_CURSO'),
    'history', case when private.is_supervisor(p_company_id) then coalesce((
                 select jsonb_agg(private.scenario_run_view(r) order by r.started_at desc)
                   from public.scenario_runs r
                  where r.company_id = p_company_id and r.status = 'TERMINADO'), '[]')
               else '[]' end);
end;
$$;

grant execute on function public.scenario_start(uuid, text) to authenticated;
grant execute on function public.scenario_end(uuid) to authenticated;
grant execute on function public.scenario_view(uuid) to authenticated;
