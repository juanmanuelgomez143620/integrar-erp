-- 31. Fase 4a (docs/FASE_4_VENTAS_Y_CLIENTES.md §2 y §3): pedido de venta con
-- control de crédito y reserva de stock, y remito que descuenta el stock y
-- registra el costo de lo vendido. Traducción de las secciones "Pedidos de
-- venta" y "Remitos" de src/lib/mock/engine.ts y de sus lecturas en
-- queries.ts, con los mismos mensajes y la misma forma de datos.
--
-- Los tipos de documento, sus estados, transiciones, tareas, permisos, tipos de
-- movimiento de stock y claves de imputación están en la migración de catálogos
-- siguiente; las reglas base del costo de lo vendido, en la de la plantilla.

-- ------------------------------------------------------------------ Stock reservado

-- Lo reservado sale de los pedidos en curso (lo que les falta entregar): el
-- saldo de stock ya no lo guarda aparte (como el paso v7 → v8 del simulador).
alter table public.stock_balances drop column qty_reserved;

-- ------------------------------------------------------------------ Tablas

-- Pedido de venta: 1 a 1 con documents (tipo SALES_ORDER).
create table public.sales_orders (
  document_id uuid primary key,
  doc_type text not null default 'SALES_ORDER' check (doc_type = 'SALES_ORDER'),
  company_id uuid not null,
  warehouse_id uuid not null,             -- desde dónde se entrega: ahí se reserva el stock
  delivery_date date,                     -- la que pidió el cliente (opcional)
  payment_terms_days int not null check (payment_terms_days between 0 and 365),
  customer_reference text not null default '',
  credit_reason text not null default '', -- por qué necesitó la autorización de Gerencia
  confirmed_at timestamptz,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, warehouse_id) references public.warehouses (company_id, id)
);

create table public.sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  list_price numeric(14, 4) not null,     -- precio de venta del producto al cargarlo: la bonificación se mide contra él
  unit_price numeric(14, 4) not null check (unit_price > 0),
  vat_rate numeric(5, 2) not null,
  line_subtotal numeric(14, 2) not null,
  line_tax numeric(14, 2) not null,
  line_total numeric(14, 2) not null,
  qty_delivered numeric(14, 3) not null default 0,
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.sales_orders (company_id, document_id) on delete cascade,
  foreign key (company_id, product_id) references public.products (company_id, id)
);
create index sales_order_lines_product_idx on public.sales_order_lines (product_id);

-- Remito: 1 a 1 con documents (tipo DELIVERY_NOTE), contra un pedido de venta.
create table public.delivery_notes (
  document_id uuid primary key,
  doc_type text not null default 'DELIVERY_NOTE' check (doc_type = 'DELIVERY_NOTE'),
  company_id uuid not null,
  sales_order_id uuid not null,
  warehouse_id uuid not null,
  carrier_name text not null default '',
  dispatched_at timestamptz,              -- cuándo salió la mercadería
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, sales_order_id) references public.sales_orders (company_id, document_id),
  foreign key (company_id, warehouse_id) references public.warehouses (company_id, id)
);
create index delivery_notes_order_idx on public.delivery_notes (sales_order_id);

create table public.delivery_note_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  so_line_id uuid not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_cost numeric(14, 4) not null default 0, -- el costo promedio con que salió (al despacharlo)
  notes text not null default '',
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.delivery_notes (company_id, document_id) on delete cascade,
  foreign key (company_id, so_line_id) references public.sales_order_lines (company_id, id),
  foreign key (company_id, product_id) references public.products (company_id, id)
);
create index delivery_note_lines_so_line_idx on public.delivery_note_lines (so_line_id);

do $$
declare
  t text;
begin
  foreach t in array array['sales_orders', 'sales_order_lines', 'delivery_notes', 'delivery_note_lines'] loop
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

create policy sales_orders_select on public.sales_orders for select to authenticated
  using (company_id in (select private.companies_with_permission('sales_order.read')));
create policy sales_order_lines_select on public.sales_order_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('sales_order.read')));
create policy delivery_notes_select on public.delivery_notes for select to authenticated
  using (company_id in (select private.companies_with_permission('delivery_note.read')));
create policy delivery_note_lines_select on public.delivery_note_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('delivery_note.read')));

-- ------------------------------------------------------------------ Pedidos de venta: auxiliares

-- Pedidos en curso: lo que les falta entregar está reservado (ACTIVE_SALES_STATUSES).
create function private.active_sales_statuses()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['PENDIENTE_APROBACION', 'CONFIRMADO', 'ENTREGADO_PARCIAL'] $$;

-- Lo que hay de un producto en un depósito (onHandQuantity).
create function private.on_hand_quantity(p_product uuid, p_warehouse uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select b.qty_on_hand from public.stock_balances b
                    where b.product_id = p_product and b.warehouse_id = p_warehouse), 0)
$$;

-- Lo reservado de un producto en un depósito: lo que les falta entregar a los pedidos en curso, salvo uno (reservedQuantity).
create function private.reserved_quantity(p_product uuid, p_warehouse uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(greatest(l.quantity - l.qty_delivered, 0)), 0), 3)
    from public.sales_order_lines l
    join public.sales_orders so on so.document_id = l.document_id
    join public.documents d on d.id = l.document_id
   where l.product_id = p_product and so.warehouse_id = p_warehouse
     and d.status = any (private.active_sales_statuses()) and d.id is distinct from p_except
$$;

