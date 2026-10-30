-- 76. Fase 7c.2 (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §4): la hoja de ruta (HR).
-- Logística arma el reparto de un día con un transportista o con un vehículo propio y su
-- chofer, y los remitos despachados pendientes de entrega en el orden de visita; sale a
-- repartir y, al volver, la rinde: cada remito queda entregado (con quién lo recibió) o no
-- entregado (con el motivo, y vuelve a estar pendiente). Ventas recibe un aviso por cada uno.
-- El remito muestra su estado de entrega y no se anula si está en una hoja en curso o ya se
-- entregó. Traducción de la sección "Hojas de ruta" de src/lib/mock/engine.ts y de sus
-- lecturas en queries.ts.
--
-- El tipo de documento, sus estados, transiciones, tareas y permisos están en la migración de
-- catálogos siguiente.

-- ------------------------------------------------------------------ Tablas

-- La hoja: con qué sale (un transportista, o un vehículo propio con su chofer) y cuándo salió
-- y se rindió. La fecha de salida es la del documento.
create table public.route_sheets (
  document_id uuid primary key,
  doc_type text not null default 'ROUTE_SHEET' check (doc_type = 'ROUTE_SHEET'),
  company_id uuid not null,
  carrier_id uuid,
  vehicle_id uuid,
  driver_id uuid,
  departed_at timestamptz,
  closed_at timestamptz,
  check ((carrier_id is null) <> (vehicle_id is null) and (vehicle_id is null) = (driver_id is null)),
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, carrier_id) references public.carriers (company_id, id),
  foreign key (company_id, vehicle_id) references public.vehicles (company_id, id),
  foreign key (company_id, driver_id) references public.employees (company_id, id)
);

-- Los remitos de la hoja, en el orden de visita, y el resultado de cada uno al rendirla.
create table public.route_sheet_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  delivery_note_id uuid not null,
  outcome text check (outcome in ('ENTREGADO', 'NO_ENTREGADO')),   -- null hasta rendirla
  received_by text not null default '' check (length(received_by) <= 80),
  reason text not null default '' check (length(reason) <= 200),
  unique (document_id, line_no),
  unique (document_id, delivery_note_id),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.route_sheets (company_id, document_id) on delete cascade,
  foreign key (company_id, delivery_note_id) references public.delivery_notes (company_id, document_id)
);
create index route_sheet_lines_note_idx on public.route_sheet_lines (delivery_note_id);

do $$
declare
  t text;
begin
  foreach t in array array['route_sheets', 'route_sheet_lines'] loop
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

create policy route_sheets_select on public.route_sheets for select to authenticated
  using (company_id in (select private.companies_with_permission('route_sheet.read')));
create policy route_sheet_lines_select on public.route_sheet_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('route_sheet.read')));

-- ------------------------------------------------------------------ Auxiliares

-- "1 remito", "3 remitos".
create function private.notes_count(p_n int)
returns text
language sql
immutable
set search_path = ''
as $$ select p_n || case when p_n = 1 then ' remito' else ' remitos' end $$;

-- Con qué sale el reparto: "TR-001 Transportes Ruta 12 SRL" o "CAM-01 (AF 512 MS) con Ramón
-- Ortiz" (transportLabel).
create function private.transport_label(p_rs public.route_sheets)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select private.carrier_label(c) from public.carriers c where c.id = p_rs.carrier_id),
    coalesce((select private.vehicle_label(v) from public.vehicles v where v.id = p_rs.vehicle_id), '—')
      || coalesce((select ' con ' || e.first_name || ' ' || e.last_name from public.employees e where e.id = p_rs.driver_id), ''))
$$;

-- La línea de la última hoja de ruta (sin las anuladas) que lleva el remito; null si ninguna.
create function private.last_route_line(p_delivery_note uuid)
returns public.route_sheet_lines
language sql
stable
security definer
set search_path = ''
as $$
  select l.* from public.route_sheet_lines l join public.documents d on d.id = l.document_id
   where l.delivery_note_id = p_delivery_note and d.status <> 'ANULADA'
   order by d.number desc
   limit 1
$$;

