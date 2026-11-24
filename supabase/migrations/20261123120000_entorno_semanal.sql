-- 127. Fase 9d.1 (docs/FASE_9_LA_EMPRESA_CRECE.md): la actividad del entorno, los pedidos de los clientes.
-- El docente genera la semana en curso, una vez: llegan de 8 a 12 pedidos de clientes, recibidos (estado
-- nuevo RECIBIDO), con la tarea de revisarlos para Ventas, que los confirma (el stock y el crédito, como
-- siempre) o los rechaza con el motivo. La misma semana trae siempre lo mismo: un sorteo con semilla fija
-- (el año y el número de la semana). Traducción de "La actividad del entorno" de src/lib/mock/engine.ts y
-- de environmentView de queries.ts.
--
-- El estado, las transiciones, la regla de la tarea y su tipo están en la migración de catálogos siguiente.

-- ------------------------------------------------------------------ Tabla

-- Una semana generada: cuándo, quién y los pedidos que trajo (en el orden en que llegaron).
create table public.environment_weeks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  week text not null check (week ~ '^[0-9]{4}-W[0-9]{2}$'),
  generated_on date not null,
  generated_by uuid,
  order_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (company_id, week)
);

alter table public.environment_weeks enable row level security;
revoke all on table public.environment_weeks from anon, authenticated;
grant select on table public.environment_weeks to authenticated;
-- La ve el docente de la empresa (la genera él, desde el panel).
create policy environment_weeks_select on public.environment_weeks for select to authenticated
  using (company_id in (select private.supervised_companies()));

-- ------------------------------------------------------------------ El pedido recibido

-- Igual que antes, con el estado en que nace: en borrador (lo carga Ventas) o recibido (lo mandó el cliente,
-- insertSalesOrder). Cambia la firma: se borra la anterior para que no queden dos.
drop function private.insert_sales_order(uuid, private.actor, jsonb, jsonb);

create function private.insert_sales_order(p_company_id uuid, p_actor private.actor, p_input jsonb,
                                           p_list_prices jsonb default null, p_status text default 'BORRADOR')
returns public.documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input jsonb := private.sales_input(p_company_id, p_input);
  v_customer public.customers;
  v_number record;
  v_doc public.documents;
begin
  if p_status not in ('BORRADOR', 'RECIBIDO') then
    perform private.raise_business_error('DATO_INVALIDO', 'Un pedido nuevo nace en borrador o recibido.');
  end if;
  select * into v_customer from public.customers c where c.id = (v_input ->> 'customer_id')::uuid;
  select * into v_number from private.next_document_number(p_company_id, 'SALES_ORDER');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, customer_id, notes, created_by)
  values (p_company_id, 'SALES_ORDER', v_number.number, v_number.display_number, p_status, private.business_date(p_company_id),
          (p_actor).sector_id, v_customer.id, trim(coalesce(p_input ->> 'notes', '')), (p_actor).user_id)
  returning * into v_doc;
  insert into public.sales_orders (document_id, company_id, warehouse_id, delivery_date, payment_terms_days, customer_reference)
  values (v_doc.id, p_company_id, (v_input ->> 'warehouse_id')::uuid, (v_input ->> 'delivery_date')::date,
          (v_input ->> 'terms')::int, v_input ->> 'reference');
  insert into public.sales_order_lines (company_id, document_id, line_no, product_id, quantity, list_price, unit_price, vat_rate,
                                        line_subtotal, line_tax, line_total)
  select p_company_id, v_doc.id, x.ord, (x.l ->> 'product_id')::uuid, (x.l ->> 'quantity')::numeric,
         coalesce((p_list_prices ->> (x.l ->> 'product_id'))::numeric, private.list_price_for(v_customer.id, (x.l ->> 'product_id')::uuid)),
         (x.l ->> 'unit_price')::numeric, (x.l ->> 'vat_rate')::numeric,
         (x.l ->> 'subtotal')::numeric, (x.l ->> 'tax')::numeric, (x.l ->> 'subtotal')::numeric + (x.l ->> 'tax')::numeric
    from jsonb_array_elements(v_input -> 'lines') with ordinality as x (l, ord);
  update public.documents d
     set subtotal = t.sub, tax_total = t.tax, total = t.sub + t.tax
    from (select sum(l.line_subtotal) as sub, sum(l.line_tax) as tax
            from public.sales_order_lines l where l.document_id = v_doc.id) as t
   where d.id = v_doc.id
  returning d.* into v_doc;
  perform private.log_audit(p_company_id, p_actor, 'CREATE', 'sales_order', v_doc.id, v_doc.display_number,
    case when p_status = 'RECIBIDO'
         then format('Recibió %s de %s por %s: lo mandó el cliente (%s)', v_doc.display_number, v_customer.legal_name,
                     private.format_money(v_doc.total), v_input ->> 'reference')
         else format('Creó %s a %s por %s', v_doc.display_number, v_customer.legal_name, private.format_money(v_doc.total))
    end,
    v_doc.id, null, p_status);
  return v_doc;