-- Importe con IVA de una cantidad, redondeado como las líneas: neto e IVA por separado (amountWithVat).
create function private.amount_with_vat(p_quantity numeric, p_unit_price numeric, p_vat_rate numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(round(p_quantity * p_unit_price, 2) + round(round(p_quantity * p_unit_price, 2) * p_vat_rate / 100, 2), 2)
$$;

-- Lo que un pedido usa del crédito del cliente, con IVA: lo pedido si sigue en curso, lo entregado si terminó (creditUsedByOrder).
create function private.credit_used_by_order(p_order uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(private.amount_with_vat(
           case when d.status = any (private.active_sales_statuses()) then l.quantity else l.qty_delivered end,
           l.unit_price, l.vat_rate)), 0), 2)
    from public.sales_order_lines l join public.documents d on d.id = l.document_id
   where l.document_id = p_order
$$;

-- El crédito que usa un cliente: sus pedidos todavía sin facturar, salvo uno (customerCreditUsed).
create function private.customer_credit_used(p_customer uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(private.credit_used_by_order(d.id)), 0), 2)
    from public.documents d
   where d.doc_type = 'SALES_ORDER' and d.customer_id = p_customer and d.id is distinct from p_except
     and d.status = any (private.active_sales_statuses() || array['ENTREGADO', 'CERRADO'])
$$;

-- Por qué el pedido necesita la autorización de Gerencia; vacío si alcanza el crédito (creditReason).
create function private.credit_reason(p_doc public.documents)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when c.credit_limit is null then ''
           when round(private.customer_credit_used(c.id, p_doc.id) + p_doc.total, 2) <= c.credit_limit + 0.000000001 then ''
           else format('Supera el límite de crédito de %s (%s): con este pedido llegaría a %s entre lo que debe y lo pedido sin facturar.',
                       c.legal_name, private.format_money(c.credit_limit),
                       private.format_money(round(private.customer_credit_used(c.id, p_doc.id) + p_doc.total, 2)))
         end
    from public.customers c where c.id = p_doc.customer_id
$$;

-- Un remito en preparación de un pedido (draftDeliveryOf).
create function private.draft_delivery_of(p_order uuid)
returns public.documents
language sql
stable
security definer
set search_path = ''
as $$
  select d.* from public.delivery_notes x join public.documents d on d.id = x.document_id
   where x.sales_order_id = p_order and d.status = 'BORRADOR'
   order by d.number
   limit 1
$$;

-- Hay que despachar o anular el remito en preparación antes de anular o cerrar el pedido (assertNoDraftDelivery).
create function private.assert_no_draft_delivery(p_order public.documents)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_draft public.documents := private.draft_delivery_of(p_order.id);
begin
  if v_draft.id is not null then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está en preparación para %s: Depósito tiene que despacharlo o anularlo primero.',
             v_draft.display_number, p_order.display_number));
  end if;
end;
$$;

-- Estado del pedido según lo entregado: confirmado, entregado parcialmente o entregado (recomputeSalesOrder).
create function private.recompute_sales_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_full boolean;
  v_some boolean;
  v_target text;
begin
  select d.status into v_status from public.documents d where d.id = p_order;
  if v_status not in ('CONFIRMADO', 'ENTREGADO_PARCIAL', 'ENTREGADO') then
    return;
  end if;
  select bool_and(l.qty_delivered >= l.quantity), bool_or(l.qty_delivered > 0) into v_full, v_some
    from public.sales_order_lines l where l.document_id = p_order;
  v_target := case when v_full then 'ENTREGADO' when v_some then 'ENTREGADO_PARCIAL' else 'CONFIRMADO' end;
  if v_target <> v_status then
    perform private.transition_document(p_order, 'SYSTEM', null, v_target);
  end if;
end;
$$;

