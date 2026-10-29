-- 67. Fase 7b.1 (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §3): ingresos brutos
-- simplificado. La factura de proveedor suma la percepción que cobró el proveedor y el recibo
-- de cobro, la retención que hizo el cliente (las dos van a Retenciones y percepciones
-- sufridas); la declaración mensual de ingresos brutos (DJ) aplica la alícuota de la empresa
-- sobre las ventas netas del mes y descuenta las percepciones y retenciones del mes y el saldo
-- a favor anterior; se presenta con el asiento IIBB y se paga con PAGO_IIBB. La alícuota la fija
-- el docente. Traducción de los cambios en src/lib/mock/engine.ts y en sus lecturas de queries.ts.
--
-- Las claves de imputación nuevas están en la migración de catálogos siguiente; las reglas y la
-- alícuota por defecto, en la de la plantilla; las empresas que ya existían reciben las reglas
-- en la última de esta fase.

-- ------------------------------------------------------------------ Tablas

alter table public.supplier_invoices
  add column perception numeric(14, 2) not null default 0 check (perception >= 0);   -- percepción de ingresos brutos
alter table public.customer_receipts
  add column retention numeric(14, 2) not null default 0 check (retention >= 0);     -- retención de ingresos brutos
-- En ingresos brutos, las ventas netas del mes y la alícuota de la empresa (en el IVA, sin valor).
alter table public.tax_returns
  add column base numeric(14, 2),
  add column rate numeric(5, 2) check (rate between 0 and 100);

-- ------------------------------------------------------------------ Auxiliares

