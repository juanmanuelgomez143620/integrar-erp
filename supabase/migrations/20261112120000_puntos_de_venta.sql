-- 98. Fase 8d.2 (docs/FASE_8_BANCO_Y_FISCO.md §4): los puntos de venta y la autorización de las
-- facturas de venta. Quien factura (sales_invoice.create: Ventas) pide habilitar un punto de venta;
-- quien opera el fisco (fisco.operate: Impuestos) lo habilita o lo rechaza con el motivo, y no lo
-- decide quien lo pidió (SoD-14). Si el docente pasa el fisco al sistema (fisco_mode), se habilita en
-- el momento. La factura de venta se crea sólo con un punto de venta habilitado y, al registrarse, el
-- fisco la autoriza en el momento: SIM-, la fecha y un correlativo de la empresa, con 10 días de
-- vigencia. Traducción de "Puntos de venta (8d.2)" de engine.ts.
--
-- La plantilla, en la migración siguiente; las empresas que ya existían reciben su punto de venta
-- 00001 y el código de sus facturas registradas en la última de esta fase.

-- ------------------------------------------------------------------ Tablas

create table public.points_of_sale (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  number text not null check (number ~ '^[0-9]{5}$'),
  description text not null check (length(description) between 3 and 60),
  status text not null default 'SOLICITADO' check (status in ('SOLICITADO', 'HABILITADO', 'RECHAZADO')),
  requested_by uuid,
  requested_on date not null,
  decided_by uuid,
  decided_on date,
  rejection_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (company_id, number),
  unique (company_id, id)
);

create trigger points_of_sale_audit before insert or update on public.points_of_sale
  for each row execute function private.set_audit_fields();
create trigger points_of_sale_same_company before update on public.points_of_sale
  for each row execute function private.prevent_company_change();
alter table public.points_of_sale enable row level security;
revoke all on table public.points_of_sale from anon, authenticated;
grant select on table public.points_of_sale to authenticated;
create policy points_of_sale_select on public.points_of_sale for select to authenticated
  using (company_id in (select private.companies_with_permission('fisco.read'))
         or company_id in (select private.companies_with_permission('sales_invoice.create')));

-- El código de autorización simulado de la factura y su vencimiento (null en borrador).
alter table public.sales_invoices
  add column authorization_code text check (authorization_code ~ '^SIM-[0-9]{14}$'),
  add column authorization_due date;
create unique index sales_invoices_authorization_idx on public.sales_invoices (company_id, authorization_code)
  where authorization_code is not null;

-- ------------------------------------------------------------------ Auxiliares