-- Confirmar: controla el stock disponible de cada ítem (lo que hay menos lo
-- reservado para otros pedidos) y el crédito del cliente. Si alcanza el
-- crédito, queda confirmado; si no, espera la autorización de Gerencia. En los
-- dos casos lo que falta entregar queda reservado (confirmSalesOrder).
create function private.confirm_sales_order(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_so public.sales_orders;
  v_warehouse public.warehouses;
  v_line public.sales_order_lines;
  v_p public.products;
  v_on_hand numeric;
  v_reserved numeric;
  v_available numeric;
  v_customer public.customers;
  v_reason text;
begin
  perform private.require_transition(p_doc, 'CONFIRM');
  select * into v_so from public.sales_orders x where x.document_id = p_doc.id;
  -- El depósito queda bloqueado: dos pedidos no reservan a la vez la misma mercadería.
  select * into v_warehouse from public.warehouses w where w.id = v_so.warehouse_id for update;
  if not coalesce((select (c.settings ->> 'allow_negative_stock')::boolean from public.companies c where c.id = p_doc.company_id), false) then
    for v_line in select * from public.sales_order_lines l where l.document_id = p_doc.id order by l.line_no loop
      v_p := private.product_for(p_doc.company_id, v_line.product_id);
      continue when not v_p.is_stockable;
      v_on_hand := private.on_hand_quantity(v_p.id, v_warehouse.id);
      v_reserved := private.reserved_quantity(v_p.id, v_warehouse.id, p_doc.id);
      v_available := round(v_on_hand - v_reserved, 3);
      if v_line.quantity > v_available + 0.000000001 then
        perform private.raise_business_error('STOCK_INSUFICIENTE',
          format('%s: hay %s en %s%s; quedan %s disponibles y el pedido lleva %s.', v_p.code,
                 private.format_qty(v_on_hand, v_p.uom_code), v_warehouse.name,
                 case when v_reserved > 0
                   then format(' y %s están reservados para otros pedidos', private.format_qty(v_reserved, v_p.uom_code))
                   else '' end,
                 private.format_qty(greatest(v_available, 0), v_p.uom_code), private.format_qty(v_line.quantity, v_p.uom_code)),
          'Falta stock: pedí lo disponible y el resto en otro pedido cuando haya mercadería (la repone Compras o la fabrica Producción).');
      end if;
    end loop;
  end if;
  select * into v_customer from public.customers c where c.id = p_doc.customer_id;
  v_reason := private.credit_reason(p_doc);
  update public.sales_orders
     set credit_reason = v_reason, confirmed_at = case when v_reason = '' then now() end
   where document_id = p_doc.id;
  perform private.transition_document(p_doc.id, 'CONFIRM', null,
    case when v_reason = '' then 'CONFIRMADO' else 'PENDIENTE_APROBACION' end,
    p_summary => case when v_reason = ''
      then format('Confirmó %s a %s por %s y reservó la mercadería', p_doc.display_number, v_customer.legal_name,
                  private.format_money(p_doc.total))
      else format('Confirmó %s a %s por %s: supera el crédito del cliente y lo autoriza Gerencia', p_doc.display_number,
                  v_customer.legal_name, private.format_money(p_doc.total))
    end);
end;
$$;

-- ------------------------------------------------------------------ Pedidos de venta: comandos

-- p_input: {customer_id, warehouse_id, delivery_date, payment_terms_days, customer_reference, notes,
--           lines: [{product_id, quantity, unit_price}]} (cmdCreateSalesOrder)
create function public.so_create(p_company_id uuid, p_input jsonb, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'sales_order.create');
  v_company public.companies;
  v_customer public.customers;
  v_terms numeric;
  v_delivery date;
  v_reference text := trim(coalesce(p_input ->> 'customer_reference', ''));
  v_line jsonb;
  v_p public.products;
  v_seen uuid[] := '{}';
  v_quantity numeric;
  v_price numeric;
  v_vat numeric;
  v_subtotal numeric;
  v_lines jsonb := '[]';
  v_number record;
  v_doc public.documents;
begin
  select * into v_company from public.companies c where c.id = p_company_id;
  select * into v_customer from public.customers c where c.company_id = p_company_id and c.id::text = p_input ->> 'customer_id';
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el cliente.');
  end if;
  if not v_customer.is_active then
    perform private.raise_business_error('DATO_INVALIDO', format('El cliente %s está inactivo.', v_customer.legal_name));
  end if;
  if not exists (select 1 from public.warehouses w where w.company_id = p_company_id and w.id::text = p_input ->> 'warehouse_id') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el depósito desde el que se entrega.');
  end if;
  v_terms := (p_input ->> 'payment_terms_days')::numeric;
  if v_terms is null or v_terms < 0 or v_terms > 365 or v_terms <> trunc(v_terms) then
    perform private.raise_business_error('DATO_INVALIDO', 'La condición de pago es una cantidad entera de días, de 0 (contado) a 365.');
  end if;
  if p_input ->> 'delivery_date' is not null then
    v_delivery := private.parse_date(p_input ->> 'delivery_date');
    if v_delivery is null then
      perform private.raise_business_error('DATO_INVALIDO', 'La fecha de entrega no es válida.');
    end if;
    if v_delivery < private.business_date(p_company_id) then
      perform private.raise_business_error('DATO_INVALIDO', 'La fecha de entrega pedida no puede ser anterior a hoy.');
    end if;
  end if;
  if length(v_reference) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'La referencia del cliente tiene hasta 60 caracteres.');
  end if;
  for v_line in
    select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) with ordinality as x (l, ord)
     where nullif(l ->> 'product_id', '') is not null
     order by ord
  loop
    select * into v_p from public.products p where p.company_id = p_company_id and p.id::text = v_line ->> 'product_id';
    if not found then
      perform private.raise_business_error('PRODUCTO_INEXISTENTE', 'El producto no existe en esta empresa.');
    end if;
    if not v_p.is_active then
      perform private.raise_business_error('DATO_INVALIDO', format('%s %s está inactivo.', v_p.code, v_p.name));
    end if;
    if v_p.product_type not in ('PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO') then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s es %s: no se vende.', v_p.code,
               case v_p.product_type when 'MATERIA_PRIMA' then 'materia prima' when 'INSUMO' then 'insumo' else lower(v_p.product_type) end),
        'Se venden los productos terminados, las mercaderías de reventa y los servicios.');
    end if;
    if v_p.id = any (v_seen) then
      perform private.raise_business_error('DATO_INVALIDO', format('%s está dos veces: sumá las cantidades en un solo ítem.', v_p.code));
    end if;
    v_seen := v_seen || v_p.id;
    v_quantity := (v_line ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 or round(v_quantity, 3) <> v_quantity then
      perform private.raise_business_error('DATO_INVALIDO',
        format('La cantidad de %s debe ser mayor que cero y tener hasta 3 decimales.', v_p.code));
    end if;
    v_price := (v_line ->> 'unit_price')::numeric;
    if v_price is null or v_price <= 0 or round(v_price, 4) <> v_price then
      perform private.raise_business_error('DATO_INVALIDO',
        format('El precio de %s debe ser mayor que cero y tener hasta 4 decimales.', v_p.code));
    end if;
    -- Quien no es responsable inscripto no factura IVA: su precio es el final.
    v_vat := case when v_company.vat_condition = 'RESPONSABLE_INSCRIPTO' then v_p.vat_rate else 0 end;
    if v_quantity * v_price * (1 + v_vat / 100) >= 1000000000000 then
      perform private.raise_business_error('DATO_INVALIDO', format('El importe de %s es demasiado grande.', v_p.code));
    end if;
    v_subtotal := round(v_quantity * v_price, 2);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_p.id, 'quantity', v_quantity, 'list_price', coalesce(v_p.sale_price, 0), 'unit_price', v_price,
      'vat_rate', v_vat, 'subtotal', v_subtotal, 'tax', round(v_subtotal * v_vat / 100, 2)));
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Agregá al menos un ítem.');
  end if;

  select * into v_number from private.next_document_number(p_company_id, 'SALES_ORDER');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, customer_id, notes, created_by)
  values (p_company_id, 'SALES_ORDER', v_number.number, v_number.display_number, 'BORRADOR', private.business_date(p_company_id),
          (v_actor).sector_id, v_customer.id, trim(coalesce(p_input ->> 'notes', '')), (v_actor).user_id)
  returning * into v_doc;
  insert into public.sales_orders (document_id, company_id, warehouse_id, delivery_date, payment_terms_days, customer_reference)
  values (v_doc.id, p_company_id, (p_input ->> 'warehouse_id')::uuid, v_delivery, v_terms::int, v_reference);
  insert into public.sales_order_lines (company_id, document_id, line_no, product_id, quantity, list_price, unit_price, vat_rate,
                                        line_subtotal, line_tax, line_total)
  select p_company_id, v_doc.id, x.ord, (x.l ->> 'product_id')::uuid, (x.l ->> 'quantity')::numeric,
         (x.l ->> 'list_price')::numeric, (x.l ->> 'unit_price')::numeric, (x.l ->> 'vat_rate')::numeric,
         (x.l ->> 'subtotal')::numeric, (x.l ->> 'tax')::numeric, (x.l ->> 'subtotal')::numeric + (x.l ->> 'tax')::numeric
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord);
  update public.documents d
     set subtotal = t.sub, tax_total = t.tax, total = t.sub + t.tax
    from (select sum(l.line_subtotal) as sub, sum(l.line_tax) as tax
            from public.sales_order_lines l where l.document_id = v_doc.id) as t
   where d.id = v_doc.id
  returning d.* into v_doc;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'sales_order', v_doc.id, v_doc.display_number,
    format('Creó %s a %s por %s', v_doc.display_number, v_customer.legal_name, private.format_money(v_doc.total)),
    v_doc.id, null, 'BORRADOR');
  if p_confirm then
    perform private.confirm_sales_order(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.so_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_ORDER');
  perform private.require_permission(v_doc.company_id, 'sales_order.create');
  perform private.confirm_sales_order(v_doc);
end;
$$;

-- Gerencia autoriza o rechaza el crédito; quien cargó el pedido no decide sobre él, SoD-8 (decideSalesOrder).
create function private.decide_sales_order(p_document_id uuid, p_action text, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_text text := trim(coalesce(p_comment, ''));
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_ORDER');
  perform private.require_transition(v_doc, p_action);
  v_actor := private.require_permission(v_doc.company_id, 'sales_order.approve');
  if not private.is_supervisor(v_doc.company_id)
     and coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and v_doc.created_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      'No podés autorizar ni rechazar el crédito de un pedido que cargaste vos.',
      'Separación de funciones: quien vende no autoriza su propia excepción de crédito.');
  end if;
  if p_action = 'APPROVE' then
    update public.sales_orders set confirmed_at = now() where document_id = v_doc.id;
  end if;
  perform private.transition_document(v_doc.id, p_action, p_comment, p_actor => v_actor,
    p_summary => case when p_action = 'APPROVE' then
      format('Autorizó el crédito de %s por %s%s', v_doc.display_number, private.format_money(v_doc.total),
             case when v_text <> '' then ' — ' || v_text else '' end)
    end);
  perform private.notify_users(v_doc.company_id, array[v_doc.created_by],
    case when p_action = 'APPROVE' then 'PEDIDO_AUTORIZADO' else 'PEDIDO_RECHAZADO' end,
    format('%s %s', v_doc.display_number, case when p_action = 'APPROVE' then 'fue autorizado' else 'fue rechazado' end),
    case when p_action = 'APPROVE' then 'Gerencia autorizó el crédito: Depósito ya puede despacharlo.'
         else 'Gerencia no autorizó el crédito: ' || v_text end,
    private.doc_path(v_doc.id), v_doc.id, null, (select auth.uid()));
end;
$$;

create function public.so_approve(p_document_id uuid, p_comment text default '')
returns void
language sql
security definer
set search_path = ''
as $$ select private.decide_sales_order(p_document_id, 'APPROVE', p_comment) $$;

create function public.so_reject(p_document_id uuid, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$ select private.decide_sales_order(p_document_id, 'REJECT', p_reason) $$;

create function public.so_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_ORDER');
  if exists (select 1 from public.sales_order_lines l where l.document_id = v_doc.id and l.qty_delivered > 0.000000001) then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s tiene entregas: no se puede anular. Usá "Cerrar saldo".', v_doc.display_number));
  end if;
  perform private.assert_no_draft_delivery(v_doc);
  perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
end;
$$;

create function public.so_close(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_ORDER');
  perform private.assert_no_draft_delivery(v_doc);
  perform private.transition_document(v_doc.id, 'CLOSE', p_reason);
end;
$$;

grant execute on function public.so_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.so_confirm(uuid) to authenticated;
grant execute on function public.so_approve(uuid, text) to authenticated;
grant execute on function public.so_reject(uuid, text) to authenticated;
grant execute on function public.so_cancel(uuid, text) to authenticated;
grant execute on function public.so_close(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Remitos

-- Despachar: la mercadería sale al costo promedio, el pedido suma lo entregado
-- (y libera esa reserva) y se registra el costo de lo vendido (dispatchDeliveryNote).
create function private.dispatch_delivery_note(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dn public.delivery_notes;
  v_order public.documents;
  v_customer public.customers;
  v_actor private.actor;
  v_line public.delivery_note_lines;
  v_sl public.sales_order_lines;
  v_p public.products;
  v_unit_cost numeric;
  v_total_cost numeric;
  v_costs jsonb := '{}';
  v_amounts jsonb;
  v_full boolean;
begin
  select * into v_dn from public.delivery_notes x where x.document_id = p_doc.id;
  v_order := private.get_document(v_dn.sales_order_id, 'SALES_ORDER');
  if v_order.status not in ('CONFIRMADO', 'ENTREGADO_PARCIAL') then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s ya no admite entregas (estado "%s").', v_order.display_number,
             private.status_label('SALES_ORDER', v_order.status)));
  end if;
  select * into v_customer from public.customers c where c.id = v_order.customer_id;
  v_actor := private.transition_document(p_doc.id, 'CONFIRM', p_summary => format(
    'Despachó %s: salió la mercadería de %s para %s', p_doc.display_number, v_order.display_number, v_customer.legal_name));
  for v_line in select * from public.delivery_note_lines l where l.document_id = p_doc.id order by l.line_no loop
    select * into v_sl from public.sales_order_lines x where x.id = v_line.so_line_id for update;
    v_p := private.product_for(p_doc.company_id, v_line.product_id);
    if v_line.quantity > round(v_sl.quantity - v_sl.qty_delivered, 3) + 0.000000001 then
      perform private.raise_business_error('CANTIDAD_EXCEDE_PENDIENTE',
        format('%s: la cantidad supera lo que falta entregar de %s (%s).', v_p.code, v_order.display_number,
               private.format_qty(round(v_sl.quantity - v_sl.qty_delivered, 3), v_p.uom_code)));
    end if;
    update public.sales_order_lines set qty_delivered = round(qty_delivered + v_line.quantity, 3) where id = v_sl.id;
    continue when not v_p.is_stockable;
    perform private.post_stock_movement(p_doc.company_id, v_p.id, v_dn.warehouse_id, 'DESPACHO_VENTA',
      -v_line.quantity, null, p_doc.id, v_line.id, p_doc.document_date);
    select m.unit_cost, m.total_cost into v_unit_cost, v_total_cost
      from public.stock_movements m
     where m.document_line_id = v_line.id and m.movement_type = 'DESPACHO_VENTA'
     order by m.id desc
     limit 1;
    update public.delivery_note_lines set unit_cost = v_unit_cost where id = v_line.id;
    v_costs := v_costs || jsonb_build_object(v_p.product_type,
      round(coalesce((v_costs ->> v_p.product_type)::numeric, 0) - v_total_cost, 2));
  end loop;
  update public.delivery_notes set dispatched_at = now() where document_id = p_doc.id;
  perform private.recompute_sales_order(v_order.id);
  -- Costo de ventas al debe y bienes de cambio al haber, por tipo de producto (en el orden de los tipos).
  select jsonb_agg(x.amount order by x.side, x.ord) into v_amounts
    from (
      select 1 as side, t.ord, jsonb_build_object('key', 'COSTO_' || t.type, 'debit', (v_costs ->> t.type)::numeric, 'credit', 0) as amount
        from unnest(array['MATERIA_PRIMA', 'INSUMO', 'PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO'])
             with ordinality as t (type, ord)
       where coalesce((v_costs ->> t.type)::numeric, 0) > 0
      union all
      select 2, t.ord, jsonb_build_object('key', t.type, 'debit', 0, 'credit', (v_costs ->> t.type)::numeric)
        from unnest(array['MATERIA_PRIMA', 'INSUMO', 'PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO'])
             with ordinality as t (type, ord)
       where coalesce((v_costs ->> t.type)::numeric, 0) > 0
    ) as x;
  if v_amounts is not null then
    perform private.post_event(v_actor, p_doc, 'COSTO_VENTA',
      format('Costo de lo vendido según %s (%s, %s).', p_doc.display_number, v_order.display_number, v_customer.legal_name),
      v_amounts);
  end if;
  select d.status = 'ENTREGADO' into v_full from public.documents d where d.id = v_order.id;
  perform private.notify_roles(p_doc.company_id, array['VENTAS'], 'PEDIDO_DESPACHADO',
    format('%s %s', v_order.display_number, case when v_full then 'entregado' else 'entregado parcialmente' end),
    format('Depósito despachó %s para %s.', p_doc.display_number, v_customer.legal_name),
    private.doc_path(v_order.id), v_order.id, null, (v_actor).user_id);
end;
$$;

-- p_input: {sales_order_id, carrier_name, notes, lines: [{so_line_id, quantity, notes}]} (cmdCreateDeliveryNote)
create function public.dn_create(p_company_id uuid, p_input jsonb, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'delivery_note.create');
  v_order public.documents;
  v_carrier text := trim(coalesce(p_input ->> 'carrier_name', ''));
  v_line jsonb;
  v_lines jsonb;
  v_sl public.sales_order_lines;
  v_p public.products;
  v_by_line jsonb := '{}';
  v_total numeric;
  v_pending numeric;
  v_customer public.customers;
  v_number record;
  v_doc public.documents;
  v_sum numeric := 0;
begin
  select * into v_order from public.documents d
   where d.id::text = p_input ->> 'sales_order_id' and d.company_id = p_company_id and d.doc_type = 'SALES_ORDER'
     for update;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el pedido de venta que se despacha.');
  end if;
  if v_order.status not in ('CONFIRMADO', 'ENTREGADO_PARCIAL') then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está "%s": se despachan pedidos confirmados.', v_order.display_number,
             private.status_label('SALES_ORDER', v_order.status)));
  end if;
  if length(v_carrier) > 80 then
    perform private.raise_business_error('DATO_INVALIDO', 'El transportista tiene hasta 80 caracteres.');
  end if;
  for v_line in select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) as l loop
    if (v_line ->> 'quantity') is null or (v_line ->> 'quantity')::numeric < 0
       or round((v_line ->> 'quantity')::numeric, 3) <> (v_line ->> 'quantity')::numeric then
      perform private.raise_business_error('DATO_INVALIDO',
        'Las cantidades que salen deben ser números mayores o iguales que cero (hasta 3 decimales).');
    end if;
  end loop;
  select coalesce(jsonb_agg(x.l order by x.ord), '[]') into v_lines
    from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) with ordinality as x (l, ord)
   where (x.l ->> 'quantity')::numeric > 0;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá qué sale de al menos un ítem.');
  end if;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    select * into v_sl from public.sales_order_lines x where x.id::text = v_line ->> 'so_line_id' and x.document_id = v_order.id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Uno de los ítems no es del pedido de venta.');
    end if;
    v_p := private.product_for(p_company_id, v_sl.product_id);
    v_total := round(coalesce((v_by_line ->> v_sl.id::text)::numeric, 0) + (v_line ->> 'quantity')::numeric, 3);
    v_by_line := v_by_line || jsonb_build_object(v_sl.id::text, v_total);
    v_pending := round(v_sl.quantity - v_sl.qty_delivered, 3);
    if v_total > v_pending + 0.000000001 then
      perform private.raise_business_error('CANTIDAD_EXCEDE_PENDIENTE',
        format('%s: salen %s pero sólo faltan entregar %s.', v_p.code, private.format_qty(v_total, v_p.uom_code),
               private.format_qty(v_pending, v_p.uom_code)),
        'No se entrega más de lo que pidió el cliente: si quiere más, Ventas carga otro pedido.');
    end if;
  end loop;

  select * into v_customer from public.customers c where c.id = v_order.customer_id;
  select * into v_number from private.next_document_number(p_company_id, 'DELIVERY_NOTE');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, customer_id, notes, created_by)
  values (p_company_id, 'DELIVERY_NOTE', v_number.number, v_number.display_number, 'BORRADOR', private.business_date(p_company_id),
          (v_actor).sector_id, v_customer.id, trim(coalesce(p_input ->> 'notes', '')), (v_actor).user_id)
  returning * into v_doc;
  insert into public.delivery_notes (document_id, company_id, sales_order_id, warehouse_id, carrier_name)
  values (v_doc.id, p_company_id, v_order.id, (select so.warehouse_id from public.sales_orders so where so.document_id = v_order.id),
          v_carrier);
  insert into public.delivery_note_lines (company_id, document_id, line_no, so_line_id, product_id, quantity, notes)
  select p_company_id, v_doc.id, x.ord, sl.id, sl.product_id, (x.l ->> 'quantity')::numeric, trim(coalesce(x.l ->> 'notes', ''))
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord)
    join public.sales_order_lines sl on sl.id::text = x.l ->> 'so_line_id';
  -- Valorizado a los precios del pedido (sin IVA).
  select coalesce(sum(round(l.quantity * sl.unit_price, 2)), 0) into v_sum
    from public.delivery_note_lines l join public.sales_order_lines sl on sl.id = l.so_line_id
   where l.document_id = v_doc.id;
  update public.documents set subtotal = round(v_sum, 2), total = round(v_sum, 2) where id = v_doc.id
  returning * into v_doc;
  perform private.link_documents(p_company_id, v_order.id, v_doc.id);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'delivery_note', v_doc.id, v_doc.display_number,
    format('Creó %s para %s de %s', v_doc.display_number, v_order.display_number, v_customer.legal_name),
    v_doc.id, null, 'BORRADOR');
  if p_confirm then
    perform private.dispatch_delivery_note(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.dn_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'DELIVERY_NOTE');
  perform private.require_permission(v_doc.company_id, 'delivery_note.create');
  perform private.dispatch_delivery_note(v_doc);
