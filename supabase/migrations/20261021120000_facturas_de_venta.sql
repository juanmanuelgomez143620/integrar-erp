-- 34. Fase 4b (docs/FASE_4_VENTAS_Y_CLIENTES.md §4): factura de venta contra
-- lo entregado, con su asiento de venta y la deuda del cliente; cuenta
-- corriente de clientes; el crédito cuenta las facturas sin cobrar y las
-- vencidas (cliente moroso). Traducción de la sección "Facturas de venta" de
-- src/lib/mock/engine.ts y de sus lecturas en queries.ts, con los mismos
-- mensajes y la misma forma de datos.
--
-- El tipo de documento, sus estados, transiciones, tarea, permisos y claves de
-- imputación están en la migración de catálogos siguiente; las reglas base del
-- asiento de venta, en la de la plantilla.

-- ------------------------------------------------------------------ Tablas

-- Factura de venta: 1 a 1 con documents (tipo SALES_INVOICE), contra un pedido de venta.
create table public.sales_invoices (
  document_id uuid primary key,
  doc_type text not null default 'SALES_INVOICE' check (doc_type = 'SALES_INVOICE'),
  company_id uuid not null,
  sales_order_id uuid not null,
  letter text not null check (letter in ('A', 'B', 'C')),
  point_of_sale text not null,
  invoice_number text not null default '', -- correlativo por letra: se asigna al registrarla
  due_date date not null,
  registered_at timestamptz,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, sales_order_id) references public.sales_orders (company_id, document_id)
);
create index sales_invoices_order_idx on public.sales_invoices (sales_order_id);
-- Un número no se repite (las anuladas lo conservan).
create unique index sales_invoices_number_idx on public.sales_invoices (company_id, letter, point_of_sale, invoice_number)
  where invoice_number <> '';

create table public.sales_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  so_line_id uuid not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_price numeric(14, 4) not null,
  vat_rate numeric(5, 2) not null,
  line_subtotal numeric(14, 2) not null,
  line_tax numeric(14, 2) not null,
  line_total numeric(14, 2) not null,
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.sales_invoices (company_id, document_id) on delete cascade,
  foreign key (company_id, so_line_id) references public.sales_order_lines (company_id, id),
  foreign key (company_id, product_id) references public.products (company_id, id)
);
create index sales_invoice_lines_so_line_idx on public.sales_invoice_lines (so_line_id);

do $$
declare
  t text;
begin
  foreach t in array array['sales_invoices', 'sales_invoice_lines'] loop
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

create policy sales_invoices_select on public.sales_invoices for select to authenticated
  using (company_id in (select private.companies_with_permission('sales_invoice.read')));
create policy sales_invoice_lines_select on public.sales_invoice_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('sales_invoice.read')));

-- ------------------------------------------------------------------ Facturas de venta: auxiliares

-- Facturas de venta que generaron deuda (INVOICED_SALES_STATUSES; desde 4c, también las cobradas en parte).
create function private.invoiced_sales_statuses()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['REGISTRADA'] $$;

-- Lo facturado de un ítem del pedido en facturas registradas, salvo una (salesInvoicedQuantity).
create function private.sales_invoiced_quantity(p_so_line uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(l.quantity), 0), 3)
    from public.sales_invoice_lines l join public.documents d on d.id = l.document_id
   where l.so_line_id = p_so_line and d.status = any (private.invoiced_sales_statuses())
     and d.id is distinct from p_except
$$;

-- Lo que falta cobrar de una factura de venta registrada (salesInvoicePending; desde 4c le restan los cobros).
create function private.sales_invoice_pending(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select round(d.total, 2) from public.documents d where d.id = p_invoice $$;

-- Lo vencido y sin cobrar de un cliente: el cliente moroso (customerOverdue).
create function private.customer_overdue(p_customer uuid, p_today date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(private.sales_invoice_pending(d.id)), 0), 2)
    from public.documents d join public.sales_invoices x on x.document_id = d.id
   where d.doc_type = 'SALES_INVOICE' and d.customer_id = p_customer
     and d.status = any (private.invoiced_sales_statuses()) and x.due_date < p_today
$$;

