-- 130. Fase 9d.3 (docs/FASE_9_LA_EMPRESA_CRECE.md): el parte de novedades del personal. Cada semana generada
-- trae el de la semana anterior, de lunes a sábado: de 0 a 2 ausencias sin aviso (de legajos distintos, de
-- lunes a viernes) y de 2 a 5 registros de horas extra (de 2 a 4 horas; los sábados, al 100 %), con su día.
-- RRHH recibe la notificación y lo carga en la liquidación del mes de cada día. Traducción de
-- weekStaffNovelties, staffReportFrom y cmdGenerateEnvironmentWeek de src/lib/mock/engine.ts y de
-- environmentView y staffReport de queries.ts.

-- ------------------------------------------------------------------ Tabla

-- Una novedad del parte: una ausencia sin aviso (sin horas) o horas extra al 50 o al 100 %, con su día.
create table public.staff_novelties (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  week text not null check (week ~ '^[0-9]{4}-W[0-9]{2}$'),
  employee_id uuid not null,
  day date not null,
  kind text not null check (kind in ('AUSENCIA', 'EXTRA_50', 'EXTRA_100')),
  hours numeric(6, 2) not null default 0 check (hours >= 0),
  created_at timestamptz not null default now(),
  foreign key (company_id, employee_id) references public.employees (company_id, id)
);

create index staff_novelties_employee_idx on public.staff_novelties (company_id, employee_id);

alter table public.staff_novelties enable row level security;
revoke all on table public.staff_novelties from anon, authenticated;
grant select on table public.staff_novelties to authenticated;
-- Lo ve quien ve las liquidaciones (RRHH, Gerencia y Tesorería).
create policy staff_novelties_select on public.staff_novelties for select to authenticated
  using (company_id in (select private.companies_with_permission('payroll.read')));

-- ------------------------------------------------------------------ El sorteo del parte

-- El lunes de la semana anterior: el parte que llega en una semana es el de la anterior (staffReportFrom).
create function private.staff_report_from(p_today date)
returns date
language sql
immutable
set search_path = ''
as $$ select p_today + (1 - extract(isodow from p_today)::int - 7) $$;

