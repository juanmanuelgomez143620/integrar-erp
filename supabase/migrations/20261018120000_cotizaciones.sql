-- 25. Fase 3c (docs/FASE_3_COMPRAS_Y_TESORERIA.md §6): solicitud de
-- cotización, cotizaciones de proveedores, cuadro comparativo y adjudicación,
-- que genera la orden de compra. Traducción de la sección "Cotizaciones" de
-- src/lib/mock/engine.ts y de sus lecturas en queries.ts, con los mismos
-- mensajes y la misma forma de datos (las pruebas de paridad lo comparan).
--
-- Los tipos de documento, estados, transiciones, permisos y tareas nuevos
-- están en la migración de catálogos siguiente.

-- ------------------------------------------------------------------ Catálogos: la acción de adjudicar

alter table public.permissions drop constraint permissions_action_check;
alter table public.permissions add constraint permissions_action_check
  check (action in ('read', 'create', 'update', 'approve', 'cancel', 'delete', 'export', 'pay', 'award'));
alter table public.document_transitions drop constraint document_transitions_action_check;
alter table public.document_transitions add constraint document_transitions_action_check
  check (action in ('SUBMIT', 'APPROVE', 'REJECT', 'WITHDRAW', 'REOPEN', 'SEND', 'CONFIRM', 'CANCEL', 'CLOSE', 'PAY', 'AWARD', 'SYSTEM'));

-- ------------------------------------------------------------------ Tablas

-- Solicitud de cotización: 1 a 1 con documents (tipo RFQ).
create table public.rfqs (
  document_id uuid primary key,
  doc_type text not null default 'RFQ' check (doc_type = 'RFQ'),
  company_id uuid not null,
  response_due date not null,             -- hasta cuándo responden los proveedores
  warehouse_id uuid not null,             -- depósito de entrega: pasa a la OC
  award_reason text not null default '',  -- por qué se adjudicó (obligatorio si no es la más conveniente)
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, warehouse_id) references public.warehouses (company_id, id)
);

create table public.rfq_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  requisition_line_id uuid,               -- línea de SC que atiende
  notes text not null default '',         -- especificación para el proveedor
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.rfqs (company_id, document_id) on delete cascade,
  foreign key (company_id, product_id) references public.products (company_id, id),
  foreign key (company_id, requisition_line_id) references public.purchase_requisition_lines (company_id, id)
);

-- Proveedores invitados a cotizar.
create table public.rfq_suppliers (
  company_id uuid not null,
  document_id uuid not null,
  supplier_id uuid not null,
  primary key (document_id, supplier_id),
  foreign key (company_id, document_id) references public.rfqs (company_id, document_id) on delete cascade,
  foreign key (company_id, supplier_id) references public.suppliers (company_id, id)
);

-- Cotización de un proveedor: 1 a 1 con documents (tipo SUPPLIER_QUOTE).
create table public.supplier_quotes (
  document_id uuid primary key,
  doc_type text not null default 'SUPPLIER_QUOTE' check (doc_type = 'SUPPLIER_QUOTE'),
  company_id uuid not null,
  rfq_id uuid not null,
  supplier_reference text not null default '', -- número de la cotización del proveedor
  valid_until date not null,
  delivery_days int not null check (delivery_days >= 0),
  payment_terms_days int not null check (payment_terms_days >= 0),
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, rfq_id) references public.rfqs (company_id, document_id)
);
create index supplier_quotes_rfq_idx on public.supplier_quotes (rfq_id);

-- Lo que cotiza para cada ítem (la cantidad es la pedida).
create table public.supplier_quote_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  rfq_line_id uuid not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_price numeric(14, 4) not null check (unit_price > 0), -- neto; el final si no discrimina IVA
  vat_rate numeric(5, 2) not null check (vat_rate in (0, 10.5, 21, 27)),
  line_subtotal numeric(14, 2) not null,
  line_tax numeric(14, 2) not null,
  line_total numeric(14, 2) not null,
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.supplier_quotes (company_id, document_id) on delete cascade,
  foreign key (company_id, rfq_line_id) references public.rfq_lines (company_id, id),
  foreign key (company_id, product_id) references public.products (company_id, id)
);
create index supplier_quote_lines_rfq_line_idx on public.supplier_quote_lines (rfq_line_id);