-- Las percepciones y retenciones de ingresos brutos de un mes: las de los asientos registrados en
-- el mes que salen de una factura de proveedor o de un cobro, y las anuladas en el mes, que restan
-- (iibbCredits).
create function private.iibb_credits(p_company uuid, p_period text)
returns table (entry_date date, entry_number int, source_id uuid, sign int, amount numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select e.document_date, je.entry_number, src.id, case when je.reverses_id is null then 1 else -1 end,
         round(case when je.reverses_id is null then 1 else -1 end * coalesce(si.perception, rc.retention), 2)
    from public.journal_entries je
    join public.documents e on e.id = je.document_id
    join public.document_links k on k.to_document_id = coalesce(je.reverses_id, je.document_id)
    join public.documents src on src.id = k.from_document_id
    left join public.supplier_invoices si on si.document_id = src.id
    left join public.customer_receipts rc on rc.document_id = src.id
   where e.company_id = p_company and je.entry_number is not null and to_char(e.document_date, 'YYYY-MM') = p_period
     and coalesce(si.perception, rc.retention, 0) > 0
$$;

-- ------------------------------------------------------------------ Compras: la percepción

-- Igual que antes, y además la percepción de ingresos brutos que cobra el proveedor, que se
-- suma a lo que se le debe (cmdCreateSupplierInvoice).
-- p_input: {purchase_order_id, point_of_sale, invoice_number, document_date, notes, lines: [{po_line_id, quantity,
-- unit_price}], perception}
create or replace function public.si_create(p_company_id uuid, p_input jsonb, p_register boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'supplier_invoice.create');
  v_order public.documents;
  v_supplier public.suppliers;
  v_pos text := trim(coalesce(p_input ->> 'point_of_sale', ''));
  v_number text := trim(coalesce(p_input ->> 'invoice_number', ''));
  v_date date := private.parse_date(p_input ->> 'document_date');
  v_letter text;
  v_duplicate text;
  v_input_line jsonb;
  v_line public.purchase_order_lines;
  v_quantity numeric;
  v_price numeric;
  v_subtotal numeric;
  v_tax numeric;
  v_lines jsonb := '[]';
  v_perception numeric;
  v_doc public.documents;
begin
  select * into v_order from public.documents d
   where d.id::text = p_input ->> 'purchase_order_id' and d.company_id = p_company_id and d.doc_type = 'PURCHASE_ORDER';
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí la orden de compra que factura el proveedor.');
  end if;
  if v_order.status not in ('ENVIADO', 'RECIBIDO_PARCIAL', 'RECIBIDO', 'CERRADO') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s está en estado "%s": se factura una orden enviada al proveedor.', v_order.display_number,
             private.status_label(v_order.doc_type, v_order.status)));
  end if;
  select * into v_supplier from public.suppliers s where s.id = v_order.supplier_id;
  if v_pos !~ '^[0-9]{1,5}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El punto de venta tiene hasta 5 números (por ejemplo, 00003).');
  end if;
  if v_number !~ '^[0-9]{1,8}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El número de la factura tiene hasta 8 números (por ejemplo, 00004521).');
  end if;
  if v_date is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá la fecha de la factura.');
  end if;
  if v_date > private.business_date(p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de la factura no puede ser posterior a hoy.');
  end if;
  v_letter := case when v_supplier.vat_condition = 'RESPONSABLE_INSCRIPTO' then 'A' else 'C' end;
  v_pos := lpad(v_pos, 5, '0');
  v_number := lpad(v_number, 8, '0');
  select d.display_number into v_duplicate
    from public.documents d join public.supplier_invoices si on si.document_id = d.id
   where d.company_id = p_company_id and d.doc_type = 'SUPPLIER_INVOICE' and d.status <> 'ANULADA'
     and d.supplier_id = v_supplier.id and si.letter = v_letter and si.point_of_sale = v_pos and si.invoice_number = v_number
   limit 1;
  if v_duplicate is not null then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Ya está cargada la factura %s %s-%s de %s (%s).', v_letter, v_pos, v_number, v_supplier.legal_name, v_duplicate));
  end if;
  for v_input_line in
    select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]'::jsonb)) with ordinality as x (l, ord)
     where nullif(l ->> 'po_line_id', '') is not null and coalesce((l ->> 'quantity')::numeric, 0) <> 0
     order by ord
  loop
    select * into v_line from public.purchase_order_lines pl
     where pl.id::text = v_input_line ->> 'po_line_id' and pl.document_id = v_order.id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Una de las líneas no pertenece a la orden de compra.');
    end if;
    v_quantity := (v_input_line ->> 'quantity')::numeric;
    if v_quantity <= 0 or round(v_quantity, 3) <> v_quantity then
      perform private.raise_business_error('DATO_INVALIDO', 'Las cantidades deben ser mayores que cero y tener hasta 3 decimales.');
    end if;
    v_price := (v_input_line ->> 'unit_price')::numeric;
    if v_price is null or v_price < 0 or round(v_price, 4) <> v_price then
      perform private.raise_business_error('DATO_INVALIDO', 'Los precios deben ser positivos y tener hasta 4 decimales.');
    end if;
    perform private.assert_invoiceable(v_line.id, v_quantity);
    v_subtotal := round(v_quantity * v_price, 2);
    v_tax := case when v_letter = 'A' then round(v_subtotal * v_line.vat_rate / 100, 2) else 0 end;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'po_line_id', v_line.id, 'product_id', v_line.product_id, 'quantity', v_quantity, 'unit_price', v_price,
      'vat_rate', v_line.vat_rate, 'subtotal', v_subtotal, 'tax', v_tax));
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá qué cantidades factura el proveedor.');
  end if;
  v_perception := case when coalesce(jsonb_typeof(p_input -> 'perception'), 'null') = 'null' then 0
                       when jsonb_typeof(p_input -> 'perception') = 'number' then (p_input ->> 'perception')::numeric end;
  if v_perception is null or v_perception < 0 or round(v_perception, 2) <> v_perception or v_perception >= 1000000000 then
    perform private.raise_business_error('DATO_INVALIDO',
      'La percepción de ingresos brutos es un importe de cero o más, con hasta 2 decimales.');
  end if;

  v_doc := private.new_document(p_company_id, 'SUPPLIER_INVOICE', v_actor, v_supplier.id, trim(coalesce(p_input ->> 'notes', '')));
  update public.documents d set document_date = v_date where d.id = v_doc.id;
  insert into public.supplier_invoices (document_id, company_id, purchase_order_id, letter, point_of_sale, invoice_number, due_date,
                                        perception)
  values (v_doc.id, p_company_id, v_order.id, v_letter, v_pos, v_number,
          v_date + (select po.payment_terms_days from public.purchase_orders po where po.document_id = v_order.id),
          v_perception);
  insert into public.supplier_invoice_lines (company_id, document_id, line_no, po_line_id, product_id, quantity, unit_price,
                                             vat_rate, line_subtotal, line_tax, line_total)
  select p_company_id, v_doc.id, ord::int, (l ->> 'po_line_id')::uuid, (l ->> 'product_id')::uuid, (l ->> 'quantity')::numeric,
         (l ->> 'unit_price')::numeric, (l ->> 'vat_rate')::numeric, (l ->> 'subtotal')::numeric, (l ->> 'tax')::numeric,
         (l ->> 'subtotal')::numeric + (l ->> 'tax')::numeric
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord);
  update public.documents d
     set subtotal = t.subtotal, tax_total = t.tax, total = t.subtotal + t.tax + v_perception
    from (select sum(line_subtotal) as subtotal, sum(line_tax) as tax
            from public.supplier_invoice_lines where document_id = v_doc.id) as t
   where d.id = v_doc.id;
  perform private.link_documents(p_company_id, v_order.id, v_doc.id);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'supplier_invoice', v_doc.id, v_doc.display_number,
    format('Creó %s: factura %s %s-%s de %s contra %s', v_doc.display_number, v_letter, v_pos, v_number,
           v_supplier.legal_name, v_order.display_number), v_doc.id, null, 'BORRADOR');
  select * into v_doc from public.documents d where d.id = v_doc.id;
  if p_register then
    perform private.register_supplier_invoice(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

-- Igual que antes, y la percepción de ingresos brutos va a Retenciones y percepciones
-- sufridas (registerInvoice).
create or replace function private.register_supplier_invoice(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_si public.supplier_invoices;
  v_supplier public.suppliers;
  v_line public.supplier_invoice_lines;
  v_actor private.actor;
  v_amounts jsonb;
begin
  if not exists (
    select 1 from public.document_transitions t
     where t.doc_type = p_doc.doc_type and t.from_status = p_doc.status and t.action = 'CONFIRM'
  ) then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está en estado "%s" y no admite esta acción.', p_doc.display_number, private.status_label(p_doc.doc_type, p_doc.status)));
  end if;
  for v_line in select * from public.supplier_invoice_lines l where l.document_id = p_doc.id order by l.line_no loop
    perform private.assert_invoiceable(v_line.po_line_id, v_line.quantity, p_doc.id);
  end loop;
  select * into v_si from public.supplier_invoices si where si.document_id = p_doc.id;
  select * into v_supplier from public.suppliers s where s.id = p_doc.supplier_id;
  v_actor := private.transition_document(p_doc.id, 'CONFIRM', p_summary => format('Registró %s: factura %s %s-%s de %s por %s',
    p_doc.display_number, v_si.letter, v_si.point_of_sale, v_si.invoice_number, v_supplier.legal_name,
    private.format_money(p_doc.total)));
  update public.supplier_invoices set registered_at = now() where document_id = p_doc.id;
  select coalesce(jsonb_agg(jsonb_build_object('key', t.product_type, 'debit', t.amount, 'credit', 0) order by t.sort), '[]'::jsonb)
    into v_amounts
    from (
      select p.product_type,
             sum(case when v_si.letter = 'A' then l.line_subtotal else l.line_total end) as amount,
             array_position(array['MATERIA_PRIMA', 'INSUMO', 'PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO'],
                            p.product_type) as sort
        from public.supplier_invoice_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id
       group by p.product_type
    ) as t;
  v_amounts := v_amounts || jsonb_build_array(
    jsonb_build_object('key', 'IVA_CREDITO', 'debit', case when v_si.letter = 'A' then p_doc.tax_total else 0 end, 'credit', 0),
    jsonb_build_object('key', 'PERCEPCIONES', 'debit', v_si.perception, 'credit', 0),
    jsonb_build_object('key', 'PROVEEDORES', 'debit', 0, 'credit', p_doc.total));
  perform private.post_event(v_actor, p_doc, 'COMPRA',
    format('Compra según %s: factura %s %s-%s de %s.', p_doc.display_number, v_si.letter, v_si.point_of_sale,
           v_si.invoice_number, v_supplier.legal_name),
    v_amounts);
end;
$$;

-- ------------------------------------------------------------------ Cobros: la retención

-- Igual que antes, y además la retención de ingresos brutos que hace el cliente: tiene que
-- quedar algo de dinero (cmdCreateCustomerReceipt).
-- p_input: {customer_id, treasury_account_id, payment_method, reference, notes, lines: [{invoice_id, amount}],
-- retention}
create or replace function public.rc_create(p_company_id uuid, p_input jsonb, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'customer_receipt.create');
  v_customer public.customers;
  v_account public.accounts;
  v_method text := p_input ->> 'payment_method';
  v_ref text := trim(coalesce(p_input ->> 'reference', ''));
  v_line jsonb;
  v_invoice public.documents;
  v_amount numeric;
  v_pending numeric;
  v_committed numeric;
  v_available numeric;
  v_seen uuid[] := '{}';
  v_lines jsonb := '[]';
  v_number record;
  v_doc public.documents;
  v_total numeric;
  v_retention numeric;
begin
  select * into v_customer from public.customers c
   where c.id::text = p_input ->> 'customer_id' and c.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el cliente que paga.');
  end if;
  v_account := private.receipt_account(p_company_id, p_input ->> 'treasury_account_id');
  if v_method is null or v_method not in ('TRANSFERENCIA', 'CHEQUE', 'EFECTIVO') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el medio de cobro: transferencia, cheque o efectivo.');
  end if;
  if length(v_ref) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'La referencia del cobro tiene hasta 60 caracteres.');
  end if;
  if v_method = 'CHEQUE' and v_ref !~ '^\d{1,8}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá el número del cheque del cliente (hasta 8 números).',
      'Los cheques de terceros quedan en Valores a depositar hasta que se depositan en el banco.');
  end if;
  for v_line in
    select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]'::jsonb)) with ordinality as x (l, ord)
     where nullif(l ->> 'invoice_id', '') is not null and coalesce((l ->> 'amount')::numeric, 0) <> 0
     order by ord
  loop
    select * into v_invoice from public.documents d
     where d.id::text = v_line ->> 'invoice_id' and d.company_id = p_company_id and d.doc_type = 'SALES_INVOICE';
    if not found or v_invoice.customer_id is distinct from v_customer.id then
      perform private.raise_business_error('DATO_INVALIDO', format('Una de las facturas no es de %s.', v_customer.legal_name));
    end if;
    if v_invoice.id = any (v_seen) then
      perform private.raise_business_error('DATO_INVALIDO', format('%s está dos veces en el recibo.', v_invoice.display_number));
    end if;
    v_seen := v_seen || v_invoice.id;
    if v_invoice.status not in ('REGISTRADA', 'COBRADA_PARCIAL') then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s está en estado "%s": se cobran facturas registradas con saldo.', v_invoice.display_number,
               private.status_label(v_invoice.doc_type, v_invoice.status)));
    end if;
    v_amount := (v_line ->> 'amount')::numeric;
    if v_amount <= 0 or round(v_amount, 2) <> v_amount then
      perform private.raise_business_error('DATO_INVALIDO', 'Los importes deben ser mayores que cero y tener hasta 2 decimales.');
    end if;
    v_pending := private.sales_invoice_pending(v_invoice.id);
    v_committed := private.sales_invoice_committed(v_invoice.id);
    v_available := round(v_pending - v_committed, 2);
    if v_amount > v_available + 0.000000001 then
      perform private.raise_business_error('IMPORTE_EXCEDIDO',
        format('%s: el saldo es %s%s; como mucho se pueden cobrar %s.', v_invoice.display_number, private.format_money(v_pending),
               case when v_committed > 0
                 then format(' y ya hay %s en otros recibos en borrador', private.format_money(v_committed)) else '' end,
               private.format_money(greatest(v_available, 0))),
        'Una factura no se cobra dos veces: lo que está en un recibo en borrador queda reservado.');
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('invoice_id', v_invoice.id, 'amount', v_amount));
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá qué facturas se cobran y cuánto de cada una.');
  end if;
  select round(sum((l ->> 'amount')::numeric), 2) into v_total from jsonb_array_elements(v_lines) as l;
  v_retention := case when coalesce(jsonb_typeof(p_input -> 'retention'), 'null') = 'null' then 0
                      when jsonb_typeof(p_input -> 'retention') = 'number' then (p_input ->> 'retention')::numeric end;
  if v_retention is null or v_retention < 0 or round(v_retention, 2) <> v_retention then
    perform private.raise_business_error('DATO_INVALIDO',
      'La retención de ingresos brutos es un importe de cero o más, con hasta 2 decimales.');
  end if;
  if v_retention > 0 and v_retention >= v_total then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La retención (%s) tiene que ser menor que lo que se cobra (%s): el resto ingresa a la caja o el banco.',
             private.format_money(v_retention), private.format_money(v_total)));
  end if;

  select * into v_number from private.next_document_number(p_company_id, 'CUSTOMER_RECEIPT');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, customer_id, notes, created_by)
  values (p_company_id, 'CUSTOMER_RECEIPT', v_number.number, v_number.display_number, 'BORRADOR', private.business_date(p_company_id),
          (v_actor).sector_id, v_customer.id, trim(coalesce(p_input ->> 'notes', '')), (v_actor).user_id)
  returning * into v_doc;
  insert into public.customer_receipts (document_id, company_id, treasury_account_id, payment_method, reference, retention)
  values (v_doc.id, p_company_id, v_account.id, v_method, v_ref, v_retention);
  insert into public.customer_receipt_lines (company_id, document_id, line_no, invoice_id, amount)
  select p_company_id, v_doc.id, ord::int, (l ->> 'invoice_id')::uuid, (l ->> 'amount')::numeric
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord);
  select sum(l.amount) into v_total from public.customer_receipt_lines l where l.document_id = v_doc.id;
  update public.documents d set subtotal = v_total, total = v_total where d.id = v_doc.id
  returning d.* into v_doc;
  perform private.link_documents(p_company_id, (l ->> 'invoice_id')::uuid, v_doc.id) from jsonb_array_elements(v_lines) as l;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'customer_receipt', v_doc.id, v_doc.display_number,
    format('Creó %s: cobro a %s por %s %s en %s %s', v_doc.display_number, v_customer.legal_name,
           private.format_money(v_total), private.payment_via(v_method), v_account.code, v_account.name)
      || case when v_retention > 0 then format(', con una retención de ingresos brutos de %s', private.format_money(v_retention)) else '' end,
    v_doc.id, null, 'BORRADOR');
  if p_confirm then
    perform private.confirm_customer_receipt(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

-- Igual que antes, y la retención de ingresos brutos va a Retenciones y percepciones sufridas:
-- a la caja o el banco entra el resto (confirmCustomerReceipt).
create or replace function private.confirm_customer_receipt(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sod boolean := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = p_doc.company_id), true);
  v_supervisor boolean := private.is_supervisor(p_doc.company_id);
  v_line public.customer_receipt_lines;
  v_invoice public.documents;
  v_pending numeric;
  v_rc public.customer_receipts;
  v_account public.accounts;
  v_customer public.customers;
  v_number text;
  v_actor private.actor;
  v_doc public.documents;