-- Quién opera el fisco: Impuestos (por defecto) o el sistema (fiscoMode).
create function private.fisco_mode(p_company uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$ select coalesce((select c.settings ->> 'fisco_mode' from public.companies c where c.id = p_company), 'ESTUDIANTES') $$;

-- El punto de venta 00001 de la apertura, habilitado: la plantilla y cada empresa nueva. Idempotente
-- (openPointOfSale).
create function private.open_point_of_sale(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.points_of_sale (company_id, number, description, status, requested_on, decided_on)
  select p_company, '00001', 'Casa central', 'HABILITADO', private.business_date(p_company),
         private.business_date(p_company)
   where not exists (select 1 from public.points_of_sale p where p.company_id = p_company);
$$;

-- El fisco decide un pedido: lo habilita (sin motivo) o lo rechaza con el motivo. Ventas recibe el
-- aviso (decidePointOfSale).
create function private.pos_decide(p_pos uuid, p_reason text, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pos public.points_of_sale;
begin
  update public.points_of_sale p
     set status = case when p_reason is null then 'HABILITADO' else 'RECHAZADO' end,
         decided_by = p_user, decided_on = private.business_date(p.company_id), rejection_reason = p_reason
   where p.id = p_pos
  returning * into v_pos;
  perform private.notify_roles(v_pos.company_id, array['VENTAS'], 'PUNTO_VENTA',
    case when p_reason is null then 'El fisco habilitó el punto de venta ' || v_pos.number
         else 'El fisco rechazó el punto de venta ' || v_pos.number end,
    case when p_reason is null then 'Ya se puede elegir al crear una factura de venta.' else 'Motivo: ' || p_reason end,
    '/e/' || (select c.slug from public.companies c where c.id = v_pos.company_id) || '/fisco/puntos-de-venta',
    null, null);
end;
$$;

-- Mientras haya un pedido sin decidir y lo opere Impuestos, Impuestos tiene la tarea de decidirlo
-- (syncPointOfSaleTask).
create function private.pos_sync_task(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open uuid;
  v_task uuid;
begin
  select t.id into v_open from public.tasks t
   where t.company_id = p_company and t.task_type = 'HABILITAR_PUNTO_VENTA' and t.status in ('PENDIENTE', 'EN_CURSO')
   order by t.created_at limit 1;
  if private.fisco_mode(p_company) = 'AUTOMATICO'
     or not exists (select 1 from public.points_of_sale p where p.company_id = p_company and p.status = 'SOLICITADO') then
    if v_open is not null then
      update public.tasks set status = 'RESUELTA', completed_by = (select auth.uid()), completed_at = now()
       where id = v_open;
    end if;
    return;
  end if;
  if v_open is not null then
    return;
  end if;
  insert into public.tasks (company_id, task_type, title, description, context, assigned_role, priority)
  values (p_company, 'HABILITAR_PUNTO_VENTA', 'Habilitar el punto de venta que pidió Ventas',
          'Ventas pidió habilitar un punto de venta: lo habilita o lo rechaza, desde Fisco simulado → Puntos de venta, un integrante de Impuestos que no lo pidió.',
          '{}', 'IMPUESTOS', 'NORMAL')
  returning id into v_task;
  perform private.notify_roles(
    p_company, array['IMPUESTOS'], 'NUEVA_TAREA', 'Pedido de punto de venta',
    'Ventas pidió habilitar un punto de venta: habilitalo o rechazalo desde Fisco simulado → Puntos de venta.',
    '/e/' || (select c.slug from public.companies c where c.id = p_company) || '/fisco/puntos-de-venta', null, v_task
  );
end;
$$;

-- Al cambiar quién opera el fisco: si pasa al sistema, habilita lo que esperaba; si vuelve a
-- Impuestos, le abre su tarea (settleFisco).
create function private.fisco_settle(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pos uuid;
begin
  if private.fisco_mode(p_company) = 'AUTOMATICO' then
    for v_pos in
      select p.id from public.points_of_sale p
       where p.company_id = p_company and p.status = 'SOLICITADO' order by p.number
    loop
      perform private.pos_decide(v_pos, null, null);
    end loop;
  end if;
  perform private.pos_sync_task(p_company);
end;
$$;

-- ------------------------------------------------------------------ Comandos

-- Quien factura pide habilitar un punto de venta nuevo, con el número que sigue a los que ya hay
-- (también a los rechazados). Uno por vez; si el fisco lo opera el sistema, queda habilitado.
-- p_input: {description} (cmdRequestPointOfSale).
create function public.point_of_sale_request(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'sales_invoice.create');
  v_description text := btrim(coalesce(p_input ->> 'description', ''));
  v_waiting text;
  v_pos public.points_of_sale;
begin
  if length(v_description) < 3 or length(v_description) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá para qué es el punto de venta (de 3 a 60 caracteres).');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('point_of_sale:' || p_company_id, 0));
  select p.number into v_waiting from public.points_of_sale p
   where p.company_id = p_company_id and p.status = 'SOLICITADO' order by p.number limit 1;
  if v_waiting is not null then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('El punto de venta %s todavía espera la respuesta del fisco: se pide de a uno.', v_waiting));
  end if;
  insert into public.points_of_sale (company_id, number, description, requested_by, requested_on)
  values (p_company_id,
          lpad((coalesce((select max(p.number::int) from public.points_of_sale p where p.company_id = p_company_id), 0)
                + 1)::text, 5, '0'),
          v_description, (select auth.uid()), private.business_date(p_company_id))
  returning * into v_pos;
  perform private.log_audit(p_company_id, v_actor, 'REQUEST', 'point_of_sale', v_pos.id, 'Punto de venta ' || v_pos.number,
    format('Pidió al fisco habilitar el punto de venta %s: %s', v_pos.number, v_description));
  if private.fisco_mode(p_company_id) = 'AUTOMATICO' then
    perform private.pos_decide(v_pos.id, null, null);
  end if;
  perform private.pos_sync_task(p_company_id);
  return jsonb_build_object('id', v_pos.id, 'number', v_pos.number,
                            'status', (select p.status from public.points_of_sale p where p.id = v_pos.id));
end;
$$;

-- Quien opera el fisco habilita un pedido o lo rechaza con el motivo. Quien lo pidió no lo decide
-- (SoD-14). p_input: {approve, reason} (cmdDecidePointOfSale).
create function public.point_of_sale_decide(p_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pos public.points_of_sale;
  v_actor private.actor;
  v_sod boolean;
  v_approve boolean := coalesce((p_input ->> 'approve')::boolean, false);
  v_reason text;
begin
  select * into v_pos from public.points_of_sale p where p.id = p_id for update;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'El punto de venta no existe.');
  end if;
  v_actor := private.require_permission(v_pos.company_id, 'fisco.operate');
  if v_pos.status <> 'SOLICITADO' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('El punto de venta %s ya está %s.', v_pos.number,
             case v_pos.status when 'HABILITADO' then 'habilitado' else 'rechazado' end));
  end if;
  v_sod := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c
                     where c.id = v_pos.company_id), true)
           and not private.is_supervisor(v_pos.company_id);
  if v_sod and v_pos.requested_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés decidir el punto de venta %s: lo pediste vos.', v_pos.number),
      'Separación de funciones (SoD-14): quien pide un punto de venta no lo habilita. Lo decide otro integrante de Impuestos.');
  end if;
  if not v_approve then
    v_reason := btrim(coalesce(p_input ->> 'reason', ''));
    if length(v_reason) < 3 then
      perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo del rechazo: lo recibe Ventas.');
    end if;
  end if;
  perform private.pos_decide(p_id, v_reason, (select auth.uid()));
  perform private.pos_sync_task(v_pos.company_id);
  select * into v_pos from public.points_of_sale p where p.id = p_id;
  perform private.log_audit(v_pos.company_id, v_actor, case when v_approve then 'APPROVE' else 'REJECT' end,
    'point_of_sale', v_pos.id, 'Punto de venta ' || v_pos.number,
    case when v_approve then format('Habilitó el punto de venta %s: %s', v_pos.number, v_pos.description)
         else format('Rechazó el punto de venta %s: %s', v_pos.number, v_reason) end);
  return jsonb_build_object('status', v_pos.status);