do $$
declare
  t text;
begin
  foreach t in array array['rfqs', 'rfq_lines', 'rfq_suppliers', 'supplier_quotes', 'supplier_quote_lines'] loop
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

create policy rfqs_select on public.rfqs for select to authenticated
  using (company_id in (select private.companies_with_permission('rfq.read')));
create policy rfq_lines_select on public.rfq_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('rfq.read')));
create policy rfq_suppliers_select on public.rfq_suppliers for select to authenticated
  using (company_id in (select private.companies_with_permission('rfq.read')));
create policy supplier_quotes_select on public.supplier_quotes for select to authenticated
  using (company_id in (select private.companies_with_permission('supplier_quote.read')));
create policy supplier_quote_lines_select on public.supplier_quote_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('supplier_quote.read')));

-- ------------------------------------------------------------------ Utilidades

-- Otro documento, para enlazarlo (DocRef).
create function private.doc_ref(p_document uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', d.id, 'display_number', d.display_number, 'status', d.status,
                            'path', private.doc_path(d.id), 'status_info', private.status_info(d.doc_type, d.status))
    from public.documents d where d.id = p_document
$$;

-- Las cotizaciones de una solicitud que no se anularon, por número (quotesOf).
create function private.rfq_quotes(p_rfq uuid)
returns setof public.documents
language sql
stable
security definer
set search_path = ''
as $$
  select d.* from public.supplier_quotes q join public.documents d on d.id = q.document_id
   where q.rfq_id = p_rfq and d.status <> 'ANULADA'
   order by d.number
$$;

-- Vigente: recibida y con la oferta todavía válida (quoteIsValid).
create function private.quote_is_valid(p_quote uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select d.status = 'RECIBIDA' and q.valid_until >= private.business_date(d.company_id)
      from public.documents d join public.supplier_quotes q on q.document_id = d.id
     where d.id = p_quote), false)
$$;