-- El estado de entrega de un remito despachado: el de la última hoja que lo lleva. Pendiente
-- (sin hoja, o no entregado en la última), programado (en una hoja en preparación), en camino
-- o entregado (deliveryStatus).
create function private.delivery_status(p_delivery_note uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when l.id is null then 'PENDIENTE'
              when d.status = 'BORRADOR' then 'PROGRAMADO'
              when d.status = 'EN_CAMINO' then 'EN_CAMINO'
              when l.outcome = 'ENTREGADO' then 'ENTREGADO'
              else 'PENDIENTE' end
    from (select (private.last_route_line(p_delivery_note)).*) as l
    left join public.documents d on d.id = l.document_id
$$;

-- Los datos del cliente para una parada de la hoja (customerStop).
create function private.customer_stop(p_customer uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('code', coalesce(c.code, ''), 'legal_name', coalesce(c.legal_name, ''),
                            'address_line', coalesce(c.address_line, ''), 'city', coalesce(c.city, ''),
                            'phone', coalesce(c.phone, ''))
    from (select 1) as one left join public.customers c on c.id = p_customer
$$;

-- El transporte de la hoja (al armarla y al salir): un transportista activo, o un vehículo
-- propio activo con un chofer activo del legajo (checkTransport). Los ids, como texto ('' si no hay).
create function private.check_transport(p_company uuid, p_carrier text, p_vehicle text, p_driver text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_carrier <> '' then
    if p_vehicle <> '' or p_driver <> '' then
      perform private.raise_business_error('DATO_INVALIDO', 'Elegí un transportista o un vehículo propio con su chofer, no los dos.');
    end if;
    if not exists (select 1 from public.carriers c where c.id::text = p_carrier and c.company_id = p_company and c.is_active) then
      perform private.raise_business_error('DATO_INVALIDO', 'El transportista no existe o está desactivado.');
    end if;
    return;
  end if;
  if p_vehicle = '' then
    perform private.raise_business_error('DATO_INVALIDO',
      'Elegí con qué sale el reparto: un transportista o un vehículo propio con su chofer.');
  end if;
  if not exists (select 1 from public.vehicles v where v.id::text = p_vehicle and v.company_id = p_company and v.is_active) then
    perform private.raise_business_error('DATO_INVALIDO', 'El vehículo no existe o está desactivado.');
  end if;
  if not exists (select 1 from public.employees e
                  where e.id::text = p_driver and e.company_id = p_company and e.status = 'ACTIVO') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el chofer: un empleado activo del legajo.');
  end if;
end;
$$;

-- Un remito entra en la hoja si está despachado y pendiente de entrega: sin otra hoja en curso
-- ni entregado (checkRoutedNote). Devuelve su id.
create function private.check_routed_note(p_company uuid, p_delivery_note text, p_sheet uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dn public.documents;
  v_status text;
  v_sheet public.documents;
begin
  select * into v_dn from public.documents d
   where d.id::text = p_delivery_note and d.company_id = p_company and d.doc_type = 'DELIVERY_NOTE';
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Uno de los remitos no existe.');
  end if;
  if v_dn.status <> 'CONFIRMADO' then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s no está despachado: sólo se reparten los remitos despachados.', v_dn.display_number));
  end if;
  v_status := private.delivery_status(v_dn.id);
  select d.* into v_sheet from public.documents d where d.id = (private.last_route_line(v_dn.id)).document_id;
  if v_status = 'ENTREGADO' then
    perform private.raise_business_error('DATO_INVALIDO', format('%s ya se entregó con %s.', v_dn.display_number, v_sheet.display_number));
  end if;
  if v_status <> 'PENDIENTE' and v_sheet.id is distinct from p_sheet then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s ya está en la hoja de ruta %s.', v_dn.display_number, v_sheet.display_number));
  end if;
  return v_dn.id;
end;
$$;

-- ------------------------------------------------------------------ Comandos

-- Logística arma la hoja de ruta de un día: el transporte y los remitos despachados, en el orden
-- de visita (cmdCreateRouteSheet).
-- p_input: {document_date, carrier_id, vehicle_id, driver_id, notes, delivery_note_ids: [id del remito]}
create function public.rs_create(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'route_sheet.create');
  v_date date := private.parse_date(coalesce(p_input ->> 'document_date', ''));
  v_carrier text := coalesce(p_input ->> 'carrier_id', '');
  v_vehicle text := coalesce(p_input ->> 'vehicle_id', '');
  v_driver text := coalesce(p_input ->> 'driver_id', '');
  v_notes text := trim(coalesce(p_input ->> 'notes', ''));
  v_ids jsonb := case when jsonb_typeof(p_input -> 'delivery_note_ids') = 'array' then p_input -> 'delivery_note_ids' else '[]' end;
  v_count int;
  v_id text;
  v_visits uuid[] := '{}';
  v_number record;
  v_doc public.documents;
  v_rs public.route_sheets;
begin
  if v_date is null then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de salida no es válida.');
  end if;
  if v_date < private.business_date(p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de salida es hoy o un día posterior.');
  end if;
  perform private.check_transport(p_company_id, v_carrier, v_vehicle, v_driver);
  if length(v_notes) > 500 then
    perform private.raise_business_error('DATO_INVALIDO', 'Las observaciones tienen hasta 500 caracteres.');
  end if;
  v_count := jsonb_array_length(v_ids);
  if v_count = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí los remitos despachados que lleva, en el orden de visita.');
  end if;
  if v_count > 30 then
    perform private.raise_business_error('DATO_INVALIDO', 'Una hoja de ruta lleva hasta 30 remitos.');
  end if;
  if (select count(distinct x) from jsonb_array_elements_text(v_ids) as x) <> v_count then
    perform private.raise_business_error('DATO_INVALIDO', 'Un remito figura dos veces en la hoja.');
  end if;
  for v_id in select x from jsonb_array_elements_text(v_ids) with ordinality as e (x, ord) order by ord loop
    v_visits := v_visits || private.check_routed_note(p_company_id, v_id, null);
  end loop;

  select * into v_number from private.next_document_number(p_company_id, 'ROUTE_SHEET');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, notes, created_by)
  values (p_company_id, 'ROUTE_SHEET', v_number.number, v_number.display_number, 'BORRADOR', v_date,
          (v_actor).sector_id, v_notes, (v_actor).user_id)
  returning * into v_doc;
  insert into public.route_sheets (document_id, company_id, carrier_id, vehicle_id, driver_id)
  values (v_doc.id, p_company_id, nullif(v_carrier, '')::uuid, nullif(v_vehicle, '')::uuid, nullif(v_driver, '')::uuid)
  returning * into v_rs;
  insert into public.route_sheet_lines (company_id, document_id, line_no, delivery_note_id)
  select p_company_id, v_doc.id, x.ord::int, x.id from unnest(v_visits) with ordinality as x (id, ord);
  perform private.link_documents(p_company_id, x.id, v_doc.id) from unnest(v_visits) as x (id);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'route_sheet', v_doc.id, v_doc.display_number,
    format('Armó %s para el %s: %s con %s', v_doc.display_number, to_char(v_date, 'DD/MM/YYYY'),
           private.notes_count(v_count), private.transport_label(v_rs)),
    v_doc.id, null, 'BORRADOR');
  perform private.open_tasks_for_status(v_doc.id, v_actor);
  return private.created_result(v_doc.id);
end;
$$;

-- Salir a repartir: se controlan otra vez el transporte y los remitos, que pasan a "en camino"
-- (cmdDepartRouteSheet).
create function public.rs_depart(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_rs public.route_sheets;
  v_line public.route_sheet_lines;
  v_count int;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'ROUTE_SHEET');
  perform private.require_transition(v_doc, 'SEND');
  perform private.require_permission(v_doc.company_id, 'route_sheet.create');
  select * into v_rs from public.route_sheets x where x.document_id = v_doc.id;
  perform private.check_transport(v_doc.company_id, coalesce(v_rs.carrier_id::text, ''),
                                  coalesce(v_rs.vehicle_id::text, ''), coalesce(v_rs.driver_id::text, ''));
  for v_line in select * from public.route_sheet_lines l where l.document_id = v_doc.id order by l.line_no loop
    perform private.check_routed_note(v_doc.company_id, v_line.delivery_note_id::text, v_doc.id);
  end loop;
  select count(*) into v_count from public.route_sheet_lines l where l.document_id = v_doc.id;
  perform private.transition_document(v_doc.id, 'SEND',
    p_summary => format('Salió a repartir con %s: %s con %s', v_doc.display_number, private.notes_count(v_count),
                        private.transport_label(v_rs)));
  update public.route_sheets set departed_at = now() where document_id = v_doc.id;
end;
$$;

-- Rendir la hoja: cada remito queda entregado (con quién lo recibió) o no entregado (con el
-- motivo, y vuelve a estar pendiente para otra hoja); Ventas recibe un aviso por cada uno
-- (cmdCloseRouteSheet). p_lines: [{line_id, delivered, received_by, reason}]
create function public.rs_close(p_document_id uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_lines jsonb := case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]' end;
  v_line public.route_sheet_lines;
  v_dn public.documents;
  v_o jsonb;
  v_delivered boolean;
  v_received text;
  v_reason text;
  v_total int;
  v_ok int := 0;
  v_customer text;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'ROUTE_SHEET');
  perform private.require_transition(v_doc, 'CLOSE');
  perform private.require_permission(v_doc.company_id, 'route_sheet.create');
  if exists (select 1 from jsonb_array_elements(v_lines) as o
              where not exists (select 1 from public.route_sheet_lines l
                                 where l.document_id = v_doc.id and l.id::text = o ->> 'line_id'))
     or (select count(*) from jsonb_array_elements(v_lines))
          <> (select count(distinct o ->> 'line_id') from jsonb_array_elements(v_lines) as o) then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá el resultado de cada remito de la hoja, una sola vez.');
  end if;
  for v_line in select * from public.route_sheet_lines l where l.document_id = v_doc.id order by l.line_no loop
    select d.* into v_dn from public.documents d where d.id = v_line.delivery_note_id;
    v_o := (select o from jsonb_array_elements(v_lines) as o where o ->> 'line_id' = v_line.id::text);
    if v_o is null or jsonb_typeof(v_o -> 'delivered') is distinct from 'boolean' then
      perform private.raise_business_error('DATO_INVALIDO', format('Indicá si %s se entregó o no.', v_dn.display_number));
    end if;
    v_delivered := (v_o ->> 'delivered')::boolean;
    v_received := case when v_delivered then trim(coalesce(v_o ->> 'received_by', '')) else '' end;
    v_reason := case when v_delivered then '' else trim(coalesce(v_o ->> 'reason', '')) end;
    if v_delivered and (length(v_received) < 3 or length(v_received) > 80) then
      perform private.raise_business_error('DATO_INVALIDO',
        format('Indicá quién recibió %s: nombre y apellido, de 3 a 80 caracteres.', v_dn.display_number));
    end if;
    if not v_delivered and (length(v_reason) < 3 or length(v_reason) > 200) then
      perform private.raise_business_error('DATO_INVALIDO',
        format('Indicá por qué no se entregó %s: de 3 a 200 caracteres.', v_dn.display_number));
    end if;
    update public.route_sheet_lines
       set outcome = case when v_delivered then 'ENTREGADO' else 'NO_ENTREGADO' end, received_by = v_received, reason = v_reason
     where id = v_line.id;
    if v_delivered then
      v_ok := v_ok + 1;
    end if;
  end loop;
  select count(*) into v_total from public.route_sheet_lines l where l.document_id = v_doc.id;
  v_actor := private.transition_document(v_doc.id, 'CLOSE',
    p_summary => format('Rindió %s: %s de %s entregados', v_doc.display_number, v_ok, private.notes_count(v_total)));
  update public.route_sheets set closed_at = now() where document_id = v_doc.id;
  for v_line in select * from public.route_sheet_lines l where l.document_id = v_doc.id order by l.line_no loop
    select d.* into v_dn from public.documents d where d.id = v_line.delivery_note_id;
    v_customer := coalesce((select c.legal_name from public.customers c where c.id = v_dn.customer_id), 'El cliente');
    perform private.notify_roles(v_doc.company_id, array['VENTAS'], 'ENTREGA',
      format('%s %s', v_dn.display_number, case when v_line.outcome = 'ENTREGADO' then 'entregado' else 'no se entregó' end),
      case when v_line.outcome = 'ENTREGADO'
        then format('%s lo recibió (%s) con %s.', v_customer, v_line.received_by, v_doc.display_number)
        else format('%s: %s. Vuelve a estar pendiente de entrega.', v_customer, v_line.reason) end,
      private.doc_path(v_dn.id), v_dn.id, null, (v_actor).user_id);
  end loop;
end;
$$;

-- Una hoja en preparación se anula con el motivo: sus remitos siguen pendientes de entrega
-- (cmdCancelRouteSheet).
create function public.rs_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'ROUTE_SHEET');
  perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
end;
$$;

grant execute on function public.rs_create(uuid, jsonb) to authenticated;
grant execute on function public.rs_depart(uuid) to authenticated;
grant execute on function public.rs_close(uuid, jsonb) to authenticated;
grant execute on function public.rs_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- Los remitos despachados pendientes de entrega, para armar una hoja de ruta: los más viejos
-- primero, con la hoja anterior en que no se entregó (routeSheetCandidates).
create function public.route_sheet_candidates(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'route_sheet.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'display_number', d.display_number, 'dispatched_at', x.dispatched_at,
             'sales_order', coalesce(o.display_number, ''),
             'customer', private.customer_stop(d.customer_id),
             'last_attempt', case when l.id is not null
               then jsonb_build_object('display_number', s.display_number, 'reason', l.reason) end)
           order by d.number)
      from public.documents d
      join public.delivery_notes x on x.document_id = d.id
      left join public.documents o on o.id = x.sales_order_id
      left join lateral (select (private.last_route_line(d.id)).*) as l on true
      left join public.documents s on s.id = l.document_id
     where d.company_id = p_company_id and d.doc_type = 'DELIVERY_NOTE' and d.status = 'CONFIRMADO'
       and private.delivery_status(d.id) = 'PENDIENTE'
  ), '[]');