begin
  perform private.require_transition(p_doc, 'CONFIRM');
  for v_line in select * from public.customer_receipt_lines l where l.document_id = p_doc.id order by l.line_no loop
    if v_sod and not v_supervisor and private.invoice_registrant(v_line.invoice_id) = (select auth.uid()) then
      perform private.raise_business_error('SEPARACION_FUNCIONES',
        format('No podés cobrar %s: la emitiste vos.', (select d.display_number from public.documents d where d.id = v_line.invoice_id)),
        'Separación de funciones: quien emite una factura no registra su cobro. Tiene que cobrarla otro integrante de Tesorería.');
    end if;
  end loop;
  for v_line in select * from public.customer_receipt_lines l where l.document_id = p_doc.id order by l.line_no loop
    select * into v_invoice from public.documents d where d.id = v_line.invoice_id;
    v_pending := private.sales_invoice_pending(v_invoice.id);
    if v_invoice.status not in ('REGISTRADA', 'COBRADA_PARCIAL') or v_line.amount > v_pending + 0.000000001 then
      perform private.raise_business_error('IMPORTE_EXCEDIDO',
        format('%s: el saldo pendiente es %s y el recibo cobra %s.', v_invoice.display_number,
               private.format_money(greatest(v_pending, 0)), private.format_money(v_line.amount)));
    end if;
  end loop;
  select * into v_rc from public.customer_receipts x where x.document_id = p_doc.id;
  v_account := private.receipt_account(p_doc.company_id, v_rc.treasury_account_id::text);
  select * into v_customer from public.customers c where c.id = p_doc.customer_id;
  v_number := case when v_rc.reference <> '' then ' N.º ' || v_rc.reference else '' end;
  v_actor := private.transition_document(p_doc.id, 'CONFIRM',
    p_summary => format('Confirmó %s: cobró %s a %s %s%s en %s %s', p_doc.display_number, private.format_money(p_doc.total),
                        v_customer.legal_name, private.payment_via(v_rc.payment_method), v_number, v_account.code, v_account.name)
                 || case when v_rc.retention > 0 then format(', con una retención de ingresos brutos de %s', private.format_money(v_rc.retention)) else '' end);
  update public.customer_receipts set received_on = private.business_date(p_doc.company_id) where document_id = p_doc.id;
  select * into v_doc from public.documents d where d.id = p_doc.id;
  perform private.post_event(v_actor, v_doc, 'COBRO',
    format('Cobro a %s según %s (%s%s).', v_customer.legal_name, v_doc.display_number,
           private.payment_via(v_rc.payment_method, true), v_number),
    jsonb_build_array(
      jsonb_build_object('account_id', v_account.id, 'debit', v_doc.total - v_rc.retention, 'credit', 0),
      jsonb_build_object('key', 'RETENCIONES', 'debit', v_rc.retention, 'credit', 0),
      jsonb_build_object('key', 'DEUDORES', 'debit', 0, 'credit', v_doc.total)));
  for v_line in select * from public.customer_receipt_lines l where l.document_id = p_doc.id order by l.line_no loop
    perform private.recompute_sales_invoice(v_line.invoice_id);
  end loop;