-- La más conveniente por precio: entre las vigentes que cotizan todos los
-- ítems, la de menor costo (el neto) y, a igual costo, la de menor plazo de
-- entrega (bestQuote; a validar).
create function private.best_quote(p_rfq uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
    from public.documents d join public.supplier_quotes q on q.document_id = d.id
   where q.rfq_id = p_rfq and private.quote_is_valid(d.id)
     and (select count(*) from public.supplier_quote_lines l where l.document_id = d.id)
         = (select count(*) from public.rfq_lines r where r.document_id = p_rfq)
   order by d.subtotal, q.delivery_days, d.number
   limit 1
$$;

-- La orden de compra que nació de una cotización adjudicada (orderFromQuote).
create function private.order_from_quote(p_quote uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id from public.document_links k join public.documents d on d.id = k.to_document_id
   where k.from_document_id = p_quote and d.doc_type = 'PURCHASE_ORDER'
   order by d.number
   limit 1
$$;

-- ------------------------------------------------------------------ Solicitud de cotización: comandos

-- p_input: {response_due, warehouse_id, notes, supplier_ids: [uuid], lines: [{product_id, quantity, requisition_line_id, notes}]} (cmdCreateRfq)
create function public.rfq_create(p_company_id uuid, p_input jsonb, p_send boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'rfq.create');
  v_due date := private.parse_date(p_input ->> 'response_due');
  v_id text;
  v_supplier public.suppliers;
  v_suppliers uuid[] := '{}';
  v_line jsonb;
  v_lines jsonb := '[]';
  v_p public.products;
  v_qty numeric;
  v_rl public.purchase_requisition_lines;
  v_req public.documents;
  v_used jsonb := '{}';
  v_total_used numeric;
  v_pending numeric;
  v_doc public.documents;
  v_items int;
begin
  if v_due is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá hasta cuándo pueden responder los proveedores.');
  end if;
  if v_due < private.business_date(p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha límite para responder no puede ser anterior a hoy.');
  end if;
  if not exists (select 1 from public.warehouses w where w.company_id = p_company_id and w.id::text = p_input ->> 'warehouse_id') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el depósito de entrega.');
  end if;
  -- Cada proveedor una vez, en el orden en que se eligieron.
  for v_id in
    select s from jsonb_array_elements_text(coalesce(p_input -> 'supplier_ids', '[]')) with ordinality as e (s, ord)
     where s <> '' group by s order by min(ord)
  loop
    select * into v_supplier from public.suppliers s where s.company_id = p_company_id and s.id::text = v_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Uno de los proveedores invitados no existe en esta empresa.');
    end if;
    if not v_supplier.is_active then
      perform private.raise_business_error('DATO_INVALIDO', format('El proveedor %s está inactivo.', v_supplier.legal_name));
    end if;
    v_suppliers := v_suppliers || v_supplier.id;
  end loop;
  if coalesce(array_length(v_suppliers, 1), 0) < 2 then
    perform private.raise_business_error('DATO_INVALIDO', 'Invitá al menos a dos proveedores: la idea es comparar sus ofertas.',
      'Pedir más de un precio permite elegir con fundamento.');
  end if;
  for v_line in
    select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) with ordinality as x (l, ord)
     where nullif(l ->> 'product_id', '') is not null
     order by ord
  loop
    v_p := private.product_for(p_company_id, (v_line ->> 'product_id')::uuid);
    if not v_p.is_active then
      perform private.raise_business_error('DATO_INVALIDO', format('%s %s está inactivo.', v_p.code, v_p.name));
    end if;
    v_qty := round(coalesce((v_line ->> 'quantity')::numeric, 0), 3);
    if not v_qty > 0 then
      perform private.raise_business_error('DATO_INVALIDO',
        format('La cantidad de %s debe ser mayor que cero y tener hasta 3 decimales.', v_p.code));
    end if;
    if nullif(v_line ->> 'requisition_line_id', '') is not null then
      select * into v_rl from public.purchase_requisition_lines rl
       where rl.company_id = p_company_id and rl.id::text = v_line ->> 'requisition_line_id';
      if not found then
        perform private.raise_business_error('DATO_INVALIDO', 'La línea de solicitud vinculada no existe.');
      end if;
      select * into v_req from public.documents d where d.id = v_rl.document_id;
      if v_req.status not in ('SOLICITADO', 'ORDENADO_PARCIAL') then
        perform private.raise_business_error('TRANSICION_INVALIDA', format('%s no está pendiente de atención.', v_req.display_number));
      end if;
      if v_rl.product_id <> v_p.id then
        perform private.raise_business_error('DATO_INVALIDO', format('El producto no coincide con el de %s.', v_req.display_number));
      end if;
      v_total_used := coalesce((v_used ->> v_rl.id::text)::numeric, 0) + v_qty;
      v_used := v_used || jsonb_build_object(v_rl.id::text, v_total_used);
      select round(v_rl.quantity - coalesce(sum(pl.quantity), 0), 3) into v_pending
        from public.purchase_order_lines pl join public.documents d on d.id = pl.document_id
       where pl.requisition_line_id = v_rl.id and d.status <> 'ANULADO';
      if v_total_used > v_pending then
        perform private.raise_business_error('CANTIDAD_EXCEDE_PENDIENTE',
          format('%s: la cantidad supera lo pendiente de %s (%s).', v_p.code, v_req.display_number, private.format_qty(v_pending, v_p.uom_code)),
          'Si hace falta cotizar más, agregá una línea sin vínculo a la solicitud.');
      end if;
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_p.id, 'quantity', v_qty, 'requisition_line_id', nullif(v_line ->> 'requisition_line_id', ''),
      'notes', trim(coalesce(v_line ->> 'notes', ''))));
  end loop;
  v_items := jsonb_array_length(v_lines);
  if v_items = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Agregá al menos un ítem para cotizar.');
  end if;

  v_doc := private.new_document(p_company_id, 'RFQ', v_actor, null, trim(coalesce(p_input ->> 'notes', '')));
  insert into public.rfqs (document_id, company_id, response_due, warehouse_id)
  values (v_doc.id, p_company_id, v_due, (p_input ->> 'warehouse_id')::uuid);
  insert into public.rfq_lines (company_id, document_id, line_no, product_id, quantity, requisition_line_id, notes)
  select p_company_id, v_doc.id, ord::int, (l ->> 'product_id')::uuid, (l ->> 'quantity')::numeric,
         (l ->> 'requisition_line_id')::uuid, l ->> 'notes'
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord);
  insert into public.rfq_suppliers (company_id, document_id, supplier_id)
  select p_company_id, v_doc.id, s from unnest(v_suppliers) as s;
  perform private.link_documents(p_company_id, x.document_id, v_doc.id)
     from (select distinct rl.document_id from public.rfq_lines l
             join public.purchase_requisition_lines rl on rl.id = l.requisition_line_id
            where l.document_id = v_doc.id) as x;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'rfq', v_doc.id, v_doc.display_number,
    format('Creó %s: pide cotización a %s proveedores (%s ítem%s)', v_doc.display_number, array_length(v_suppliers, 1),
           v_items, case when v_items > 1 then 's' else '' end),
    v_doc.id, null, 'BORRADOR');
  if p_send then
    perform private.send_rfq(v_doc.id);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function private.send_rfq(p_document uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  select * into v_doc from public.documents d where d.id = p_document;
  perform private.transition_document(v_doc.id, 'SUBMIT',
    p_summary => format('Envió %s a %s proveedores', v_doc.display_number,
                        (select count(*) from public.rfq_suppliers s where s.document_id = v_doc.id)));
end;
$$;

create function public.rfq_submit(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'RFQ');
  perform private.send_rfq(v_doc.id);
end;
$$;

-- Anular la solicitud descarta las cotizaciones que seguían en juego (cmdCancelRfq).
create function public.rfq_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_quote public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'RFQ');
  perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
  for v_quote in select * from private.rfq_quotes(v_doc.id) q where q.status = 'RECIBIDA' order by q.number loop
    perform private.transition_document(v_quote.id, 'SYSTEM', p_to => 'DESCARTADA');
  end loop;