end;
$$;

-- El personal activo, para elegir el chofer: sólo el legajo y el nombre (listDrivers).
create function public.drivers_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'route_sheet.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'file_number', e.file_number, 'name', e.last_name || ', ' || e.first_name)
           order by e.file_number)
      from public.employees e where e.company_id = p_company_id and e.status = 'ACTIVO'
  ), '[]');
end;
$$;

grant execute on function public.route_sheet_candidates(uuid) to authenticated;
grant execute on function public.drivers_list(uuid) to authenticated;

-- Hoja de ruta: con qué sale y los remitos en el orden de visita, con el resultado al rendirla
-- (routeSheetView).
create function private.route_sheet_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'transport', private.transport_label(r),
    'carrier', (select jsonb_build_object('id', c.id, 'code', c.code, 'legal_name', c.legal_name, 'tax_id', c.tax_id,
                                          'phone', c.phone)
                  from public.carriers c where c.id = r.carrier_id),
    'vehicle', (select jsonb_build_object('id', v.id, 'code', v.code, 'plate', v.plate, 'description', v.description)
                  from public.vehicles v where v.id = r.vehicle_id),
    'driver', (select jsonb_build_object('id', e.id, 'file_number', e.file_number, 'name', e.last_name || ', ' || e.first_name)
                 from public.employees e where e.id = r.driver_id),
    'departed_at', r.departed_at,
    'closed_at', r.closed_at,
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no,
               'delivery_note', jsonb_build_object('id', d.id, 'display_number', d.display_number, 'path', private.doc_path(d.id)),
               'sales_order', coalesce(o.display_number, ''),
               'customer', private.customer_stop(d.customer_id),
               'outcome', l.outcome, 'received_by', l.received_by, 'reason', l.reason) order by l.line_no)
        from public.route_sheet_lines l
        join public.documents d on d.id = l.delivery_note_id
        join public.delivery_notes x on x.document_id = d.id
        left join public.documents o on o.id = x.sales_order_id
       where l.document_id = p_doc.id
    ), '[]'))
    from public.route_sheets r where r.document_id = p_doc.id