end;
$$;

-- ------------------------------------------------------------------ El sorteo de la semana

-- Un paso del generador congruencial de Numerical Recipes (weekRandom): las cuentas son exactas en bigint,
-- como en el simulador (no pasan de 2^53).
create function private.lcg_next(p_state bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$ select (1664525 * p_state + 1013904223) % 4294967296 $$;

-- El número sorteado con ese estado: de 0 a n − 1.
create function private.lcg_pick(p_state bigint, p_n int)
returns int
language sql
immutable
set search_path = ''
as $$ select (p_state * p_n / 4294967296)::int $$;

-- Los pedidos que mandan los clientes en una semana (weekCustomerOrders), siempre los mismos para la misma
-- semana: de 8 a 12, de clientes que no son consumidor final, con 1 a 3 productos que se venden (de 1 a 5
-- unidades) al precio de su lista, la referencia de su orden de compra y la entrega en el primer día de
-- reparto de su zona desde pasado mañana (sin zona, a la semana). Los sorteos van en el mismo orden que en
-- el simulador: la cantidad de pedidos y, en cada uno, el cliente, la cantidad de productos, cada producto
-- con su cantidad (si ya está, el siguiente) y la referencia.
create function private.week_customer_orders(p_company uuid, p_week text, p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_customers public.customers[];
  v_products public.products[];
  v_state bigint := substr(p_week, 1, 4)::bigint * 100 + substr(p_week, 7)::bigint;
  v_count int;
  v_customer public.customers;
  v_size int;
  v_chosen int[];
  v_k int;
  v_lines jsonb;
  v_delivery date;
  v_orders jsonb := '[]';
begin
  select coalesce(array_agg(c order by c.code collate "C"), '{}') into v_customers
    from public.customers c
   where c.company_id = p_company and c.is_active and c.vat_condition <> 'CONSUMIDOR_FINAL';
  select coalesce(array_agg(p order by p.code collate "C"), '{}') into v_products
    from public.products p
   where p.company_id = p_company and p.is_active and p.is_stockable
     and p.product_type in ('PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA')
     and coalesce(p.sale_price, 0) > 0 and p.default_warehouse_id is not null;
  if cardinality(v_customers) = 0 or cardinality(v_products) = 0 then
    return '[]';
  end if;
  v_state := private.lcg_next(v_state);
  v_count := 8 + private.lcg_pick(v_state, 5);
  for i in 1 .. v_count loop
    v_state := private.lcg_next(v_state);
    v_customer := v_customers[1 + private.lcg_pick(v_state, cardinality(v_customers))];
    v_state := private.lcg_next(v_state);
    v_size := least(1 + private.lcg_pick(v_state, 3), cardinality(v_products));
    v_chosen := '{}';
    v_lines := '[]';
    for j in 1 .. v_size loop
      v_state := private.lcg_next(v_state);
      v_k := private.lcg_pick(v_state, cardinality(v_products));
      while v_k = any (v_chosen) loop
        v_k := (v_k + 1) % cardinality(v_products);
      end loop;
      v_chosen := v_chosen || v_k;
      v_state := private.lcg_next(v_state);
      v_lines := v_lines || jsonb_build_object(
        'product_id', (v_products[v_k + 1]).id,
        'quantity', 1 + private.lcg_pick(v_state, 5),
        'unit_price', private.list_price_for(v_customer.id, (v_products[v_k + 1]).id));
    end loop;
    v_delivery := coalesce((
      select p_today + k
        from generate_series(2, 8) as k
       where exists (select 1 from public.delivery_zones z
                      where z.id = v_customer.zone_id and z.is_active
                        and extract(isodow from p_today + k)::smallint = any (z.delivery_days))
       order by k
       limit 1), p_today + 7);
    v_state := private.lcg_next(v_state);
    v_orders := v_orders || jsonb_build_object(
      'customer_id', v_customer.id,
      'warehouse_id', (v_products[v_chosen[1] + 1]).default_warehouse_id,
      'delivery_date', v_delivery,
      'payment_terms_days', v_customer.payment_terms_days,
      'customer_reference', 'OC ' || (1000 + private.lcg_pick(v_state, 9000)),
      'notes', format('Pedido que mandó el cliente (semana %s).', p_week),
      'lines', v_lines);
  end loop;
  return v_orders;
end;
$$;

-- ------------------------------------------------------------------ RPC

-- El docente genera la actividad de la semana en curso (cmdGenerateEnvironmentWeek), una vez por semana:
-- llegan los pedidos de los clientes, recibidos, con la tarea de revisarlos para Ventas. Los carga el
-- sistema (la auditoría y las tareas lo dicen); la semana queda a nombre del docente.
create function public.environment_week_generate(p_company_id uuid)
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
  insert into public.environment_weeks (company_id, week, generated_on, generated_by, order_ids)
  values (p_company_id, v_week, v_today, (v_actor).user_id, v_ids)
  returning * into v_row;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'environment_week', v_row.id, 'Semana ' || v_week,
    format('Generó la actividad de la semana %s: %s pedidos de clientes', v_week, cardinality(v_ids)));
  return jsonb_build_object('week', v_week, 'orders', to_jsonb(v_numbers));
end;
$$;

-- La actividad del entorno de la empresa (environmentView): la semana en curso, si ya se generó, y las
-- generadas (la última primero) con sus pedidos. La ve el docente.
create function public.environment_view(p_company_id uuid)
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
                   left join public.customers c on c.id = d.customer_id), '[]'))
             order by w.week collate "C" desc)
        from public.environment_weeks w
       where w.company_id = p_company_id), '[]'));