end;
$$;

-- ------------------------------------------------------------------ Cotización: comandos

-- p_input: {rfq_id, supplier_id, supplier_reference, valid_until, delivery_days, payment_terms_days, notes,
--           lines: [{rfq_line_id, unit_price, vat_rate}]} (cmdCreateSupplierQuote)
create function public.sq_create(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'supplier_quote.create');
  v_rfq public.documents;
  v_supplier public.suppliers;
  v_previous public.documents;
  v_valid date;
  v_delivery numeric;
  v_terms numeric;
  v_reference text := trim(coalesce(p_input ->> 'supplier_reference', ''));
  v_discriminates boolean;
  v_line jsonb;
  v_item public.rfq_lines;
  v_code text;
  v_seen uuid[] := '{}';
  v_price numeric;
  v_vat numeric;
  v_subtotal numeric;
  v_lines jsonb := '[]';
  v_number record;
  v_doc public.documents;
begin
  select * into v_rfq from public.documents d
   where d.id::text = p_input ->> 'rfq_id' and d.company_id = p_company_id and d.doc_type = 'RFQ';
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí la solicitud de cotización que responde el proveedor.');
  end if;
  if v_rfq.status <> 'ENVIADA' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está en estado "%s": se cargan cotizaciones de una solicitud enviada a los proveedores.',
             v_rfq.display_number, private.status_label(v_rfq.doc_type, v_rfq.status)));
  end if;
  select * into v_supplier from public.suppliers s where s.id::text = p_input ->> 'supplier_id' and s.company_id = p_company_id;
  if not found or not exists (select 1 from public.rfq_suppliers rs where rs.document_id = v_rfq.id and rs.supplier_id = v_supplier.id) then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Elegí uno de los proveedores invitados a cotizar en %s.', v_rfq.display_number));
  end if;
  if not v_supplier.is_active then
    perform private.raise_business_error('DATO_INVALIDO', format('El proveedor %s está inactivo.', v_supplier.legal_name));
  end if;
  select * into v_previous from private.rfq_quotes(v_rfq.id) q where q.supplier_id = v_supplier.id order by q.number limit 1;
  if v_previous.id is not null then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Ya está cargada la cotización de %s (%s). Si cambió su oferta, anulala y cargá la nueva.',
             v_supplier.legal_name, v_previous.display_number));
  end if;
  v_valid := private.parse_date(p_input ->> 'valid_until');
  if v_valid is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá hasta cuándo vale la oferta.');
  end if;
  if v_valid < private.business_date(p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'La oferta ya está vencida: pedile al proveedor que la renueve.');
  end if;
  v_delivery := (p_input ->> 'delivery_days')::numeric;
  if v_delivery is null or v_delivery < 0 or v_delivery <> trunc(v_delivery) then
    perform private.raise_business_error('DATO_INVALIDO', 'El plazo de entrega es una cantidad entera de días (0 o más).');
  end if;
  v_terms := (p_input ->> 'payment_terms_days')::numeric;
  if v_terms is null or v_terms < 0 or v_terms <> trunc(v_terms) then
    perform private.raise_business_error('DATO_INVALIDO', 'La condición de pago es una cantidad entera de días (0 = contado).');
  end if;
  if length(v_reference) > 40 then
    perform private.raise_business_error('DATO_INVALIDO', 'La referencia del proveedor tiene hasta 40 caracteres.');
  end if;
  -- Quien no es responsable inscripto no discrimina IVA: cotiza el precio final.
  v_discriminates := v_supplier.vat_condition = 'RESPONSABLE_INSCRIPTO';
  for v_line in
    select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) with ordinality as x (l, ord)
     where nullif(l ->> 'rfq_line_id', '') is not null
     order by ord
  loop
    select * into v_item from public.rfq_lines r where r.document_id = v_rfq.id and r.id::text = v_line ->> 'rfq_line_id';
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', format('Uno de los ítems no es de %s.', v_rfq.display_number));
    end if;
    if v_item.id = any (v_seen) then
      perform private.raise_business_error('DATO_INVALIDO', format('El ítem %s está dos veces en la cotización.', v_item.line_no));
    end if;
    v_seen := v_seen || v_item.id;
    select p.code into v_code from public.products p where p.id = v_item.product_id;
    v_price := (v_line ->> 'unit_price')::numeric;
    if v_price is null or v_price <= 0 or round(v_price, 4) <> v_price then
      perform private.raise_business_error('DATO_INVALIDO',
        format('El precio de %s debe ser mayor que cero y tener hasta 4 decimales.', v_code));
    end if;
    v_vat := case when v_discriminates then coalesce((v_line ->> 'vat_rate')::numeric, -1) else 0 end;
    if v_vat not in (0, 10.5, 21, 27) then
      perform private.raise_business_error('DATO_INVALIDO', format('La alícuota de IVA de %s no es válida.', v_code));
    end if;
    v_subtotal := round(v_item.quantity * v_price, 2);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'rfq_line_id', v_item.id, 'line_no', v_item.line_no, 'product_id', v_item.product_id, 'quantity', v_item.quantity,
      'unit_price', v_price, 'vat_rate', v_vat, 'subtotal', v_subtotal, 'tax', round(v_subtotal * v_vat / 100, 2)));
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá el precio de al menos un ítem.');
  end if;

  -- La cotización nace recibida: no tiene borrador.
  select * into v_number from private.next_document_number(p_company_id, 'SUPPLIER_QUOTE');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, supplier_id, notes, created_by)
  values (p_company_id, 'SUPPLIER_QUOTE', v_number.number, v_number.display_number, 'RECIBIDA', private.business_date(p_company_id),
          (v_actor).sector_id, v_supplier.id, trim(coalesce(p_input ->> 'notes', '')), (v_actor).user_id)
  returning * into v_doc;
  insert into public.supplier_quotes (document_id, company_id, rfq_id, supplier_reference, valid_until, delivery_days, payment_terms_days)
  values (v_doc.id, p_company_id, v_rfq.id, v_reference, v_valid, v_delivery::int, v_terms::int);
  insert into public.supplier_quote_lines (company_id, document_id, line_no, rfq_line_id, product_id, quantity, unit_price,
                                           vat_rate, line_subtotal, line_tax, line_total)
  select p_company_id, v_doc.id, row_number() over (order by (l ->> 'line_no')::int), (l ->> 'rfq_line_id')::uuid,
         (l ->> 'product_id')::uuid, (l ->> 'quantity')::numeric, (l ->> 'unit_price')::numeric, (l ->> 'vat_rate')::numeric,
         (l ->> 'subtotal')::numeric, (l ->> 'tax')::numeric, (l ->> 'subtotal')::numeric + (l ->> 'tax')::numeric
    from jsonb_array_elements(v_lines) as l;
  update public.documents d
     set subtotal = t.sub, tax_total = t.tax, total = t.sub + t.tax
    from (select sum(l.line_subtotal) as sub, sum(l.line_tax) as tax
            from public.supplier_quote_lines l where l.document_id = v_doc.id) as t
   where d.id = v_doc.id;
  perform private.link_documents(p_company_id, v_rfq.id, v_doc.id);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'supplier_quote', v_doc.id, v_doc.display_number,
    format('Cargó %s: cotización de %s para %s por %s', v_doc.display_number, v_supplier.legal_name, v_rfq.display_number,
           private.format_money((select d.total from public.documents d where d.id = v_doc.id))),
    v_doc.id, null, 'RECIBIDA');
  return private.created_result(v_doc.id);