-- El parte de una semana (weekStaffNovelties): los legajos activos que ya habían ingresado ese lunes, por
-- número, y el sorteo con la semilla de la semana más 13, en el mismo orden que el simulador: cuántas
-- ausencias y, de cada una, el legajo (si ya faltó, el siguiente) y el día; cuántas horas extra y, de cada
-- registro, el legajo, el día y las horas.
create function private.week_staff_novelties(p_company uuid, p_week text, p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date := private.staff_report_from(p_today);
  v_employees uuid[];
  v_count int;
  v_state bigint := substr(p_week, 1, 4)::bigint * 100 + substr(p_week, 7)::bigint + 13;
  v_absences int;
  v_overtime int;
  v_absent int[] := '{}';
  v_k int;
  v_offset int;
  v_hours int;
  v_out jsonb := '[]';
begin
  select coalesce(array_agg(e.id order by e.file_number), '{}') into v_employees
    from public.employees e
   where e.company_id = p_company and e.status = 'ACTIVO' and e.hire_date <= v_from;
  v_count := cardinality(v_employees);
  if v_count = 0 then
    return '[]';
  end if;
  v_state := private.lcg_next(v_state);
  v_absences := least(private.lcg_pick(v_state, 3), v_count);
  for i in 1 .. v_absences loop
    v_state := private.lcg_next(v_state);
    v_k := private.lcg_pick(v_state, v_count);
    while v_k = any (v_absent) loop
      v_k := (v_k + 1) % v_count;
    end loop;
    v_absent := v_absent || v_k;
    v_state := private.lcg_next(v_state);
    v_out := v_out || jsonb_build_object('employee_id', v_employees[v_k + 1], 'day', v_from + private.lcg_pick(v_state, 5),
                                         'kind', 'AUSENCIA', 'hours', 0);
  end loop;
  v_state := private.lcg_next(v_state);
  v_overtime := 2 + private.lcg_pick(v_state, 4);
  for i in 1 .. v_overtime loop
    v_state := private.lcg_next(v_state);
    v_k := private.lcg_pick(v_state, v_count);
    v_state := private.lcg_next(v_state);
    v_offset := private.lcg_pick(v_state, 6);
    v_state := private.lcg_next(v_state);
    v_hours := 2 + private.lcg_pick(v_state, 3);
    v_out := v_out || jsonb_build_object('employee_id', v_employees[v_k + 1], 'day', v_from + v_offset,
                                         'kind', case when v_offset = 5 then 'EXTRA_100' else 'EXTRA_50' end,
                                         'hours', v_hours);
  end loop;
  return v_out;
end;
$$;

-- ------------------------------------------------------------------ RPC

-- Igual que la 9d.2, con el parte de novedades del personal después de los avisos: se le notifica a RRHH,
-- y la auditoría de la semana cuenta las tres cosas (cmdGenerateEnvironmentWeek).
create or replace function public.environment_week_generate(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_system private.actor := row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor;
  v_today date := private.business_date(p_company_id);
  v_week text := to_char(v_today, 'IYYY-"W"IW');
  v_inputs jsonb;
  v_input jsonb;
  v_doc public.documents;
  v_ids uuid[] := '{}';
  v_numbers text[] := '{}';
  v_notice public.delivery_notices;
  v_order public.documents;
  v_noticed text[] := '{}';
  v_staff jsonb;
  v_from date := private.staff_report_from(v_today);
  v_absences int;
  v_hours int;
  v_row public.environment_weeks;
begin
  if exists (select 1 from public.environment_weeks w where w.company_id = p_company_id and w.week = v_week) then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('La actividad de la semana %s ya se generó: la próxima, desde el lunes.', v_week));
  end if;
  v_inputs := private.week_customer_orders(p_company_id, v_week, v_today);
  if jsonb_array_length(v_inputs) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'No hay clientes ni productos para vender: la semana no trae pedidos.');
  end if;
  for v_input in select x.input from jsonb_array_elements(v_inputs) with ordinality as x (input, ord) order by x.ord loop
    v_doc := private.insert_sales_order(p_company_id, v_system, v_input, null, 'RECIBIDO');
    perform private.open_tasks_for_status(v_doc.id, v_system);
    v_ids := v_ids || v_doc.id;
    v_numbers := v_numbers || v_doc.display_number;
  end loop;
  -- Los avisos se calculan antes de guardar el primero: la lista no cambia mientras se guardan.
  for v_input in
    select x.notice
      from jsonb_array_elements(private.week_delivery_notices(p_company_id, v_week, v_today)) with ordinality as x (notice, ord)
     order by x.ord
  loop
    insert into public.delivery_notices (company_id, week, purchase_order_id, delivery_note, carrier_name, arrives_on, lines)
    values (p_company_id, v_week, (v_input ->> 'purchase_order_id')::uuid, v_input ->> 'delivery_note',
            v_input ->> 'carrier_name', (v_input ->> 'arrives_on')::date, v_input -> 'lines')
    returning * into v_notice;
    select * into v_order from public.documents d where d.id = v_notice.purchase_order_id;
    perform private.notify_roles(p_company_id, array['DEPOSITO'], 'AVISO_ENTREGA',
      format('%s entrega %s el %s',
             (select s.legal_name from public.suppliers s where s.id = v_order.supplier_id),
             v_order.display_number, to_char(v_notice.arrives_on, 'DD/MM/YYYY')),
      format('Llega con el remito %s (%s): recibila y controlala contra la orden de compra y el remito.',
             v_notice.delivery_note, v_notice.carrier_name),
      private.doc_path(v_order.id), v_order.id);
    v_noticed := v_noticed || v_order.display_number;
  end loop;
  -- El parte de novedades del personal de la semana anterior, para RRHH.
  v_staff := private.week_staff_novelties(p_company_id, v_week, v_today);
  insert into public.staff_novelties (company_id, week, employee_id, day, kind, hours)
  select p_company_id, v_week, (x.n ->> 'employee_id')::uuid, (x.n ->> 'day')::date, x.n ->> 'kind', (x.n ->> 'hours')::numeric
    from jsonb_array_elements(v_staff) as x (n);
  if jsonb_array_length(v_staff) > 0 then
    select count(*) filter (where x.n ->> 'kind' = 'AUSENCIA'), coalesce(sum((x.n ->> 'hours')::int), 0)
      into v_absences, v_hours
      from jsonb_array_elements(v_staff) as x (n);
    perform private.notify_roles(p_company_id, array['RRHH'], 'PARTE_NOVEDADES',
      format('Llegó el parte de novedades del %s al %s', to_char(v_from, 'DD/MM/YYYY'), to_char(v_from + 5, 'DD/MM/YYYY')),
      format('%s %s sin aviso y %s horas extra: cargalo en la liquidación del mes desde RRHH → Liquidaciones.',
             v_absences, case when v_absences = 1 then 'ausencia' else 'ausencias' end, v_hours),
      '/e/' || (select c.slug from public.companies c where c.id = p_company_id) || '/rrhh/liquidaciones');
  end if;
  insert into public.environment_weeks (company_id, week, generated_on, generated_by, order_ids)
  values (p_company_id, v_week, v_today, (v_actor).user_id, v_ids)
  returning * into v_row;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'environment_week', v_row.id, 'Semana ' || v_week,
    format('Generó la actividad de la semana %s: %s pedidos de clientes, %s %s de entrega de proveedores y %s %s del personal',
           v_week, cardinality(v_ids), cardinality(v_noticed),
           case when cardinality(v_noticed) = 1 then 'aviso' else 'avisos' end, jsonb_array_length(v_staff),
           case when jsonb_array_length(v_staff) = 1 then 'novedad' else 'novedades' end));
  return jsonb_build_object('week', v_week, 'orders', to_jsonb(v_numbers), 'notices', to_jsonb(v_noticed),
                            'novelties', jsonb_array_length(v_staff));