$$;

-- Igual que antes, y además el estado de entrega: la última hoja de ruta que lo lleva y cómo
-- terminó la visita (deliveryView).
create or replace function private.delivery_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'carrier_name', x.carrier_name, 'dispatched_at', x.dispatched_at,
    'cost_total', (select round(coalesce(sum(round(l.quantity * l.unit_cost, 2)), 0), 2)
                     from public.delivery_note_lines l where l.document_id = p_doc.id),
    'delivery_status', case when p_doc.status = 'CONFIRMADO' then private.delivery_status(p_doc.id) end,
    'route_sheet', case when s.id is not null
      then jsonb_build_object('id', s.id, 'display_number', s.display_number, 'path', private.doc_path(s.id)) end,
    'outcome', r.outcome,
    'received_by', coalesce(r.received_by, ''),
    'delivery_reason', coalesce(r.reason, ''),
    'closed_at', rs.closed_at)
    from public.delivery_notes x
    left join lateral (select (private.last_route_line(p_doc.id)).*) as r on true
    left join public.documents s on s.id = r.document_id
    left join public.route_sheets rs on rs.document_id = s.id
   where x.document_id = p_doc.id
$$;

-- ------------------------------------------------------------------ Lecturas comunes y el remito

-- Igual que antes, y además la hoja de ruta: su transporte y cuándo salió y se rindió (document_json).
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
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at,
               'perception', x.perception))
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
               'received_on', x.received_on, 'retention', x.retention))
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
    || coalesce((
      select jsonb_build_object('py', jsonb_build_object(
               'period', x.period, 'payment_date', x.payment_date, 'rates', x.rates, 'confirmed_at', x.confirmed_at,
               'salaries_paid_on', x.salaries_paid_on, 'salaries_account_id', x.salaries_account_id,
               'charges_paid_on', x.charges_paid_on, 'charges_account_id', x.charges_account_id))
        from public.payrolls x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('tr', jsonb_build_object(
               'tax', x.tax, 'period', x.period, 'due_date', x.due_date, 'tax_amount', x.tax_amount, 'credits', x.credits,
               'previous_balance', x.previous_balance, 'balance_in_favor', x.balance_in_favor,
               'presented_at', x.presented_at, 'paid_on', x.paid_on, 'paid_account_id', x.paid_account_id,
               'base', x.base, 'rate', x.rate))
        from public.tax_returns x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rs', jsonb_build_object(
               'carrier_id', x.carrier_id, 'vehicle_id', x.vehicle_id, 'driver_id', x.driver_id,
               'departed_at', x.departed_at, 'closed_at', x.closed_at))
        from public.route_sheets x where x.document_id = p_doc.id), '{}')