end;
$$;

create function public.sq_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.transition_document((private.get_document(p_document_id, 'SUPPLIER_QUOTE')).id, 'CANCEL', p_reason);
end;
$$;

-- Adjudica la solicitud a una cotización vigente: genera la OC en borrador con
-- sus precios y condiciones, y descarta las demás. Si no es la más conveniente
-- por precio, hay que justificar la elección (cmdAwardRfq).
create function public.rfq_award(p_document_id uuid, p_quote_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rfq public.documents;
  v_actor private.actor;
  v_quote public.documents;
  v_sq public.supplier_quotes;
  v_supplier public.suppliers;
  v_comment text := trim(coalesce(p_reason, ''));
  v_best uuid;
  v_order jsonb;
  v_q public.documents;
begin
  perform private.require_active_user();
  v_rfq := private.get_document(p_document_id, 'RFQ');
  perform private.require_transition(v_rfq, 'AWARD');
  v_actor := private.require_permission(v_rfq.company_id, 'rfq.award');
  select * into v_quote from private.rfq_quotes(v_rfq.id) q where q.id = p_quote_id and q.status = 'RECIBIDA';
  if v_quote.id is null then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Elegí una de las cotizaciones recibidas para %s.', v_rfq.display_number));
  end if;
  select * into v_sq from public.supplier_quotes q where q.document_id = v_quote.id;
  select * into v_supplier from public.suppliers s where s.id = v_quote.supplier_id;
  if not private.quote_is_valid(v_quote.id) then
    perform private.raise_business_error('OFERTA_VENCIDA',
      format('La oferta de %s venció el %s: pedile que la renueve y cargá la nueva cotización.',
             v_supplier.legal_name, to_char(v_sq.valid_until, 'DD/MM/YYYY')));
  end if;
  v_best := private.best_quote(v_rfq.id);
  if v_quote.id is distinct from v_best and length(v_comment) < 10 then
    perform private.raise_business_error('MOTIVO_REQUERIDO',
      case when v_best is not null
        then format('%s no es la más conveniente por precio (es %s): explicá por qué la elegís, en al menos 10 caracteres.',
                    v_quote.display_number, (select d.display_number from public.documents d where d.id = v_best))
        else format('Ninguna cotización vigente cubre todos los ítems: explicá por qué elegís %s, en al menos 10 caracteres.',
                    v_quote.display_number)
      end,
      'Justificar la elección es parte del control: queda en la solicitud y Gerencia la ve al aprobar la orden de compra.');
  end if;
  v_order := public.po_create(v_rfq.company_id, jsonb_build_object(
    'supplier_id', v_supplier.id,
    'expected_date', private.business_date(v_rfq.company_id) + v_sq.delivery_days,
    'warehouse_id', (select r.warehouse_id from public.rfqs r where r.document_id = v_rfq.id),
    'payment_terms_days', v_sq.payment_terms_days,
    'delivery_terms', '',
    'notes', format('Según la cotización %s%s.', v_quote.display_number,
                    case when v_sq.supplier_reference <> '' then format(' (referencia del proveedor: %s)', v_sq.supplier_reference) else '' end),
    'lines', (select jsonb_agg(jsonb_build_object(
                       'product_id', l.product_id, 'requisition_line_id', r.requisition_line_id, 'quantity', l.quantity,
                       'unit_price', l.unit_price, 'vat_rate', l.vat_rate) order by l.line_no)
                from public.supplier_quote_lines l join public.rfq_lines r on r.id = l.rfq_line_id
               where l.document_id = v_quote.id)));
  perform private.link_documents(v_rfq.company_id, v_quote.id, (v_order ->> 'id')::uuid);
  update public.rfqs set award_reason = v_comment where document_id = v_rfq.id;
  perform private.transition_document(v_rfq.id, 'AWARD', p_actor => v_actor,
    p_summary => format('Adjudicó %s a %s (%s) y generó %s en borrador%s', v_rfq.display_number, v_supplier.legal_name,
                        v_quote.display_number, v_order ->> 'display_number',
                        case when v_comment <> '' then ' — ' || v_comment else '' end));
  for v_q in select * from private.rfq_quotes(v_rfq.id) q where q.status = 'RECIBIDA' order by q.number loop
    perform private.transition_document(v_q.id, 'SYSTEM',
      p_to => case when v_q.id = v_quote.id then 'ADJUDICADA' else 'DESCARTADA' end);
  end loop;
  return v_order;
end;
$$;

grant execute on function public.rfq_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.rfq_submit(uuid) to authenticated;
grant execute on function public.rfq_cancel(uuid, text) to authenticated;
grant execute on function public.rfq_award(uuid, uuid, text) to authenticated;
grant execute on function public.sq_create(uuid, jsonb) to authenticated;
grant execute on function public.sq_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Documentos: cotizaciones en las lecturas comunes

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
               'treasury_account_id', x.treasury_account_id, 'payment_reference', x.payment_reference, 'paid_on', x.paid_on))
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
$$;