end;
$$;

-- El borrador se anula sin más. Uno despachado vuelve al depósito al costo con
-- que salió, con el contraasiento de su costo; no lo anula quien lo despachó
-- (SoD-3), salvo Gerencia (cmdCancelDeliveryNote).
create function public.dn_cancel(p_document_id uuid, p_reason text)
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
  v_stockable boolean;
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

grant execute on function public.dn_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.dn_confirm(uuid) to authenticated;
grant execute on function public.dn_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas de ventas

-- Clientes para el pedido de venta: su condición de pago y su crédito (salesCustomers).
create function public.sales_customers(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'sales_order.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'code', c.code, 'legal_name', c.legal_name, 'vat_condition', c.vat_condition,
             'payment_terms_days', c.payment_terms_days, 'credit_limit', c.credit_limit,
             'credit_used', private.customer_credit_used(c.id)) order by c.code collate "C")
      from public.customers c where c.company_id = p_company_id and c.is_active
  ), '[]');
end;
$$;

-- Lo que hay de un producto en cada depósito, lo reservado y lo disponible, por código de depósito.
create function private.availability_of(p_company uuid, p_product uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'warehouse_id', w.id, 'on_hand', x.on_hand, 'reserved', x.reserved,
           'available', round(x.on_hand - x.reserved, 3)) order by w.code collate "C"), '[]')
    from public.warehouses w
    cross join lateral (
      select private.on_hand_quantity(p_product, w.id) as on_hand, private.reserved_quantity(p_product, w.id) as reserved
    ) as x
   where w.company_id = p_company