-- Igual que antes, menos lo que ya se facturó: eso está en la deuda del cliente (creditUsedByOrder).
create or replace function private.credit_used_by_order(p_order uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(private.amount_with_vat(
           greatest(round(case when d.status = any (private.active_sales_statuses()) then l.quantity else l.qty_delivered end
                          - private.sales_invoiced_quantity(l.id), 3), 0),
           l.unit_price, l.vat_rate)), 0), 2)
    from public.sales_order_lines l join public.documents d on d.id = l.document_id
   where l.document_id = p_order
$$;

-- El crédito que usa un cliente: sus facturas sin cobrar y sus pedidos todavía sin facturar, salvo uno (customerCreditUsed).
create or replace function private.customer_credit_used(p_customer uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(
    coalesce((select sum(private.credit_used_by_order(d.id))
                from public.documents d
               where d.doc_type = 'SALES_ORDER' and d.customer_id = p_customer and d.id is distinct from p_except
                 and d.status = any (private.active_sales_statuses() || array['ENTREGADO', 'CERRADO'])), 0)
    + coalesce((select sum(private.sales_invoice_pending(d.id))
                  from public.documents d
                 where d.doc_type = 'SALES_INVOICE' and d.customer_id = p_customer
                   and d.status = any (private.invoiced_sales_statuses())), 0), 2)
$$;

-- Por qué el pedido necesita la autorización de Gerencia (cliente moroso o sin crédito); vacío si no (creditReason).
create or replace function private.credit_reason(p_doc public.documents)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select concat_ws(' ',
           case when private.customer_overdue(c.id, private.business_date(p_doc.company_id)) > 0.000000001 then
             format('%s tiene facturas vencidas sin cobrar por %s.', c.legal_name,
                    private.format_money(private.customer_overdue(c.id, private.business_date(p_doc.company_id))))
           end,
           case when c.credit_limit is not null
                 and round(private.customer_credit_used(c.id, p_doc.id) + p_doc.total, 2) > c.credit_limit + 0.000000001 then
             format('Supera el límite de crédito de %s (%s): con este pedido llegaría a %s entre lo que debe y lo pedido sin facturar.',
                    c.legal_name, private.format_money(c.credit_limit),
                    private.format_money(round(private.customer_credit_used(c.id, p_doc.id) + p_doc.total, 2)))
           end)
    from public.customers c where c.id = p_doc.customer_id
$$;

-- Letra de la factura (salesLetter, a validar): la empresa responsable inscripta emite A a responsables
-- inscriptos y monotributistas y B a exentos y consumidores finales; si no es responsable inscripta, C.
create function private.sales_letter(p_company uuid, p_customer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when co.vat_condition <> 'RESPONSABLE_INSCRIPTO' then 'C'
           when cu.vat_condition in ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO') then 'A'
           else 'B'
         end
    from public.companies co, public.customers cu
   where co.id = p_company and cu.id = p_customer
$$;

-- "A 00001-00000012" (salesInvoiceLabel).
create function private.sales_invoice_label(p_letter text, p_point_of_sale text, p_number text)
returns text
language sql
immutable
set search_path = ''
as $$ select p_letter || ' ' || p_point_of_sale || '-' || coalesce(nullif(p_number, ''), 'sin número') $$;

-- El pedido tiene algo entregado y todavía sin facturar (uninvoicedDelivery).
create function private.uninvoiced_delivery(p_order uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sales_order_lines l
     where l.document_id = p_order and l.qty_delivered - private.sales_invoiced_quantity(l.id) > 0.000000001)
$$;

-- Control por oposición: no se factura más de lo entregado menos lo ya facturado (assertSalesInvoiceable).
create function private.assert_sales_invoiceable(p_sl public.sales_order_lines, p_quantity numeric)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invoiced numeric := private.sales_invoiced_quantity(p_sl.id);
  v_available numeric := round(p_sl.qty_delivered - private.sales_invoiced_quantity(p_sl.id), 3);
  v_p public.products;
begin
  if p_quantity > v_available + 0.000000001 then
    select * into v_p from public.products p where p.id = p_sl.product_id;
    perform private.raise_business_error('CANTIDAD_EXCEDIDA',
      format('%s: se entregaron %s y ya se facturaron %s; como mucho se pueden facturar %s.', v_p.code,
             private.format_qty(p_sl.qty_delivered, v_p.uom_code), private.format_qty(v_invoiced, v_p.uom_code),
             private.format_qty(greatest(v_available, 0), v_p.uom_code)),
      'Se factura lo que efectivamente salió: la factura se controla contra el pedido y los remitos.');
  end if;
end;
$$;

-- Registrar: controla otra vez las cantidades, le asigna el número correlativo
-- de su letra y la fecha de hoy (vence según la condición del pedido), y
-- genera el asiento de venta y la deuda del cliente (registerSalesInvoice).
create function private.register_sales_invoice(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fv public.sales_invoices;
  v_line record;
  v_sl public.sales_order_lines;
  v_order public.documents;
  v_customer public.customers;
  v_today date := private.business_date(p_doc.company_id);
  v_number text;
  v_label text;
  v_actor private.actor;
  v_doc public.documents;
  v_amounts jsonb;
begin
  perform private.require_transition(p_doc, 'CONFIRM');
  select * into v_fv from public.sales_invoices x where x.document_id = p_doc.id;
  for v_line in
    select l.so_line_id, sum(l.quantity) as quantity
      from public.sales_invoice_lines l where l.document_id = p_doc.id
     group by l.so_line_id
     order by min(l.line_no)
  loop
    select * into v_sl from public.sales_order_lines x where x.id = v_line.so_line_id;
    perform private.assert_sales_invoiceable(v_sl, v_line.quantity);
  end loop;
  v_order := private.get_document(v_fv.sales_order_id, 'SALES_ORDER');
  select * into v_customer from public.customers c where c.id = p_doc.customer_id;
  -- Una numeración por letra y punto de venta, sin huecos ni repetidos.
  perform pg_advisory_xact_lock(hashtextextended('sales_invoice:' || p_doc.company_id || ':' || v_fv.letter, 0));
  select lpad((coalesce(max(x.invoice_number::int), 0) + 1)::text, 8, '0') into v_number
    from public.sales_invoices x
   where x.company_id = p_doc.company_id and x.letter = v_fv.letter and x.point_of_sale = v_fv.point_of_sale
     and x.invoice_number <> '';
  update public.documents set document_date = v_today where id = p_doc.id;
  update public.sales_invoices
     set invoice_number = v_number,
         due_date = v_today + (select so.payment_terms_days from public.sales_orders so where so.document_id = v_order.id)
   where document_id = p_doc.id;
  v_label := private.sales_invoice_label(v_fv.letter, v_fv.point_of_sale, v_number);
  v_actor := private.transition_document(p_doc.id, 'CONFIRM', p_summary => format('Registró %s: factura %s a %s por %s',
    p_doc.display_number, v_label, v_customer.legal_name, private.format_money(p_doc.total)));
  update public.sales_invoices set registered_at = now() where document_id = p_doc.id;
  select * into v_doc from public.documents d where d.id = p_doc.id;
  -- Deudores por ventas al debe; las ventas de cada tipo de producto y el IVA débito fiscal al haber.
  select jsonb_build_array(jsonb_build_object('key', 'DEUDORES', 'debit', v_doc.total, 'credit', 0))
         || coalesce((
           select jsonb_agg(jsonb_build_object('key', t.type, 'debit', 0, 'credit', t.net) order by t.ord)
             from (
               select k.type, k.ord, sum(l.line_subtotal) as net
                 from unnest(array['MATERIA_PRIMA', 'INSUMO', 'PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO'])
                      with ordinality as k (type, ord)
                 join public.products p on p.product_type = k.type
                 join public.sales_invoice_lines l on l.product_id = p.id and l.document_id = v_doc.id
                group by k.type, k.ord
             ) as t), '[]'::jsonb)
         || jsonb_build_array(jsonb_build_object('key', 'IVA_DEBITO', 'debit', 0, 'credit', v_doc.tax_total))
    into v_amounts;
  perform private.post_event(v_actor, v_doc, 'VENTA',
    format('Venta según %s: factura %s a %s.', v_doc.display_number, v_label, v_customer.legal_name), v_amounts);
end;
$$;

-- ------------------------------------------------------------------ Facturas de venta: comandos

-- p_input: {sales_order_id, notes, lines: [{so_line_id, quantity}]} (cmdCreateSalesInvoice)
create function public.fv_create(p_company_id uuid, p_input jsonb, p_register boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'sales_invoice.create');
  v_order public.documents;
  v_line jsonb;
  v_lines jsonb;
  v_sl public.sales_order_lines;
  v_by_line jsonb := '{}';
  v_total numeric;
  v_customer public.customers;
  v_letter text;
  v_number record;
  v_doc public.documents;
begin
  select * into v_order from public.documents d
   where d.id::text = p_input ->> 'sales_order_id' and d.company_id = p_company_id and d.doc_type = 'SALES_ORDER'
     for update;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el pedido de venta que se factura.');
  end if;
  if v_order.status not in ('ENTREGADO_PARCIAL', 'ENTREGADO', 'CERRADO') then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está "%s": se factura lo entregado, y todavía no salió nada.', v_order.display_number,
             private.status_label('SALES_ORDER', v_order.status)));
  end if;
  for v_line in select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) as l loop
    if (v_line ->> 'quantity') is null or (v_line ->> 'quantity')::numeric < 0
       or round((v_line ->> 'quantity')::numeric, 3) <> (v_line ->> 'quantity')::numeric then
      perform private.raise_business_error('DATO_INVALIDO',
        'Las cantidades deben ser números mayores o iguales que cero (hasta 3 decimales).');
    end if;
  end loop;
  select coalesce(jsonb_agg(x.l order by x.ord), '[]') into v_lines
    from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) with ordinality as x (l, ord)
   where (x.l ->> 'quantity')::numeric > 0;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá qué se factura de al menos un ítem.');
  end if;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    select * into v_sl from public.sales_order_lines x where x.id::text = v_line ->> 'so_line_id' and x.document_id = v_order.id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Uno de los ítems no es del pedido de venta.');
    end if;
    v_total := round(coalesce((v_by_line ->> v_sl.id::text)::numeric, 0) + (v_line ->> 'quantity')::numeric, 3);
    v_by_line := v_by_line || jsonb_build_object(v_sl.id::text, v_total);
    perform private.assert_sales_invoiceable(v_sl, v_total);
  end loop;

  select * into v_customer from public.customers c where c.id = v_order.customer_id;
  v_letter := private.sales_letter(p_company_id, v_customer.id);
  select * into v_number from private.next_document_number(p_company_id, 'SALES_INVOICE');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, customer_id, notes, created_by)
  values (p_company_id, 'SALES_INVOICE', v_number.number, v_number.display_number, 'BORRADOR', private.business_date(p_company_id),
          (v_actor).sector_id, v_customer.id, trim(coalesce(p_input ->> 'notes', '')), (v_actor).user_id)
  returning * into v_doc;
  insert into public.sales_invoices (document_id, company_id, sales_order_id, letter, point_of_sale, due_date)
  values (v_doc.id, p_company_id, v_order.id, v_letter, '00001',
          private.business_date(p_company_id) + (select so.payment_terms_days from public.sales_orders so where so.document_id = v_order.id));
  insert into public.sales_invoice_lines (company_id, document_id, line_no, so_line_id, product_id, quantity, unit_price, vat_rate,
                                          line_subtotal, line_tax, line_total)
  select p_company_id, v_doc.id, x.ord, sl.id, sl.product_id, q.quantity, sl.unit_price, sl.vat_rate, q.subtotal,
         round(q.subtotal * sl.vat_rate / 100, 2), q.subtotal + round(q.subtotal * sl.vat_rate / 100, 2)
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord)
    join public.sales_order_lines sl on sl.id::text = x.l ->> 'so_line_id'
    cross join lateral (
      select (x.l ->> 'quantity')::numeric as quantity, round((x.l ->> 'quantity')::numeric * sl.unit_price, 2) as subtotal
    ) as q;
  update public.documents d
     set subtotal = t.sub, tax_total = t.tax, total = t.sub + t.tax
    from (select sum(l.line_subtotal) as sub, sum(l.line_tax) as tax
            from public.sales_invoice_lines l where l.document_id = v_doc.id) as t
   where d.id = v_doc.id
  returning d.* into v_doc;
  perform private.link_documents(p_company_id, v_order.id, v_doc.id);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'sales_invoice', v_doc.id, v_doc.display_number,
    format('Creó %s: factura %s a %s por %s contra %s', v_doc.display_number, v_letter, v_customer.legal_name,
           private.format_money(v_doc.total), v_order.display_number),
    v_doc.id, null, 'BORRADOR');
  if p_register then
    perform private.register_sales_invoice(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.fv_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_INVOICE');
  perform private.require_permission(v_doc.company_id, 'sales_invoice.create');
  perform private.register_sales_invoice(v_doc);
end;
$$;

-- El borrador se anula sin más. Una factura registrada y sin cobros se anula
-- con el contraasiento de su asiento de venta; su número no se vuelve a usar (cmdCancelSalesInvoice).
create function public.fv_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
  v_entry public.documents;
  v_reversal public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_INVOICE');
  if v_doc.status <> 'REGISTRADA' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'sales_invoice.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  v_entry := private.automatic_entry_of(v_doc.id);
  if v_entry.id is not null then
    v_reversal := private.reverse_journal_entry(v_entry, v_actor, format('%s anulada: %s', v_doc.display_number, v_comment), true);
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', v_comment, p_actor => v_actor,
    p_summary => format('Anuló %s%s — %s', v_doc.display_number,
                        case when v_reversal.id is not null then ' y su asiento con el contraasiento ' || v_reversal.display_number else '' end,
                        v_comment));