-- Igual que antes, con los ítems de las solicitudes de cotización y de las cotizaciones.
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
    select l.line_no, null::uuid from public.journal_entry_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.payment_order_lines l where l.document_id = p_doc.id
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
    'sector_name', coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), '—'),
    'created_by_name', private.full_name(p_doc.created_by),
    'line_count', (select count(*) from lines),
    'summary', coalesce(
      (select je.description from public.journal_entries je where je.document_id = p_doc.id),
      case when p_doc.doc_type = 'PAYMENT_ORDER' then
        (select coalesce(array_to_string(i.list[1:3], ', '), '') || case when i.n > 3 then format(' y %s más', i.n - 3) else '' end
           from invoices i)
      end,
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

-- Igual que antes; adjudicar necesita alguna cotización vigente (availableActions).
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
  v_result jsonb := '[]';
begin
  select * into v_req from public.approval_requests a where a.document_id = p_doc.id and a.status = 'PENDIENTE';
  for v_tr in
    select * from public.document_transitions t
     where t.doc_type = p_doc.doc_type and t.from_status = p_doc.status and t.action <> 'SYSTEM'
     order by t.sort
  loop
    continue when v_tr.permission_code is null or not private.has_permission(p_doc.company_id, v_tr.permission_code);
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
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'action', v_tr.action, 'label', v_tr.label, 'help', v_tr.help_text, 'tone', v_tr.tone,
      'requires_comment', v_tr.requires_comment, 'enabled', v_reason is null, 'reason', v_reason));
  end loop;
  return v_result;