$$;

-- Lo que se puede vender, con su precio y lo disponible en cada depósito (salesCatalog).
create function public.sales_catalog(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ri boolean;
begin
  perform private.require_read(p_company_id, 'sales_order.create');
  select c.vat_condition = 'RESPONSABLE_INSCRIPTO' into v_ri from public.companies c where c.id = p_company_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'code', p.code, 'name', p.name, 'uom_code', p.uom_code, 'product_type', p.product_type,
             'is_stockable', p.is_stockable, 'sale_price', p.sale_price,
             'vat_rate', case when v_ri then p.vat_rate else 0 end,
             'stock', case when p.is_stockable then private.availability_of(p_company_id, p.id) else '[]'::jsonb end)
           order by p.code collate "C")
      from public.products p
     where p.company_id = p_company_id and p.is_active
       and p.product_type in ('PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO')
  ), '[]');
end;
$$;

-- Pedidos confirmados con algo por entregar, para preparar el remito (dispatchableOrders).
create function public.orders_dispatchable(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'delivery_note.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object('order', private.document_item(d), 'warehouse', to_jsonb(w), 'lines', o.lines)
                     order by d.number)
      from public.documents d
      join public.sales_orders so on so.document_id = d.id
      join public.warehouses w on w.id = so.warehouse_id
      cross join lateral (
        select jsonb_agg(jsonb_build_object(
                 'line', to_jsonb(sl), 'product', to_jsonb(p), 'pending', round(sl.quantity - sl.qty_delivered, 3),
                 'on_hand', case when p.is_stockable then private.on_hand_quantity(p.id, so.warehouse_id) end)
               order by sl.line_no) as lines
          from public.sales_order_lines sl join public.products p on p.id = sl.product_id
         where sl.document_id = d.id and round(sl.quantity - sl.qty_delivered, 3) > 0.000000001
      ) as o
     where d.company_id = p_company_id and d.doc_type = 'SALES_ORDER'
       and d.status in ('CONFIRMADO', 'ENTREGADO_PARCIAL') and o.lines is not null
  ), '[]');