$$;

-- Igual que antes, con la hoja de ruta: se resume por su transporte y cuenta sus remitos.
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
    union all
    select l.line_no, null::uuid from public.payroll_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.route_sheet_lines l where l.document_id = p_doc.id
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
      (select 'Sueldos de ' || private.period_label(x.period) from public.payrolls x where x.document_id = p_doc.id),
      (select case when x.tax = 'IVA' then 'IVA' else 'Ingresos brutos' end || ' de ' || private.period_label(x.period)
         from public.tax_returns x where x.document_id = p_doc.id),
      (select private.transport_label(r) from public.route_sheets r where r.document_id = p_doc.id),
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

-- Igual que antes, con la hoja de ruta: su vista, su lugar en el flujo (después del remito) y sus firmas.
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
    'payroll', case when p_doc.doc_type = 'PAYROLL' then private.payroll_view(p_doc) end,
    'tax_return', case when p_doc.doc_type = 'TAX_RETURN' then private.tax_return_view(p_doc) end,
    'route_sheet', case when p_doc.doc_type = 'ROUTE_SHEET' then private.route_sheet_view(p_doc) end,
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
                              'DELIVERY_NOTE', 'ROUTE_SHEET', 'SALES_INVOICE', 'CUSTOMER_RECEIPT', 'PRODUCTION_ORDER', 'PAYROLL', 'TAX_RETURN',
                              'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
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
      when 'PAYROLL' then jsonb_build_array(
        private.signature(p_doc.id, 'Liquidó', array['CREATE']),
        private.signature(p_doc.id, 'Confirmó', array['CONFIRM']))
      when 'TAX_RETURN' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        private.signature(p_doc.id, 'Presentó', array['CONFIRM']))
      when 'ROUTE_SHEET' then jsonb_build_array(
        private.signature(p_doc.id, 'Armó', array['CREATE']),
        private.signature(p_doc.id, 'Salió', array['SEND']),
        private.signature(p_doc.id, 'Rindió', array['CLOSE']))
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