end;
$$;

-- ------------------------------------------------------------------ Lecturas

-- Los puntos de venta de la empresa, por número. Los ven quien lee el fisco y quien factura: así, con
-- el módulo del fisco bloqueado, la factura sigue eligiendo su punto de venta (pointsOfSale).
create function public.points_of_sale(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id,
    case when private.has_permission(p_company_id, 'sales_invoice.create') then 'sales_invoice.create'
         else 'fisco.read' end);
  return coalesce((
    select jsonb_agg(to_jsonb(p) || jsonb_build_object(
             'requested_by_name', case when p.requested_by is not null then private.full_name(p.requested_by) end,
             'decided_by_name', case when p.decided_by is not null then private.full_name(p.decided_by) end)
           order by p.number collate "C")
      from public.points_of_sale p where p.company_id = p_company_id), '[]'::jsonb);
end;
$$;

-- El registro de comprobantes autorizados: las facturas de venta autorizadas en un mes (AAAA-MM), por
-- código (authorizedVouchers).
create function public.authorized_vouchers(p_company_id uuid, p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'fisco.read');
  if coalesce(p_month, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el mes: el año y el mes, como 2026-11.');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'document_id', d.id, 'display_number', d.display_number, 'date', d.document_date,
             'authorization_code', x.authorization_code, 'authorization_due', x.authorization_due,
             'invoice_label', private.sales_invoice_label(x.letter, x.point_of_sale, x.invoice_number),
             'customer_name', c.legal_name, 'customer_cuit', c.tax_id, 'total', d.total, 'status', d.status)
           order by x.authorization_code collate "C")
      from public.sales_invoices x
      join public.documents d on d.id = x.document_id
      join public.customers c on c.id = d.customer_id
     where x.company_id = p_company_id and x.authorization_code is not null
       and to_char(d.document_date, 'YYYY-MM') = p_month), '[]'::jsonb);