end;
$$;

grant execute on function public.sales_customers(uuid) to authenticated;
grant execute on function public.sales_catalog(uuid) to authenticated;
grant execute on function public.orders_dispatchable(uuid) to authenticated;

-- Igual que antes, con lo reservado para pedidos de venta y lo disponible (productDetail).
create or replace function public.product_detail(p_company_id uuid, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_stock boolean;
begin
  perform private.require_read(p_company_id, 'product.read');
  select * into v_product from public.products p where p.company_id = p_company_id and p.code = p_code;
  if not found then
    return null;
  end if;
  v_stock := private.has_permission(p_company_id, 'stock.read');
  return jsonb_build_object(
    'product', private.product_row(v_product),
    'balances', case when v_stock then coalesce((
      select jsonb_agg(to_jsonb(b) || jsonb_build_object(
               'warehouse_name', w.name, 'qty_reserved', r.reserved, 'qty_available', round(b.qty_on_hand - r.reserved, 3))
             order by w.code collate "C")
        from public.stock_balances b
        join public.warehouses w on w.id = b.warehouse_id
        cross join lateral (select private.reserved_quantity(b.product_id, b.warehouse_id) as reserved) as r
       where b.product_id = v_product.id
    ), '[]') else '[]' end,
    'kardex', case when v_stock then coalesce((
      select jsonb_agg(to_jsonb(m) || jsonb_build_object(
               'warehouse_name', coalesce(w.code, ''),
               'document_label', d.display_number,
               'document_path', case when d.id is not null then private.doc_path(d.id) end,
               'user_name', private.full_name(m.created_by)) order by m.id desc)
        from public.stock_movements m
        left join public.warehouses w on w.id = m.warehouse_id
        left join public.documents d on d.id = m.document_id
       where m.product_id = v_product.id
    ), '[]') else '[]' end
  );
end;
$$;

-- Igual que antes, con lo reservado para pedidos de venta y lo disponible (listStock).
create or replace function public.stock_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'stock.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'product', to_jsonb(p), 'warehouse', to_jsonb(w), 'qty', x.qty,
             'reserved', r.reserved, 'available', round(x.qty - r.reserved, 3), 'avg_cost', x.avg_cost,
             'value', x.qty * x.avg_cost, 'total_qty', t.total, 'below_min', p.min_stock > 0 and t.total < p.min_stock)
           order by p.code collate "C", w.code collate "C")
      from public.products p
      cross join lateral (
        select coalesce(sum(b.qty_on_hand), 0) as total from public.stock_balances b where b.product_id = p.id
      ) t
      cross join lateral (
        select b.warehouse_id, b.qty_on_hand as qty, b.avg_unit_cost as avg_cost
          from public.stock_balances b where b.product_id = p.id
        union all
        select p.default_warehouse_id, 0, p.standard_cost
         where not exists (select 1 from public.stock_balances b where b.product_id = p.id)
      ) x
      join public.warehouses w on w.id = x.warehouse_id
      cross join lateral (select private.reserved_quantity(p.id, w.id) as reserved) as r
     where p.company_id = p_company_id and p.is_stockable
  ), '[]');