-- Igual que antes, con la hoja de ruta, y el remito despachado dice si llegó al cliente (nextStep).
create or replace function private.next_step(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sector text := coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), 'el sector solicitante');
  v_route public.route_sheet_lines;
  v_route_number text;
  v_delivery text;
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
    when 'PAYROLL:BORRADOR' then
      return jsonb_build_object('who', 'RRHH',
        'text', case when p_doc.status_reason <> ''
          then format('Gerencia la devolvió: "%s". Corregir las novedades y volver a enviarla a autorizar.',
                      p_doc.status_reason)
          else 'Cargar las novedades del mes de cada empleado (los días o las horas trabajadas, las ausencias sin aviso y las horas extra), revisar los recibos y enviar la liquidación a Gerencia para que la autorice.'
        end);
    when 'PAYROLL:PENDIENTE_APROBACION' then
      return jsonb_build_object('who', 'Gerencia',
        'text', format('Revisar los recibos y los totales (%s netos) y autorizar la liquidación: se registra el asiento de sueldos y Tesorería recibe la tarea de pagar. Si hay que corregir algo, devolverla a RRHH con el motivo.',
                       private.format_money(p_doc.total)));
    when 'PAYROLL:CONFIRMADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar los sueldos el %s: %s netos. Los aportes retenidos y las contribuciones quedan en Cargas sociales a pagar hasta que se depositen.',
                       coalesce((select to_char(x.payment_date, 'DD/MM/YYYY') from public.payrolls x
                                  where x.document_id = p_doc.id), '—'),
                       private.format_money(p_doc.total)));
    when 'PAYROLL:SUELDOS_PAGADOS' then
      return (
        select jsonb_build_object('who', 'Tesorería',
          'text', format('Pagar las cargas sociales antes del %s: %s entre los aportes retenidos a los empleados, las contribuciones de la empresa y lo de los sindicatos.',
                         to_char(private.payroll_charges_due(x.period), 'DD/MM/YYYY'),
                         private.format_money(private.payroll_charges(p_doc.id))))
          from public.payrolls x where x.document_id = p_doc.id);
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
      v_delivery := private.delivery_status(p_doc.id);
      v_route := private.last_route_line(p_doc.id);
      v_route_number := (select d.display_number from public.documents d where d.id = v_route.document_id);
      if v_delivery = 'PROGRAMADO' then
        return jsonb_build_object('who', 'Logística',
          'text', format('Está en la hoja de ruta %s, que todavía no salió.', v_route_number));
      elsif v_delivery = 'EN_CAMINO' then
        return jsonb_build_object('who', 'Logística',
          'text', format('Va en camino al cliente con la hoja de ruta %s: al volver, Logística la rinde.', v_route_number));
      elsif v_delivery = 'ENTREGADO' then
        return jsonb_build_object('who', '—',
          'text', format('Entregado con la hoja de ruta %s: lo recibió %s.', v_route_number, v_route.received_by));
      end if;
      return jsonb_build_object('who', 'Logística',
        'text', case when v_route.id is not null
          then format('No se entregó con %s: %s. Logística lo incluye en otra hoja de ruta.', v_route_number, v_route.reason)
          else 'La mercadería salió del depósito (bajó el stock y se registró el costo de lo vendido). Falta llevarla al cliente: Logística la incluye en una hoja de ruta.' end);
    when 'ROUTE_SHEET:BORRADOR' then
      return jsonb_build_object('who', 'Logística',
        'text', 'Cargar la mercadería de los remitos en el orden de visita, controlar el transporte y salir a repartir: los remitos pasan a "en camino".');
    when 'ROUTE_SHEET:EN_CAMINO' then
      return jsonb_build_object('who', 'Logística',
        'text', 'Al volver, rendir la hoja: qué remitos se entregaron (y quién los recibió) y cuáles no (y por qué). Ventas recibe un aviso por cada uno.');
    when 'TAX_RETURN:BORRADOR' then
      return jsonb_build_object('who', 'Impuestos',
        'text', case when (select t.tax from public.tax_returns t where t.document_id = p_doc.id) = 'IIBB'
          then 'Revisar las ventas netas del mes y las percepciones y retenciones sufridas, y presentar la declaración: se registra el asiento del impuesto.'
          else 'Revisar los libros IVA del mes (el débito y el crédito fiscal) y presentar la declaración: se registra el asiento del impuesto.' end);
    when 'TAX_RETURN:PRESENTADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar %s al fisco (simulado) antes del %s.', private.format_money(p_doc.total),
                       coalesce((select to_char(t.due_date, 'DD/MM/YYYY') from public.tax_returns t
                                  where t.document_id = p_doc.id), '—')));
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