end;
$$;

grant execute on function public.point_of_sale_request(uuid, jsonb) to authenticated;
grant execute on function public.point_of_sale_decide(uuid, jsonb) to authenticated;
grant execute on function public.points_of_sale(uuid) to authenticated;
grant execute on function public.authorized_vouchers(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, y además el fisco la autoriza en el momento: SIM-, la fecha y el correlativo de la
-- empresa, con 10 días de vigencia (registerSalesInvoice).
create or replace function private.register_sales_invoice(p_doc public.documents)
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
  v_code text;
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
  -- El fisco la autoriza en el momento: SIM-, la fecha y el correlativo de la empresa (8d.2).
  perform pg_advisory_xact_lock(hashtextextended('fisco_authorization:' || p_doc.company_id, 0));
  select 'SIM-' || to_char(v_today, 'YYYYMMDD')
         || lpad((coalesce(max(right(x.authorization_code, 6)::int), 0) + 1)::text, 6, '0')
    into v_code
    from public.sales_invoices x
   where x.company_id = p_doc.company_id and x.authorization_code is not null;
  update public.documents set document_date = v_today where id = p_doc.id;
  update public.sales_invoices
     set invoice_number = v_number,
         due_date = v_today + (select so.payment_terms_days from public.sales_orders so where so.document_id = v_order.id),
         authorization_code = v_code,
         authorization_due = v_today + 10
   where document_id = p_doc.id;
  v_label := private.sales_invoice_label(v_fv.letter, v_fv.point_of_sale, v_number);
  v_actor := private.transition_document(p_doc.id, 'CONFIRM', p_summary => format('Registró %s: factura %s a %s por %s, autorizada por el fisco con el código %s',
    p_doc.display_number, v_label, v_customer.legal_name, private.format_money(p_doc.total), v_code));
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

-- Igual que antes, salvo que elige un punto de venta habilitado por el fisco (el 00001 por defecto) y
-- no se crea con uno que no lo está (cmdCreateSalesInvoice).
create or replace function public.fv_create(p_company_id uuid, p_input jsonb, p_register boolean default false)
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
  v_pos text;
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
  -- Un punto de venta habilitado por el fisco (8d.2): el 00001 si no viene.
  v_pos := btrim(coalesce(p_input ->> 'point_of_sale', '00001'));
  if not exists (select 1 from public.points_of_sale p
                  where p.company_id = p_company_id and p.number = v_pos and p.status = 'HABILITADO') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('El punto de venta %s no está habilitado por el fisco: elegí uno habilitado.', v_pos),
      'Los puntos de venta nuevos los pide Ventas y los habilita Impuestos, en Fisco simulado → Puntos de venta.');
  end if;

  select * into v_customer from public.customers c where c.id = v_order.customer_id;
  v_letter := private.sales_letter(p_company_id, v_customer.id);
  select * into v_number from private.next_document_number(p_company_id, 'SALES_INVOICE');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, customer_id, notes, created_by)
  values (p_company_id, 'SALES_INVOICE', v_number.number, v_number.display_number, 'BORRADOR', private.business_date(p_company_id),
          (v_actor).sector_id, v_customer.id, trim(coalesce(p_input ->> 'notes', '')), (v_actor).user_id)
  returning * into v_doc;
  insert into public.sales_invoices (document_id, company_id, sales_order_id, letter, point_of_sale, due_date)
  values (v_doc.id, p_company_id, v_order.id, v_letter, v_pos,
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

-- Igual que antes, y además quién opera el fisco simulado (fisco_mode): al pasarlo al sistema, habilita
-- los puntos de venta pedidos; al volver a Impuestos, lo que espera le abre su tarea (cmdUpdateCompanySettings).
create or replace function public.company_update_settings(p_company_id uuid, p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_before jsonb;
  v_after jsonb;
  v_rates jsonb;
  v_key text;
  v_value jsonb;
begin
  select c.settings into v_before from public.companies c where c.id = p_company_id for update;
  select v_before || coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_after
    from jsonb_each(p_settings)
   where key in ('sod_enabled', 'allow_negative_stock') and jsonb_typeof(value) = 'boolean';
  if jsonb_typeof(p_settings -> 'payroll') = 'object' then
    v_rates := coalesce(v_before -> 'payroll', '{}');
    foreach v_key in array array['seniority_pct', 'attendance_pct', 'retirement_pct', 'pami_pct', 'health_pct',
                                  'employer_pct'] loop
      v_value := p_settings -> 'payroll' -> v_key;
      continue when v_value is null;
      if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric < 0 or (v_value #>> '{}')::numeric > 100
         or round((v_value #>> '{}')::numeric, 2) <> (v_value #>> '{}')::numeric then
        perform private.raise_business_error('DATO_INVALIDO',
          'Los porcentajes de la liquidación van de 0 a 100, con hasta 2 decimales.');
      end if;
      v_rates := v_rates || jsonb_build_object(v_key, v_value);
    end loop;
    v_after := v_after || jsonb_build_object('payroll', v_rates);
  end if;
  if p_settings ? 'iibb_pct' then
    v_value := p_settings -> 'iibb_pct';
    if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric < 0 or (v_value #>> '{}')::numeric > 100
       or round((v_value #>> '{}')::numeric, 2) <> (v_value #>> '{}')::numeric then
      perform private.raise_business_error('DATO_INVALIDO',
        'La alícuota de ingresos brutos va de 0 a 100, con hasta 2 decimales.');
    end if;
    v_after := v_after || jsonb_build_object('iibb_pct', v_value);
  end if;
  if p_settings ? 'bank_mode' then
    if coalesce(p_settings ->> 'bank_mode', '') not in ('AUTOMATICO', 'ESTUDIANTES') then
      perform private.raise_business_error('DATO_INVALIDO', 'Elegí quién opera el Banco Aula.');
    end if;
    v_after := v_after || jsonb_build_object('bank_mode', p_settings -> 'bank_mode');
  end if;
  if p_settings ? 'fisco_mode' then
    if coalesce(p_settings ->> 'fisco_mode', '') not in ('AUTOMATICO', 'ESTUDIANTES') then
      perform private.raise_business_error('DATO_INVALIDO', 'Elegí quién opera el fisco simulado.');
    end if;
    v_after := v_after || jsonb_build_object('fisco_mode', p_settings -> 'fisco_mode');
  end if;
  update public.companies set settings = v_after where id = p_company_id;
  -- Al cambiar quién opera el banco: si pasa al sistema, ejecuta lo pendiente con la fecha del día (un
  -- cheque, desde que se presenta); al volver a Tesorería, lo que espera le abre su tarea.
  if p_settings ? 'bank_mode' then
    perform private.bank_settle(p_company_id);
  end if;
  -- Lo mismo con quién opera el fisco: el sistema habilita los puntos de venta pedidos (8d.2).
  if p_settings ? 'fisco_mode' then
    perform private.fisco_settle(p_company_id);
  end if;
  perform private.log_audit(p_company_id, v_actor, 'SETTINGS', 'company', p_company_id,
    (select c.legal_name from public.companies c where c.id = p_company_id),
    case when jsonb_typeof(p_settings -> 'payroll') = 'object'
      then 'Cambió los porcentajes de la liquidación de sueldos'
      when p_settings ? 'iibb_pct' then 'Cambió la alícuota de ingresos brutos'
      when p_settings ? 'bank_mode' then 'Cambió quién opera el Banco Aula: '
        || case v_after ->> 'bank_mode' when 'AUTOMATICO' then 'lo opera el sistema' else 'lo opera Tesorería' end
      when p_settings ? 'fisco_mode' then 'Cambió quién opera el fisco simulado: '
        || case v_after ->> 'fisco_mode' when 'AUTOMATICO' then 'lo opera el sistema' else 'lo opera Impuestos' end
      else 'Cambió la configuración de control interno de la empresa' end,
    null, null, null,
    private.diff(v_before, v_after, array['sod_enabled', 'allow_negative_stock', 'payroll', 'iibb_pct', 'bank_mode', 'fisco_mode']));
end;
$$;

-- Igual que antes, y además el punto de venta 00001 habilitado (cmdCreateCompanyFromTemplate).
create or replace function public.company_create_from_template(p_course_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
  v_template public.companies;
  v_course public.courses;
  v_id uuid;
  v_slug text;
begin
  if private.current_app_role() not in ('DOCENTE', 'SUPERADMIN') then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo un docente puede crear la empresa simulada de su curso.');
  end if;
  select * into v_template from public.companies c where c.is_template and c.status = 'ACTIVA' order by c.created_at limit 1;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'No hay una empresa plantilla disponible.');
  end if;
  select * into v_course from public.courses c where c.id = p_course_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el curso para el que se crea la empresa.');
  end if;
  v_slug := private.unique_slug(private.slugify(format('%s %s %s', v_template.trade_name, v_course.name, v_course.academic_year)));
  v_id := private.clone_company(v_template.id, v_course.id, v_slug, v_uid);
  perform private.log_audit(v_id, private.actor_for(v_id), 'CREATE', 'company', v_id, v_template.legal_name,
    format('Creó la empresa para %s %s a partir de la plantilla %s', v_course.name, v_course.academic_year, v_template.legal_name));
  perform private.copy_initial_stock(v_template.id, v_id);
  perform private.start_accounting(v_id);
  perform private.bank_open_account(v_id);
  perform private.insert_padron(v_id);
  perform private.open_point_of_sale(v_id);
  return jsonb_build_object('id', v_id, 'slug', v_slug);
end;
$$;

-- Igual que antes, y además el código de autorización de la factura de venta y su vencimiento (document_json).
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
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at,
               'authorization_code', x.authorization_code, 'authorization_due', x.authorization_due))
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

-- Igual que antes, y además el enlace de la tarea de habilitar un punto de venta (taskList).
create or replace function private.task_items(p_company uuid, p_all boolean, p_include_closed boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select (select auth.uid()) as uid, array(select private.my_role_codes(p_company)) as roles
  )
  select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object(
           'mine', x.mine,
           'document_label', d.display_number,
           'document_type', d.doc_type,
           'path', case when d.id is not null then private.doc_path(d.id)
                        when t.task_type = 'REPONER_STOCK' then '/e/' || c.slug || '/stock'
                        when t.task_type = 'PROCESAR_BANCO' then '/e/' || c.slug || '/pagos/banco-aula/bandeja'
                        when t.task_type = 'REGISTRAR_CARGOS_BANCO' then '/e/' || c.slug || '/pagos/conciliaciones/nueva'
                        when t.task_type in ('RESOLVER_RECHAZO_BANCO', 'EVALUAR_PRESTAMO')
                          then '/e/' || c.slug || '/pagos/banco-aula/bandeja'
                        when t.task_type = 'HABILITAR_PUNTO_VENTA' then '/e/' || c.slug || '/fisco/puntos-de-venta' end,
           'assignee_label', case when t.assigned_user_id is not null then private.full_name(t.assigned_user_id)
                                  when t.assigned_role is not null then (select r.name from public.roles r where r.code = t.assigned_role)
                                  else '—' end,
           'claimed_by_name', case when t.claimed_by is not null then private.full_name(t.claimed_by) end,
           'completed_by_name', case when t.completed_by is not null then private.full_name(t.completed_by) end)
         order by t.status = 'EN_CURSO' desc, t.created_at desc), '[]')
    from public.tasks t
    cross join me
    cross join lateral (
      select coalesce(t.assigned_user_id = me.uid, false) or coalesce(t.assigned_role = any (me.roles), false) as mine
    ) x
    join public.companies c on c.id = t.company_id
    left join public.documents d on d.id = t.document_id
   where t.company_id = p_company
     and p_company in (select private.my_companies()) -- sólo quien participa en la empresa (o soporte)
     and (p_include_closed or t.status in ('PENDIENTE', 'EN_CURSO'))
     and (x.mine or p_all)
$$;