end;
$$;

-- Pedido de venta: sus condiciones y el crédito del cliente (salesOrderView).
create function private.sales_order_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'delivery_date', so.delivery_date, 'payment_terms_days', so.payment_terms_days,
    'customer_reference', so.customer_reference, 'credit_reason', so.credit_reason, 'confirmed_at', so.confirmed_at,
    'credit_limit', c.credit_limit, 'credit_used', private.customer_credit_used(c.id, p_doc.id))
    from public.sales_orders so join public.customers c on c.id = p_doc.customer_id
   where so.document_id = p_doc.id
$$;

-- Remito: quién lo lleva, cuándo salió y a qué costo (deliveryView).
create function private.delivery_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'carrier_name', x.carrier_name, 'dispatched_at', x.dispatched_at,
    'cost_total', (select round(coalesce(sum(round(l.quantity * l.unit_cost, 2)), 0), 2)
                     from public.delivery_note_lines l where l.document_id = p_doc.id))
    from public.delivery_notes x where x.document_id = p_doc.id
$$;

-- Por qué no se puede confirmar, autorizar, anular o cerrar un pedido de venta; null si se puede (salesOrderActionReason).
create function private.sales_order_action_reason(p_doc public.documents, p_action text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_so public.sales_orders;
  v_line public.sales_order_lines;
  v_p public.products;
  v_available numeric;
  v_draft public.documents;
begin
  select * into v_so from public.sales_orders x where x.document_id = p_doc.id;
  if p_action = 'CONFIRM'
     and not coalesce((select (c.settings ->> 'allow_negative_stock')::boolean from public.companies c where c.id = p_doc.company_id), false) then
    for v_line in select * from public.sales_order_lines l where l.document_id = p_doc.id order by l.line_no loop
      select * into v_p from public.products p where p.id = v_line.product_id;
      continue when not v_p.is_stockable;
      v_available := round(private.on_hand_quantity(v_p.id, v_so.warehouse_id)
                           - private.reserved_quantity(v_p.id, v_so.warehouse_id, p_doc.id), 3);
      if v_line.quantity > v_available + 0.000000001 then
        return format('Falta stock de %s: hay %s disponibles y el pedido lleva %s.', v_p.code,
                      private.format_qty(greatest(v_available, 0), v_p.uom_code), private.format_qty(v_line.quantity, v_p.uom_code));
      end if;
    end loop;
  end if;
  if p_action in ('APPROVE', 'REJECT') and not private.is_supervisor(p_doc.company_id)
     and coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = p_doc.company_id), false)
     and p_doc.created_by = (select auth.uid()) then
    return 'Separación de funciones: no podés autorizar ni rechazar el crédito de un pedido que cargaste vos.';
  end if;
  if p_action = 'CANCEL'
     and exists (select 1 from public.sales_order_lines l where l.document_id = p_doc.id and l.qty_delivered > 0.000000001) then
    return 'Tiene entregas: usá "Cerrar saldo".';
  end if;
  if p_action in ('CANCEL', 'CLOSE') then
    v_draft := private.draft_delivery_of(p_doc.id);
    if v_draft.id is not null then
      return format('%s está en preparación: Depósito tiene que despacharlo o anularlo.', v_draft.display_number);
    end if;
  end if;
  return null;