end;
$$;

-- Igual que antes; con retención, alcanza con que esté en la caja o el banco el dinero que
-- ingresó (cmdCancelCustomerReceipt).
create or replace function public.rc_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
  v_account public.accounts;
  v_balance numeric;
  v_cash numeric;
  v_entry public.documents;
  v_reversal public.documents;
  v_line public.customer_receipt_lines;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'CUSTOMER_RECEIPT');
  if v_doc.status <> 'CONFIRMADO' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'customer_receipt.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  select a.* into v_account from public.customer_receipts x join public.accounts a on a.id = x.treasury_account_id
   where x.document_id = v_doc.id;
  v_balance := private.account_balance(v_account.id);
  select v_doc.total - x.retention into v_cash from public.customer_receipts x where x.document_id = v_doc.id;
  if v_cash > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No se puede anular: en %s %s hay %s y el cobro ingresó %s.', v_account.code, v_account.name,
             private.format_money(v_balance), private.format_money(v_cash)),
      'El dinero ya salió de esa cuenta (por ejemplo, se depositó en el banco): primero hay que anular ese movimiento.');
  end if;
  v_entry := private.automatic_entry_of(v_doc.id);
  if v_entry.id is not null then
    v_reversal := private.reverse_journal_entry(v_entry, v_actor, format('%s anulado: %s', v_doc.display_number, v_comment), true);
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', v_comment, p_actor => v_actor,
    p_summary => format('Anuló %s%s — %s', v_doc.display_number,
                        case when v_reversal.id is not null then ' y su cobro con el contraasiento ' || v_reversal.display_number else '' end,
                        v_comment));
  for v_line in select * from public.customer_receipt_lines l where l.document_id = v_doc.id order by l.line_no loop
    perform private.recompute_sales_invoice(v_line.invoice_id);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ Declaraciones: ingresos brutos