end;
$$;

grant execute on function public.fv_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.fv_confirm(uuid) to authenticated;
grant execute on function public.fv_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Remitos: lo facturado no queda por encima de lo entregado

-- Igual que antes, y además no se anula un remito si lo facturado quedaría por encima de lo entregado (cmdCancelDeliveryNote).
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

-- ------------------------------------------------------------------ Lecturas

-- Pedidos con algo entregado y todavía sin facturar, para emitir la factura de venta (invoiceableSalesOrders).
create function public.sales_orders_invoiceable(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'sales_invoice.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object('order', private.document_item(d),
                                        'letter', private.sales_letter(p_company_id, d.customer_id), 'lines', o.lines)
                     order by d.number)
      from public.documents d
      cross join lateral (
        select jsonb_agg(jsonb_build_object('line', to_jsonb(sl), 'product', to_jsonb(p), 'invoiced', x.invoiced,
                                            'pending', round(sl.qty_delivered - x.invoiced, 3))
                         order by sl.line_no) as lines
          from public.sales_order_lines sl
          join public.products p on p.id = sl.product_id
          cross join lateral (select private.sales_invoiced_quantity(sl.id) as invoiced) as x
         where sl.document_id = d.id and round(sl.qty_delivered - x.invoiced, 3) > 0.000000001
      ) as o
     where d.company_id = p_company_id and d.doc_type = 'SALES_ORDER'
       and d.status in ('ENTREGADO_PARCIAL', 'ENTREGADO', 'CERRADO') and o.lines is not null
  ), '[]');