end;
$$;

-- ------------------------------------------------------------------ Documentos: ventas en las lecturas comunes

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
$$;

-- Igual que antes, con los ítems del pedido de venta y del remito y el nombre del cliente.
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
    select l.line_no, null::uuid from public.journal_entry_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.payment_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.bank_reconciliation_lines l where l.document_id = p_doc.id
  ),
  codes as (
    select array_agg(p.code order by l.line_no) as list, count(*) as n
      from lines l join public.products p on p.id = l.product_id
  ),
  invoices as (
    select array_agg(d.display_number order by l.line_no) as list, count(*) as n
      from public.payment_order_lines l join public.documents d on d.id = l.invoice_id
     where l.document_id = p_doc.id
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
      case when p_doc.doc_type = 'PAYMENT_ORDER' then
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

-- Igual que antes, con un botón por acción (confirmar un pedido lleva a dos estados) y los motivos de ventas.
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

-- Igual que antes, con el pedido de venta y el remito (nextStep).
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
      return jsonb_build_object('who', 'Ventas', 'text', 'Se entregó todo lo pedido: lo que sigue es facturarlo.');
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

-- Igual que antes, con el pedido de venta y el remito: sus ítems, el cliente, sus vistas, su lugar en el flujo y sus firmas.
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
               'qty_delivered', l.qty_delivered,
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
    else
      v_lines := null;
  end case;

  return jsonb_build_object(
    'doc', private.document_item(p_doc),
    'lines', coalesce(v_lines, '[]'),
    'journal', case when p_doc.doc_type = 'JOURNAL_ENTRY' then private.journal_view(p_doc) end,
    'payment', case when p_doc.doc_type = 'PAYMENT_ORDER' then private.payment_view(p_doc) end,
    'rfq', case when p_doc.doc_type = 'RFQ' then private.rfq_view(p_doc) end,
    'quote', case when p_doc.doc_type = 'SUPPLIER_QUOTE' then private.quote_view(p_doc) end,
    'transfer', case when p_doc.doc_type = 'FUNDS_TRANSFER' then private.transfer_view(p_doc) end,
    'reconciliation', case when p_doc.doc_type = 'BANK_RECONCILIATION' then private.reconciliation_view(p_doc) end,
    'sales_order', case when p_doc.doc_type = 'SALES_ORDER' then private.sales_order_view(p_doc) end,
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
                              'SUPPLIER_INVOICE', 'PAYMENT_ORDER', 'FUNDS_TRANSFER', 'BANK_RECONCILIATION', 'SALES_ORDER',
                              'DELIVERY_NOTE', 'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;