-- Igual que antes, y además la de ingresos brutos: la alícuota de la empresa sobre las ventas
-- netas del mes (el neto gravado y lo exento del libro IVA ventas) menos las percepciones y
-- retenciones del mes (cmdCreateTaxReturn). p_input: {tax, period, notes}
create or replace function public.tax_return_create(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'tax_return.create');
  v_company public.companies;
  v_tax text := coalesce(p_input ->> 'tax', '');
  v_period text := coalesce(p_input ->> 'period', '');
  v_notes text := trim(coalesce(p_input ->> 'notes', ''));
  v_month text;
  v_name text;
  v_same public.documents;
  v_last public.documents;
  v_last_period text;
  v_last_balance numeric;
  v_debit numeric;
  v_credit numeric;
  v_previous numeric;
  v_result numeric;
  v_base numeric;
  v_rate numeric;
  v_doc public.documents;
begin
  select * into v_company from public.companies c where c.id = p_company_id;
  if v_tax not in ('IVA', 'IIBB') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el impuesto: IVA o ingresos brutos.');
  end if;
  if v_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  v_month := private.period_label(v_period);
  if v_period >= to_char(private.business_date(p_company_id), 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s todavía no terminó: la declaración se prepara después de que termine el mes.', v_month));
  end if;
  if v_period < to_char(v_company.start_date, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La empresa empezó sus actividades el %s: no hay declaraciones antes.', to_char(v_company.start_date, 'DD/MM/YYYY')));
  end if;
  v_name := private.tax_name(v_tax);
  select d.* into v_same
    from public.documents d join public.tax_returns t on t.document_id = d.id
   where d.company_id = p_company_id and d.status <> 'ANULADA' and t.tax = v_tax and t.period = v_period;
  if v_same.id is not null then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Ya hay una declaración de %s de %s: %s.', v_name, v_month, v_same.display_number));
  end if;
  select d.* into v_last
    from public.documents d join public.tax_returns t on t.document_id = d.id
   where d.company_id = p_company_id and d.status <> 'ANULADA' and t.tax = v_tax
   order by t.period desc
   limit 1;
  select t.period, t.balance_in_favor into v_last_period, v_last_balance
    from public.tax_returns t where t.document_id = v_last.id;
  if v_last.id is not null and v_period < v_last_period then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La última declaración de %s es la de %s (%s): no se vuelve a un mes anterior.', v_name,
             private.period_label(v_last_period), v_last.display_number));
  end if;
  if v_last.id is not null and private.previous_period(v_period) <> v_last_period then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Falta la declaración de %s de %s: los meses van en orden.', v_name,
             private.period_label(private.previous_period(v_period))));
  end if;
  if v_last.status = 'BORRADOR' then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Primero hay que presentar %s (%s de %s).', v_last.display_number, v_name, private.period_label(v_last_period)));
  end if;
  if length(v_notes) > 500 then
    perform private.raise_business_error('DATO_INVALIDO', 'Las observaciones tienen hasta 500 caracteres.');
  end if;
  if v_tax = 'IVA' then
    v_debit := private.iva_book_vat(p_company_id, v_period, true);
    v_credit := private.iva_book_vat(p_company_id, v_period, false);
  else
    -- Si en el mes se anuló más de lo que se vendió, la base es cero (a validar).
    select greatest(coalesce(round(sum(e.net + e.exempt), 2), 0), 0) into v_base
      from private.iva_book_entries(p_company_id, v_period, true) e;
    v_rate := coalesce((v_company.settings ->> 'iibb_pct')::numeric, private.iibb_default_pct());
    v_debit := round(v_base * v_rate / 100, 2);
    select coalesce(round(sum(c.amount), 2), 0) into v_credit from private.iibb_credits(p_company_id, v_period) c;
  end if;
  v_previous := coalesce(v_last_balance, 0);
  v_result := round(v_debit - v_credit - v_previous, 2);
  v_doc := private.new_document(p_company_id, 'TAX_RETURN', v_actor, null, v_notes);
  insert into public.tax_returns (document_id, company_id, tax, period, due_date, tax_amount, credits, previous_balance,
                                  balance_in_favor, base, rate)
  values (v_doc.id, p_company_id, v_tax, v_period,
          private.next_month_day(v_period, case when v_tax = 'IVA' then 20 else 15 end),
          v_debit, v_credit, v_previous, greatest(-v_result, 0), v_base, v_rate);
  update public.documents set subtotal = v_debit, total = greatest(v_result, 0) where id = v_doc.id;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'tax_return', v_doc.id, v_doc.display_number,
    format('Creó %s: %s de %s, %s', v_doc.display_number, v_name, v_month,
           case when v_result > 0 then format('%s a pagar', private.format_money(v_result))
                else format('saldo a favor de %s', private.format_money(-v_result)) end),
    v_doc.id, null, 'BORRADOR');
  perform private.open_tasks_for_status(v_doc.id, v_actor);
  return private.created_result(v_doc.id);