end;
$$;

-- Factura de venta registrada en la cuenta corriente (ReceivableInvoice).
create function private.receivable_invoice(p_doc public.documents, p_today date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_doc.id, 'display_number', p_doc.display_number, 'path', private.doc_path(p_doc.id),
    'invoice_label', private.sales_invoice_label(x.letter, x.point_of_sale, x.invoice_number),
    'document_date', p_doc.document_date, 'due_date', x.due_date, 'total', p_doc.total,
    'collected', round(p_doc.total - private.sales_invoice_pending(p_doc.id), 2),
    'pending', private.sales_invoice_pending(p_doc.id),
    'overdue', x.due_date < p_today and private.sales_invoice_pending(p_doc.id) > 0)
    from public.sales_invoices x where x.document_id = p_doc.id
$$;

-- Lo que debe cada cliente con facturas registradas, por código (listReceivables).
create function public.receivables_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.business_date(p_company_id);
begin
  perform private.require_read(p_company_id, 'receivable.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'customer', jsonb_build_object('id', c.id, 'code', c.code, 'legal_name', c.legal_name, 'tax_id', c.tax_id,
                                            'payment_terms_days', c.payment_terms_days, 'credit_limit', c.credit_limit),
             'balance', coalesce(t.balance, 0), 'invoices', coalesce(t.invoices, 0), 'overdue', coalesce(t.overdue, 0),
             'next_due', t.next_due)
           order by c.code collate "C")
      from public.customers c
      left join lateral (
        select sum((i ->> 'pending')::numeric) as balance, count(*) as invoices,
               sum(case when (i ->> 'overdue')::boolean then (i ->> 'pending')::numeric else 0 end) as overdue,
               min((i ->> 'due_date')::date) as next_due
          from public.documents d
          cross join lateral (select private.receivable_invoice(d, v_today) as i) as x
         where d.company_id = p_company_id and d.doc_type = 'SALES_INVOICE' and d.customer_id = c.id
           and d.status = any (private.invoiced_sales_statuses()) and (i ->> 'pending')::numeric > 0
      ) as t on true
     where c.company_id = p_company_id
       and exists (
         select 1 from public.documents d
          where d.company_id = p_company_id and d.doc_type = 'SALES_INVOICE' and d.customer_id = c.id
            and d.status = any (private.invoiced_sales_statuses()))
  ), '[]');