end;
$$;

grant execute on function public.environment_week_generate(uuid) to authenticated;
grant execute on function public.environment_view(uuid) to authenticated;

-- ------------------------------------------------------------------ El próximo paso

-- La versión de la Fase 8f.2 con el pedido que mandó el cliente (nextStep).
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
  v_tax public.tax_returns;
  v_order public.bank_movements;
  v_days int;
  v_fine public.tax_fines;
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
    when 'SALES_ORDER:RECIBIDO' then
      return jsonb_build_object('who', 'Ventas',
        'text', 'Lo mandó el cliente: revisar el stock disponible y su crédito, y confirmarlo para reservar la mercadería, o rechazarlo con el motivo (si falta stock, se carga lo disponible en otro pedido).');
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
    when 'TAX_RETURN:ENVIADA' then
      return jsonb_build_object('who', 'Fisco (Impuestos)',
        'text', 'El fisco la recibe: controla lo declarado con los comprobantes que autorizó en el mes y la acepta con un acuse (se registra el asiento del impuesto) o la observa con el motivo. No la recibe quien la preparó o la presentó.');
    when 'TAX_RETURN:OBSERVADA' then
      return jsonb_build_object('who', 'Impuestos',
        'text', 'El fisco la observó' || coalesce(' con este motivo: «' || nullif(p_doc.status_reason, '') || '»', '')
                || '. Hay que anularla y presentarla de nuevo.');
    when 'TAX_RETURN:PRESENTADA' then
      select * into v_tax from public.tax_returns t where t.document_id = p_doc.id;
      v_days := private.tax_late_days(v_tax.due_date, private.business_date(p_doc.company_id));
      return jsonb_build_object('who', 'Tesorería',
        'text', case when v_days > 0
          then format('Pagar %s al fisco (simulado) por transferencia desde el Banco Aula: venció el %s y a hoy suma %s de intereses resarcitorios (%s días de atraso).',
                      private.format_money(p_doc.total), to_char(v_tax.due_date, 'DD/MM/YYYY'),
                      private.format_money(private.tax_interest(p_doc.total, v_tax.due_date,
                                                                private.business_date(p_doc.company_id))),
                      v_days)
          else format('Pagar %s al fisco (simulado) por transferencia desde el Banco Aula antes del %s.',
                      private.format_money(p_doc.total), to_char(v_tax.due_date, 'DD/MM/YYYY')) end);
    when 'TAX_FINE:NOTIFICADA' then
      select * into v_fine from public.tax_fines f where f.document_id = p_doc.id;
      return jsonb_build_object('who', 'Tesorería',
        'text', case when private.business_date(p_doc.company_id) <= v_fine.reduction_until
          then format('Pagar la multa por transferencia desde el Banco Aula: %s (la mitad) hasta el %s; después, %s.',
                      private.format_money(v_fine.reduced_amount), to_char(v_fine.reduction_until, 'DD/MM/YYYY'),
                      private.format_money(v_fine.amount))
          else format('Pagar %s por transferencia desde el Banco Aula: el plazo de la reducción venció el %s.',
                      private.format_money(v_fine.amount), to_char(v_fine.reduction_until, 'DD/MM/YYYY')) end);
    when 'TAX_FINE:PAGO_EN_BANCO', 'TAX_RETURN:PAGO_EN_BANCO' then
      v_order := private.tax_payment_order(p_doc.id);
      if v_order.status = 'RECHAZADO' then
        return jsonb_build_object('who', 'Tesorería',
          'text', format('El Banco Aula rechazó la orden N.º %s por falta de fondos: hay que reenviarla desde la bandeja del banco cuando haya fondos. Hasta que el banco la procese, el fisco no imputa el pago.',
                         v_order.seq));
      end if;
      return jsonb_build_object('who', 'Banco Aula (Tesorería)',
        'text', format('El pago está en el Banco Aula%s: lo procesa un integrante de Tesorería que no lo envió y, cuando el banco lo debita, el fisco lo imputa.',
                       case when v_order.id is not null then format(' (orden N.º %s)', v_order.seq) else '' end));
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