end;
$$;

-- Igual que antes, y en ingresos brutos el asiento IIBB: el impuesto al debe; las percepciones
-- y retenciones que se usan (hasta el impuesto) y el saldo a pagar al haber (cmdPresentTaxReturn).
create or replace function public.tax_return_present(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_t public.tax_returns;
  v_month text;
  v_used numeric;
  v_previous text;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'TAX_RETURN');
  perform private.require_transition(v_doc, 'CONFIRM');
  perform private.require_permission(v_doc.company_id, 'tax_return.create');
  select * into v_t from public.tax_returns t where t.document_id = v_doc.id;
  v_month := private.period_label(v_t.period);
  v_actor := private.transition_document(v_doc.id, 'CONFIRM',
    p_to => case when v_doc.total > 0 then 'PRESENTADA' else 'SIN_SALDO' end,
    p_summary => format('Presentó %s: %s de %s, %s', v_doc.display_number, private.tax_name(v_t.tax), v_month,
                        case when v_doc.total > 0 then format('%s a pagar', private.format_money(v_doc.total))
                             else 'sin saldo a pagar' end));
  update public.tax_returns set presented_at = now() where document_id = v_doc.id;
  if not v_t.tax_amount > 0 then
    return;
  end if;
  v_used := least(v_t.tax_amount, round(v_t.credits + v_t.previous_balance, 2));
  v_previous := case when v_t.previous_balance <> 0
    then format(' y saldo a favor anterior %s', private.format_money(v_t.previous_balance)) else '' end;
  if v_t.tax = 'IVA' then
    perform private.post_event(v_actor, v_doc, 'IVA',
      format('IVA de %s (%s): débito fiscal %s, crédito fiscal %s%s.', v_month, v_doc.display_number,
             private.format_money(v_t.tax_amount), private.format_money(v_t.credits), v_previous),
      jsonb_build_array(
        jsonb_build_object('key', 'IVA_DEBITO', 'debit', v_t.tax_amount, 'credit', 0),
        jsonb_build_object('key', 'IVA_CREDITO', 'debit', 0, 'credit', v_used),
        jsonb_build_object('key', 'IVA_A_PAGAR', 'debit', 0, 'credit', v_doc.total)));
  else
    perform private.post_event(v_actor, v_doc, 'IIBB',
      format('Ingresos brutos de %s (%s): impuesto %s, percepciones y retenciones %s%s.', v_month, v_doc.display_number,
             private.format_money(v_t.tax_amount), private.format_money(v_t.credits), v_previous),
      jsonb_build_array(
        jsonb_build_object('key', 'IMPUESTO', 'debit', v_t.tax_amount, 'credit', 0),
        jsonb_build_object('key', 'RETENCIONES', 'debit', 0, 'credit', v_used),
        jsonb_build_object('key', 'IIBB_A_PAGAR', 'debit', 0, 'credit', v_doc.total)));
  end if;