end;
$$;

-- Cuenta corriente de un cliente: facturas (desde 4c, también cobros) con saldo acumulado, y las pendientes (customerAccount).
create function public.customer_account(p_company_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
  v_today date := private.business_date(p_company_id);
begin
  perform private.require_read(p_company_id, 'receivable.read');
  select * into v_customer from public.customers c where c.id = p_customer_id and c.company_id = p_company_id;
  if not found then
    return null;
  end if;
  return (
    with invoices as (
      select d.*, x.letter, x.point_of_sale, x.invoice_number
        from public.documents d join public.sales_invoices x on x.document_id = d.id
       where d.company_id = p_company_id and d.doc_type = 'SALES_INVOICE' and d.customer_id = v_customer.id
         and d.status = any (private.invoiced_sales_statuses())
    ),
    moves as (
      select i.*, sum(i.total) over (order by i.document_date, i.number rows between unbounded preceding and current row) as balance
        from invoices i
    )
    select jsonb_build_object(
      'customer', to_jsonb(v_customer),
      'movements', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'document_id', m.id, 'display_number', m.display_number, 'path', private.doc_path(m.id),
                 'date', m.document_date,
                 'description', 'Factura ' || private.sales_invoice_label(m.letter, m.point_of_sale, m.invoice_number),
                 'debit', m.total, 'credit', 0, 'balance', m.balance)
               order by m.document_date, m.number)
          from moves m), '[]'::jsonb),
      'pending', coalesce((
        select jsonb_agg(p.i order by d.document_date, d.number)
          from public.documents d
          cross join lateral (select private.receivable_invoice(d, v_today) as i) as p
         where d.id in (select i.id from invoices i) and (p.i ->> 'pending')::numeric > 0), '[]'::jsonb),
      'balance', coalesce((select sum(i.total) from invoices i), 0),
      'credit_used', private.customer_credit_used(v_customer.id)
    )
  );
end;
$$;

grant execute on function public.sales_orders_invoiceable(uuid) to authenticated;
grant execute on function public.receivables_list(uuid) to authenticated;
grant execute on function public.customer_account(uuid, uuid) to authenticated;

-- ------------------------------------------------------------------ Documentos: la factura de venta en las lecturas comunes

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
$$;

-- Igual que antes, con los ítems de la factura de venta.
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

-- Igual que antes, con la factura de venta y lo que falta facturar del pedido (nextStep).
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

-- Igual que antes, con lo facturado en el pedido y la factura de venta: sus ítems, su pedido, su lugar en el flujo y sus firmas.
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
                              'DELIVERY_NOTE', 'SALES_INVOICE', 'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;