end;
$$;

-- Igual que la 9d.2, con el resumen del parte de cada semana: las ausencias y las horas extra (environmentView).
create or replace function public.environment_view(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_current text;
begin
  perform private.require_active_user();
  if not private.is_supervisor(p_company_id) then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo docentes');
  end if;
  v_current := to_char(private.business_date(p_company_id), 'IYYY-"W"IW');
  return jsonb_build_object(
    'current', v_current,
    'generated', exists (select 1 from public.environment_weeks w where w.company_id = p_company_id and w.week = v_current),
    'weeks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'week', w.week,
               'generated_on', w.generated_on,
               'generated_by_name', private.full_name(w.generated_by),
               'orders', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', d.id,
                          'display_number', d.display_number,
                          'customer', coalesce(c.legal_name, ''),
                          'total', d.total,
                          'status', d.status) order by x.ord)
                   from unnest(w.order_ids) with ordinality as x (id, ord)
                   join public.documents d on d.id = x.id
                   left join public.customers c on c.id = d.customer_id), '[]'),
               'notices', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'purchase_order', d.display_number,
                          'supplier', coalesce(s.legal_name, ''),
                          'delivery_note', n.delivery_note,
                          'arrives_on', n.arrives_on,
                          'received', private.delivery_notice_received(n)) order by d.number)
                   from public.delivery_notices n
                   join public.documents d on d.id = n.purchase_order_id
                   left join public.suppliers s on s.id = d.supplier_id
                  where n.company_id = p_company_id and n.week = w.week), '[]'),
               'staff', (
                 select jsonb_build_object('absences', count(*) filter (where s.kind = 'AUSENCIA'),
                                           'overtime_hours', coalesce(sum(s.hours), 0))
                   from public.staff_novelties s
                  where s.company_id = p_company_id and s.week = w.week))
             order by w.week collate "C" desc)
        from public.environment_weeks w
       where w.company_id = p_company_id), '[]'));
end;
$$;

-- El parte de novedades de un mes (aaaa-mm), por legajo: lo que RRHH carga en la liquidación; cada novedad
-- cuenta para el mes de su día (staffReport).
create function public.staff_report(p_company_id uuid, p_period text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'payroll.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'employee_id', x.employee_id,
             'absence_days', x.absences,
             'overtime_50', x.overtime_50,
             'overtime_100', x.overtime_100) order by x.file_number)
      from (
        select n.employee_id, e.file_number,
               count(*) filter (where n.kind = 'AUSENCIA') as absences,
               coalesce(sum(n.hours) filter (where n.kind = 'EXTRA_50'), 0) as overtime_50,
               coalesce(sum(n.hours) filter (where n.kind = 'EXTRA_100'), 0) as overtime_100
          from public.staff_novelties n
          join public.employees e on e.id = n.employee_id
         where n.company_id = p_company_id and to_char(n.day, 'YYYY-MM') = p_period
         group by n.employee_id, e.file_number
      ) x
  ), '[]');
end;
$$;

grant execute on function public.staff_report(uuid, text) to authenticated;