end;
$$;

-- Igual que antes, y el pago de ingresos brutos con su asiento PAGO_IIBB (cmdPayTaxReturn).
create or replace function public.tax_return_pay(p_document_id uuid, p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_t public.tax_returns;
  v_account public.accounts;
  v_balance numeric;
  v_month text;
  v_name text;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'TAX_RETURN');
  perform private.require_transition(v_doc, 'PAY');
  v_actor := private.require_permission(v_doc.company_id, 'tax_return.pay');
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and not private.is_supervisor(v_doc.company_id)
     and (select auth.uid()) = any (private.tax_return_preparers(v_doc)) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés pagar %s: la liquidaste vos.', v_doc.display_number),
      'Separación de funciones: quien liquida un impuesto no lo paga. Tiene que pagarlo otro integrante de Tesorería.');
  end if;
  v_account := private.treasury_account(v_doc.company_id, p_account_id::text);
  v_balance := private.account_balance(v_account.id);
  select * into v_t from public.tax_returns t where t.document_id = v_doc.id;
  v_month := private.period_label(v_t.period);
  v_name := private.tax_name(v_t.tax);
  if v_doc.total > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No alcanza el saldo de %s %s: hay %s y %s de %s es %s.', v_account.code, v_account.name,
             private.format_money(v_balance),
             case when v_t.tax = 'IVA' then 'el IVA' else 'el impuesto sobre los ingresos brutos' end, v_month,
             private.format_money(v_doc.total)),
      'Antes de pagar hay que controlar que haya fondos: el flujo de fondos proyectado lo anticipa.');
  end if;
  perform private.transition_document(v_doc.id, 'PAY', p_actor => v_actor,
    p_summary => format('Pagó %s: %s de %s, %s desde %s %s', v_doc.display_number, v_name, v_month,
                        private.format_money(v_doc.total), v_account.code, v_account.name));
  update public.tax_returns
     set paid_on = private.business_date(v_doc.company_id), paid_account_id = v_account.id
   where document_id = v_doc.id;
  select * into v_doc from public.documents d where d.id = v_doc.id;
  perform private.post_event(v_actor, v_doc, case when v_t.tax = 'IVA' then 'PAGO_IVA' else 'PAGO_IIBB' end,
    format('Pago %s de %s (%s).', case when v_t.tax = 'IVA' then 'del IVA' else 'de ingresos brutos' end, v_month,
           v_doc.display_number),
    jsonb_build_array(
      jsonb_build_object('key', case when v_t.tax = 'IVA' then 'IVA_A_PAGAR' else 'IIBB_A_PAGAR' end,
                         'debit', v_doc.total, 'credit', 0),
      jsonb_build_object('account_id', v_account.id, 'debit', 0, 'credit', v_doc.total)));
end;
$$;

-- ------------------------------------------------------------------ Configuración de la empresa

-- Igual que antes, y además la alícuota de ingresos brutos, que se valida (de 0 a 100, con
-- hasta 2 decimales) (cmdUpdateCompanySettings).
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
  update public.companies set settings = v_after where id = p_company_id;
  perform private.log_audit(p_company_id, v_actor, 'SETTINGS', 'company', p_company_id,
    (select c.legal_name from public.companies c where c.id = p_company_id),
    case when jsonb_typeof(p_settings -> 'payroll') = 'object'
      then 'Cambió los porcentajes de la liquidación de sueldos'
      when p_settings ? 'iibb_pct' then 'Cambió la alícuota de ingresos brutos'
      else 'Cambió la configuración de control interno de la empresa' end,
    null, null, null,
    private.diff(v_before, v_after, array['sod_enabled', 'allow_negative_stock', 'payroll', 'iibb_pct']));
end;
$$;

-- ------------------------------------------------------------------ Lecturas

