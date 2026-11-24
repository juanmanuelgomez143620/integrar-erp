-- 129. Fase 9d.2 (docs/FASE_9_LA_EMPRESA_CRECE.md): las entregas de los proveedores. Al generar la semana,
-- cada orden de compra enviada o recibida en parte cuya entrega comprometida cae hasta el domingo (o sin
-- fecha) recibe el aviso de entrega de su proveedor, salvo que ya tenga uno sin recibir: el remito, el
-- transporte, el día en que llega y lo que trae (todo lo pendiente). Depósito recibe la notificación y la
-- recepción de esa orden se completa con el aviso. Traducción de "La actividad del entorno" de
-- src/lib/mock/engine.ts (weekDeliveryNotices, deliveryNoticeReceived, cmdGenerateEnvironmentWeek) y de
-- environmentView y receivableOrders de queries.ts.

-- ------------------------------------------------------------------ Tabla

-- El aviso de entrega de un proveedor: lo que trae su remito (las líneas de la orden con su cantidad).
create table public.delivery_notices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  week text not null check (week ~ '^[0-9]{4}-W[0-9]{2}$'),
  purchase_order_id uuid not null,
  delivery_note text not null check (length(delivery_note) between 1 and 40),
  carrier_name text not null default '',
  arrives_on date not null,
  lines jsonb not null default '[]',
  created_at timestamptz not null default now(),
  foreign key (company_id, purchase_order_id) references public.documents (company_id, id)
);

create index delivery_notices_order_idx on public.delivery_notices (company_id, purchase_order_id);

alter table public.delivery_notices enable row level security;
revoke all on table public.delivery_notices from anon, authenticated;
grant select on table public.delivery_notices to authenticated;
-- Los ve quien ve las órdenes de compra (Compras y Depósito, que las recibe).
create policy delivery_notices_select on public.delivery_notices for select to authenticated
  using (company_id in (select private.companies_with_permission('purchase_order.read')));

-- ------------------------------------------------------------------ Auxiliares

-- Un aviso ya se recibió si después de él se registró una recepción de su orden (deliveryNoticeReceived).
create function private.delivery_notice_received(p_notice public.delivery_notices)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.documents d
      join public.goods_receipts g on g.document_id = d.id
     where d.doc_type = 'GOODS_RECEIPT' and d.status = 'CONFIRMADO'
       and g.purchase_order_id = p_notice.purchase_order_id
       and g.received_at >= p_notice.created_at)
$$;

-- Los avisos de entrega de una semana (weekDeliveryNotices): las órdenes por número, cada una con su remito
-- del sorteo propio (la semilla de la semana más 7: primero el punto de venta, después el número), el día en
-- que llega (la fecha comprometida o, si ya pasó, hoy) y todo lo pendiente.
create function private.week_delivery_notices(p_company uuid, p_week text, p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sunday date := p_today + (7 - extract(isodow from p_today)::int);
  v_state bigint := substr(p_week, 1, 4)::bigint * 100 + substr(p_week, 7)::bigint + 7;
  v_order record;
  v_point int;
  v_number int;
  v_notices jsonb := '[]';
begin
  for v_order in
    select d.id, po.expected_date
      from public.documents d
      join public.purchase_orders po on po.document_id = d.id
     where d.company_id = p_company and d.doc_type = 'PURCHASE_ORDER' and d.status in ('ENVIADO', 'RECIBIDO_PARCIAL')
       and (po.expected_date is null or po.expected_date <= v_sunday)
       and exists (select 1 from public.purchase_order_lines l
                    where l.document_id = d.id and l.quantity - l.qty_received > 1e-9)
       and not exists (select 1 from public.delivery_notices n
                        where n.purchase_order_id = d.id and not private.delivery_notice_received(n))
     order by d.number
  loop
    v_state := private.lcg_next(v_state);
    v_point := 1 + private.lcg_pick(v_state, 9);
    v_state := private.lcg_next(v_state);
    v_number := 10000 + private.lcg_pick(v_state, 90000);
    v_notices := v_notices || jsonb_build_object(
      'purchase_order_id', v_order.id,
      'delivery_note', lpad(v_point::text, 4, '0') || '-' || lpad(v_number::text, 8, '0'),
      'carrier_name', 'Reparto del proveedor',
      'arrives_on', case when v_order.expected_date > p_today then v_order.expected_date else p_today end,
      'lines', (select jsonb_agg(jsonb_build_object('po_line_id', l.id, 'quantity', l.quantity - l.qty_received)
                                 order by l.line_no)
                  from public.purchase_order_lines l
                 where l.document_id = v_order.id and l.quantity - l.qty_received > 1e-9));
  end loop;
  return v_notices;
end;
$$;

-- ------------------------------------------------------------------ RPC

-- Igual que la 9d.1, con los avisos de entrega de los proveedores después de los pedidos de los clientes:
-- cada uno se le notifica a Depósito con el enlace a la orden de compra (cmdGenerateEnvironmentWeek).
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
  v_deliveries text := '';
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
  insert into public.environment_weeks (company_id, week, generated_on, generated_by, order_ids)
  values (p_company_id, v_week, v_today, (v_actor).user_id, v_ids)
  returning * into v_row;
  if cardinality(v_noticed) > 0 then
    v_deliveries := format(' y %s %s de entrega de proveedores', cardinality(v_noticed),
                           case when cardinality(v_noticed) = 1 then 'aviso' else 'avisos' end);
  end if;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'environment_week', v_row.id, 'Semana ' || v_week,
    format('Generó la actividad de la semana %s: %s pedidos de clientes%s', v_week, cardinality(v_ids), v_deliveries));
  return jsonb_build_object('week', v_week, 'orders', to_jsonb(v_numbers), 'notices', to_jsonb(v_noticed));
end;
$$;

-- Igual que la 9d.1, con los avisos de entrega de cada semana, por número de orden (environmentView).
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
                  where n.company_id = p_company_id and n.week = w.week), '[]'))
             order by w.week collate "C" desc)
        from public.environment_weeks w
       where w.company_id = p_company_id), '[]'));
end;
$$;

-- Igual que antes, con el último aviso de entrega sin recibir de cada orden (receivableOrders).
create or replace function public.orders_receivable(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'purchase_order.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'order', private.document_item(d),
             'lines', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'line', to_jsonb(l), 'product', to_jsonb(p), 'pending', l.quantity - l.qty_received) order by l.line_no)
                 from public.purchase_order_lines l join public.products p on p.id = l.product_id
                where l.document_id = d.id and l.quantity - l.qty_received > 1e-9
             ), '[]'),
             'notice', (
               select jsonb_build_object('delivery_note', n.delivery_note, 'carrier_name', n.carrier_name,
                                         'arrives_on', n.arrives_on, 'lines', n.lines)
                 from public.delivery_notices n
                where n.purchase_order_id = d.id and not private.delivery_notice_received(n)
                order by n.created_at desc
                limit 1)) order by d.number)
      from public.documents d
     where d.company_id = p_company_id and d.doc_type = 'PURCHASE_ORDER' and d.status in ('ENVIADO', 'RECIBIDO_PARCIAL')
  ), '[]');
end;
$$;