end;
$$;

-- Igual que antes, con la solicitud de cotización y la cotización (nextStep).
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

-- Solicitud de cotización: invitados, cuadro comparativo y adjudicación (rfqView).
create function private.rfq_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with quotes as (
    select q.* from private.rfq_quotes(p_doc.id) q
  ),
  awarded as (
    select q.id from quotes q where q.status = 'ADJUDICADA' order by q.number limit 1
  )
  select jsonb_build_object(
    'response_due', r.response_due,
    'award_reason', r.award_reason,
    'invited', coalesce((
      select jsonb_agg(jsonb_build_object(
               'supplier', jsonb_build_object('id', s.id, 'code', s.code, 'legal_name', s.legal_name),
               'quote', (select private.doc_ref(q.id) from quotes q where q.supplier_id = s.id order by q.number limit 1))
             order by s.code collate "C")
        from public.rfq_suppliers rs join public.suppliers s on s.id = rs.supplier_id
       where rs.document_id = p_doc.id), '[]'),
    'quotes', coalesce((
      select jsonb_agg(private.doc_ref(q.id) || jsonb_build_object(
               'supplier', jsonb_build_object('id', s.id, 'code', s.code, 'legal_name', s.legal_name,
                                              'vat_condition', s.vat_condition),
               'supplier_reference', sq.supplier_reference,
               'document_date', q.document_date,
               'valid_until', sq.valid_until,
               'expired', p_doc.status = 'ENVIADA' and q.status = 'RECIBIDA' and not private.quote_is_valid(q.id),
               'delivery_days', sq.delivery_days,
               'payment_terms_days', sq.payment_terms_days,
               'subtotal', q.subtotal,
               'tax_total', q.tax_total,
               'total', q.total,
               'quoted_lines', (select count(*) from public.supplier_quote_lines l where l.document_id = q.id),
               'complete', (select count(*) from public.supplier_quote_lines l where l.document_id = q.id)
                           = (select count(*) from public.rfq_lines i where i.document_id = p_doc.id),
               'prices', (
                 select jsonb_agg(case when l.id is null then 'null'::jsonb else jsonb_build_object(
                          'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal,
                          'lowest', l.unit_price = (
                            select min(x.unit_price) from public.supplier_quote_lines x
                              join quotes xq on xq.id = x.document_id
                             where x.rfq_line_id = i.id)) end
                          order by i.line_no)
                   from public.rfq_lines i
                   left join public.supplier_quote_lines l on l.rfq_line_id = i.id and l.document_id = q.id
                  where i.document_id = p_doc.id))
             order by q.number)
        from quotes q
        join public.supplier_quotes sq on sq.document_id = q.id
        join public.suppliers s on s.id = q.supplier_id), '[]'),
    'best_quote_id', case when p_doc.status = 'ENVIADA' then private.best_quote(p_doc.id) end,
    'awarded_quote_id', (select a.id from awarded a),
    'order', (select private.doc_ref(private.order_from_quote(a.id)) from awarded a))
    from public.rfqs r
   where r.document_id = p_doc.id
$$;

-- Cotización: su solicitud, sus condiciones y, si fue adjudicada, su OC (quoteView).
create function private.quote_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'rfq', private.doc_ref(q.rfq_id),
    'supplier_reference', q.supplier_reference,
    'valid_until', q.valid_until,
    'expired', r.status = 'ENVIADA' and p_doc.status = 'RECIBIDA' and not private.quote_is_valid(p_doc.id),
    'delivery_days', q.delivery_days,
    'payment_terms_days', q.payment_terms_days,
    'best', r.status = 'ENVIADA' and coalesce(private.best_quote(q.rfq_id) = p_doc.id, false),
    'order', case when p_doc.status = 'ADJUDICADA' then private.doc_ref(private.order_from_quote(p_doc.id)) end)
    from public.supplier_quotes q join public.documents r on r.id = q.rfq_id
   where q.document_id = p_doc.id
$$;

-- Igual que antes, con la solicitud de cotización y la cotización: sus ítems,
-- su lugar en el flujo, sus vistas y sus firmas.
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
    'supplier', (select to_jsonb(s) from public.suppliers s where s.id = p_doc.supplier_id),
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
                              'SUPPLIER_INVOICE', 'PAYMENT_ORDER', 'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;