-- Igual que antes, y además no se anula un remito entregado o en una hoja de ruta en curso (cmdCancelDeliveryNote).
create or replace function public.dn_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
  v_dn public.delivery_notes;
  v_order public.documents;
  v_entry public.documents;
  v_reversal public.documents;
  v_line public.delivery_note_lines;
  v_sl public.sales_order_lines;
  v_invoiced numeric;
  v_p public.products;
  v_stockable boolean;
  v_delivery text;
  v_route_number text;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'DELIVERY_NOTE');
  if v_doc.status <> 'CONFIRMADO' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'delivery_note.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and not private.is_supervisor(v_doc.company_id)
     and not exists (select 1 from private.my_role_codes(v_doc.company_id) as rc (code) where rc.code = 'GERENCIA')
     and private.invoice_registrant(v_doc.id) = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES', 'No podés anular un remito que despachaste vos.',
      'Otro integrante de Depósito o Gerencia debe revisar y anular.');
  end if;
  select * into v_dn from public.delivery_notes x where x.document_id = v_doc.id;
  v_order := private.get_document(v_dn.sales_order_id, 'SALES_ORDER');
  if v_order.status = 'CERRADO' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está cerrado: el remito ya no puede anularse.', v_order.display_number));
  end if;
  -- Lo que se entregó, o está en una hoja de ruta en curso, no se anula (Fase 7c.2).
  v_delivery := private.delivery_status(v_doc.id);
  v_route_number := (select d.display_number from public.documents d
                      where d.id = (private.last_route_line(v_doc.id)).document_id);
  if v_delivery = 'ENTREGADO' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s ya se entregó al cliente con %s: no se anula.', v_doc.display_number, v_route_number));
  end if;
  if v_delivery <> 'PENDIENTE' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está en la hoja de ruta %s: primero hay que rendirla o anularla.', v_doc.display_number, v_route_number));
  end if;
  for v_line in select * from public.delivery_note_lines l where l.document_id = v_doc.id order by l.line_no loop
    select * into v_sl from public.sales_order_lines x where x.id = v_line.so_line_id;
    v_invoiced := private.sales_invoiced_quantity(v_sl.id);
    if v_invoiced > round(v_sl.qty_delivered - v_line.quantity, 3) + 0.000000001 then
      v_p := private.product_for(v_doc.company_id, v_line.product_id);
      perform private.raise_business_error('TRANSICION_INVALIDA',
        format('No se puede anular %s: de %s ya se facturaron %s. Primero hay que anular la factura de venta.',
               v_doc.display_number, v_p.code, private.format_qty(v_invoiced, v_p.uom_code)),
        'Lo facturado nunca puede superar lo entregado (control por oposición).');
    end if;
  end loop;
  v_entry := private.automatic_entry_of(v_doc.id);
  if v_entry.id is not null then
    v_reversal := private.reverse_journal_entry(v_entry, v_actor, format('%s anulado: %s', v_doc.display_number, v_comment), true);
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', v_comment, p_actor => v_actor,
    p_summary => format('Anuló %s con contramovimiento%s — %s', v_doc.display_number,
                        case when v_reversal.id is not null then ' y el contraasiento ' || v_reversal.display_number else '' end,
                        v_comment));
  for v_line in select * from public.delivery_note_lines l where l.document_id = v_doc.id order by l.line_no loop
    update public.sales_order_lines set qty_delivered = round(qty_delivered - v_line.quantity, 3) where id = v_line.so_line_id;
    select p.is_stockable into v_stockable from public.products p where p.id = v_line.product_id;
    continue when not v_stockable;
    perform private.post_stock_movement(v_doc.company_id, v_line.product_id, v_dn.warehouse_id, 'ANULACION_DESPACHO',
      v_line.quantity, v_line.unit_cost, v_doc.id, v_line.id, private.business_date(v_doc.company_id));
  end loop;
  perform private.recompute_sales_order(v_order.id);
end;
$$;