-- Igual que antes, y además, en ingresos brutos, la base, la alícuota y las percepciones y
-- retenciones del mes, cada una con su comprobante (taxReturnView).
create or replace function private.tax_return_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tax', t.tax, 'period', t.period, 'due_date', t.due_date, 'tax_amount', t.tax_amount, 'credits', t.credits,
    'previous_balance', t.previous_balance, 'amount_due', p_doc.total, 'balance_in_favor', t.balance_in_favor,
    'presented_at', t.presented_at, 'paid_on', t.paid_on,
    'paid_account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name)
                       from public.accounts a where a.id = t.paid_account_id),
    'base', t.base, 'rate', t.rate,
    'withholdings', case when t.tax = 'IIBB' then coalesce((
      select jsonb_agg(jsonb_build_object(
               'entry_date', c.entry_date, 'sign', c.sign,
               'source', jsonb_build_object('id', s.id, 'doc_type', s.doc_type, 'display_number', s.display_number,
                                            'path', private.doc_path(s.id)),
               'kind', case when s.doc_type = 'SUPPLIER_INVOICE' then 'PERCEPCION' else 'RETENCION' end,
               'voucher', case when s.doc_type = 'SUPPLIER_INVOICE'
                            then (select si.letter || ' ' || si.point_of_sale || '-' || si.invoice_number
                                    from public.supplier_invoices si where si.document_id = s.id)
                            else s.display_number end,
               'counterparty', case when s.doc_type = 'SUPPLIER_INVOICE'
                                 then (select x.legal_name from public.suppliers x where x.id = s.supplier_id)
                                 else (select x.legal_name from public.customers x where x.id = s.customer_id) end,
               'amount', c.amount)
             order by c.entry_date, c.entry_number)
        from private.iibb_credits(p_doc.company_id, t.period) c join public.documents s on s.id = c.source_id), '[]')
      else '[]' end)
    from public.tax_returns t
   where t.document_id = p_doc.id
$$;

-- Igual que antes, y además, en las compras, la percepción de ingresos brutos de cada factura
-- (ivaBook).
create or replace function public.iva_book(p_company_id uuid, p_period text, p_sales boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sales boolean := coalesce(p_sales, true);
begin
  perform private.require_read(p_company_id, 'tax_return.read');
  if coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  return (
    with e as (select * from private.iva_book_entries(p_company_id, p_period, v_sales)),
    rates as (
      -- Neto e IVA de cada factura por alícuota (con su signo), sólo lo gravado con crédito fiscal.
      select x.invoice_id, x.sign, x.entry_date, x.entry_number, l.vat_rate as rate,
             round(x.sign * sum(l.line_subtotal), 2) as net, round(x.sign * sum(l.line_tax), 2) as vat
        from e x
        join (
          select l.document_id, l.vat_rate, l.line_subtotal, l.line_tax
            from public.sales_invoice_lines l where v_sales
          union all
          select l.document_id, l.vat_rate, l.line_subtotal, l.line_tax
            from public.supplier_invoice_lines l join public.supplier_invoices s on s.document_id = l.document_id
           where not v_sales and s.letter = 'A'
        ) as l on l.document_id = x.invoice_id
       where l.vat_rate > 0
       group by x.invoice_id, x.sign, x.entry_date, x.entry_number, l.vat_rate
    )
    select jsonb_build_object(
      'period', p_period,
      'sales', v_sales,
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'entry_date', x.entry_date, 'sign', x.sign,
                 'invoice', jsonb_build_object('id', d.id, 'display_number', d.display_number,
                                               'path', private.doc_path(d.id), 'document_date', d.document_date),
                 'voucher', x.voucher,
                 'counterparty', case when v_sales
                   then (select jsonb_build_object('name', c.legal_name, 'tax_id', c.tax_id, 'vat_condition', c.vat_condition)
                           from public.customers c where c.id = d.customer_id)
                   else (select jsonb_build_object('name', s.legal_name, 'tax_id', s.tax_id, 'vat_condition', s.vat_condition)
                           from public.suppliers s where s.id = d.supplier_id) end,
                 'net', x.net, 'vat', x.vat, 'exempt', x.exempt, 'no_credit', x.no_credit,
                 'perception', case when v_sales then 0
                                    else round(x.sign * (select s.perception from public.supplier_invoices s
                                                          where s.document_id = x.invoice_id), 2) end,
                 'total', x.total)
               order by x.entry_date, x.entry_number)
          from e x join public.documents d on d.id = x.invoice_id), '[]'),
      'by_rate', coalesce((
        select jsonb_agg(jsonb_build_object('rate', r.rate, 'net', r.net, 'vat', r.vat) order by r.rate desc)
          from (select r.rate, round(sum(r.net), 2) as net, round(sum(r.vat), 2) as vat from rates r group by r.rate) as r
      ), '[]'),
      'net', (select coalesce(round(sum(x.net), 2), 0) from e x),
      'vat', (select coalesce(round(sum(x.vat), 2), 0) from e x),
      'exempt', (select coalesce(round(sum(x.exempt), 2), 0) from e x),
      'no_credit', (select coalesce(round(sum(x.no_credit), 2), 0) from e x),
      'perception', (select coalesce(round(sum(case when v_sales then 0 else x.sign * s.perception end), 2), 0)
                       from e x left join public.supplier_invoices s on s.document_id = x.invoice_id),
      'total', (select coalesce(round(sum(x.total), 2), 0) from e x))
  );
end;
$$;

-- ------------------------------------------------------------------ Lecturas comunes

-- Igual que antes, y además la percepción de la factura de proveedor, la retención del recibo
-- de cobro y la base y la alícuota de la declaración de ingresos brutos (document_json).
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
$$;

-- Igual que antes, y la declaración de ingresos brutos se revisa con las ventas y las percepciones
-- y retenciones del mes (nextStep).
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
      return jsonb_build_object('who', '—',
        'text', 'La mercadería salió: bajó el stock (ver kardex), el costo de lo vendido está en el libro diario y Ventas fue notificada.');
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
