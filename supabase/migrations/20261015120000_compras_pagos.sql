-- 18. Fase 3a (docs/FASE_3_COMPRAS_Y_TESORERIA.md): imputación automática,
-- factura de proveedor y cuenta corriente de proveedores. Traducción de las
-- secciones "Imputación automática" y "Facturas de proveedor" de
-- src/lib/mock/engine.ts y de sus lecturas en queries.ts, con los mismos
-- mensajes y la misma forma de datos (las pruebas de paridad lo comparan).
--
-- Los datos de las claves de imputación están en la migración de catálogos
-- siguiente y las reglas base, en la de la plantilla (private.insert_base_posting_rules).

-- ------------------------------------------------------------------ Tablas

-- Catálogo: eventos que se imputan solos y sus importes (POSTING_EVENTS).
create table public.posting_keys (
  event text not null,
  key text not null,
  event_label text not null,
  key_label text not null,
  sort int not null default 0,
  primary key (event, key)
);

-- Por empresa: a qué cuenta va cada importe de cada evento.
create table public.posting_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  event text not null,
  key text not null,
  account_id uuid not null,
  unique (company_id, event, key),
  unique (company_id, id),
  foreign key (event, key) references public.posting_keys (event, key),
  foreign key (company_id, account_id) references public.accounts (company_id, id)
);

-- Factura de proveedor: 1 a 1 con documents (tipo SUPPLIER_INVOICE).
create table public.supplier_invoices (
  document_id uuid primary key,
  doc_type text not null default 'SUPPLIER_INVOICE' check (doc_type = 'SUPPLIER_INVOICE'),
  company_id uuid not null,
  purchase_order_id uuid not null,
  letter text not null check (letter in ('A', 'C')), -- A: responsable inscripto (IVA discriminado)
  point_of_sale text not null check (point_of_sale ~ '^[0-9]{5}$'),
  invoice_number text not null check (invoice_number ~ '^[0-9]{8}$'),
  due_date date not null,
  registered_at timestamptz,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, purchase_order_id) references public.purchase_orders (company_id, document_id)
);
create index supplier_invoices_order_idx on public.supplier_invoices (purchase_order_id);

create table public.supplier_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  po_line_id uuid not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_price numeric(14, 4) not null check (unit_price >= 0),
  vat_rate numeric(5, 2) not null,
  line_subtotal numeric(14, 2) not null,
  line_tax numeric(14, 2) not null,
  line_total numeric(14, 2) not null,
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.supplier_invoices (company_id, document_id) on delete cascade,
  foreign key (company_id, po_line_id) references public.purchase_order_lines (company_id, id),
  foreign key (company_id, product_id) references public.products (company_id, id)
);
create index supplier_invoice_lines_po_line_idx on public.supplier_invoice_lines (po_line_id);

alter table public.posting_keys enable row level security;
revoke all on table public.posting_keys from anon, authenticated;
grant select on table public.posting_keys to authenticated;
create policy posting_keys_select on public.posting_keys for select to authenticated using (true);

do $$
declare
  t text;
begin
  foreach t in array array['posting_rules', 'supplier_invoices', 'supplier_invoice_lines'] loop
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

create policy posting_rules_select on public.posting_rules for select to authenticated
  using (company_id in (select private.companies_with_permission('posting_rule.read')));
create policy supplier_invoices_select on public.supplier_invoices for select to authenticated
  using (company_id in (select private.companies_with_permission('supplier_invoice.read')));
create policy supplier_invoice_lines_select on public.supplier_invoice_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('supplier_invoice.read')));

-- ------------------------------------------------------------------ Imputación automática

-- "Compra (factura de proveedor registrada): materias primas compradas" (postingLabel).
create function private.posting_label(p_event text, p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select k.event_label from public.posting_keys k where k.event = p_event limit 1), p_event)
         || ': ' || coalesce((select lower(k.key_label) from public.posting_keys k where k.event = p_event and k.key = p_key), p_key)
$$;

-- Cuenta de una regla, que tiene que existir y admitir movimientos (ruleAccount).
create function private.rule_account(p_company uuid, p_event text, p_key text)
returns public.accounts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account public.accounts;
begin
  select a.* into v_account
    from public.posting_rules r join public.accounts a on a.id = r.account_id
   where r.company_id = p_company and r.event = p_event and r.key = p_key;
  if not found then
    perform private.raise_business_error('FALTA_IMPUTACION',
      format('Falta definir la cuenta de "%s" en la imputación automática.', private.posting_label(p_event, p_key)),
      'Contabilidad la define en Contabilidad → Imputación automática.');
  end if;
  if not v_account.is_active or not v_account.is_imputable then
    perform private.raise_business_error('FALTA_IMPUTACION',
      format('La cuenta %s %s de "%s" no admite movimientos.', v_account.code, v_account.name,
             private.posting_label(p_event, p_key)),
      'Contabilidad la corrige en Contabilidad → Imputación automática.');
  end if;
  return v_account;
end;
$$;

-- Asiento automático de un evento (postEvent): cada importe a la cuenta de su
-- regla (los de la misma cuenta y el mismo lado se suman), con fecha de hoy,
-- registrado con las validaciones de siempre y vinculado al documento de origen.
-- p_amounts: [{key, debit, credit}]
create function private.post_event(
  p_actor private.actor,
  p_source public.documents,
  p_event text,
  p_description text,
  p_amounts jsonb
)
returns public.documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount jsonb;
  v_debit numeric;
  v_credit numeric;
  v_account public.accounts;
  v_accounts uuid[] := '{}';
  v_debits numeric[] := '{}';
  v_credits numeric[] := '{}';
  v_found int;
  v_i int;
  v_lines jsonb := '[]';
  v_entry public.documents;
begin
  for v_amount in select * from jsonb_array_elements(p_amounts) loop
    v_debit := round(coalesce((v_amount ->> 'debit')::numeric, 0), 2);
    v_credit := round(coalesce((v_amount ->> 'credit')::numeric, 0), 2);
    continue when v_debit = 0 and v_credit = 0;
    v_account := private.rule_account(p_source.company_id, p_event, v_amount ->> 'key');
    v_found := null;
    for v_i in 1 .. coalesce(array_length(v_accounts, 1), 0) loop
      if v_accounts[v_i] = v_account.id and (v_debits[v_i] > 0) = (v_debit > 0) then
        v_found := v_i;
        exit;
      end if;
    end loop;
    if v_found is null then
      v_accounts := v_accounts || v_account.id;
      v_debits := v_debits || v_debit;
      v_credits := v_credits || v_credit;
    else
      v_debits[v_found] := v_debits[v_found] + v_debit;
      v_credits[v_found] := v_credits[v_found] + v_credit;
    end if;
  end loop;
  for v_i in 1 .. coalesce(array_length(v_accounts, 1), 0) loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts[v_i], 'debit', v_debits[v_i], 'credit', v_credits[v_i], 'notes', ''));
  end loop;
  v_entry := private.new_journal_entry(p_source.company_id, p_actor, private.business_date(p_source.company_id),
    p_description, 'AUTOMATICO', null, v_lines);
  perform private.post_journal_entry(v_entry, p_actor,
    format('Registró %s, asiento automático N.º {n} de %s', v_entry.display_number, p_source.display_number));
  perform private.link_documents(p_source.company_id, p_source.id, v_entry.id);
  return v_entry;
end;
$$;

-- El asiento automático vigente de un documento (automaticEntryOf).
create function private.automatic_entry_of(p_document uuid)
returns public.documents
language sql
stable
security definer
set search_path = ''
as $$
  select d.*
    from public.document_links l
    join public.documents d on d.id = l.to_document_id
    join public.journal_entries je on je.document_id = d.id
   where l.from_document_id = p_document and je.origin = 'AUTOMATICO' and d.status = 'CONFIRMADO'
   limit 1
$$;

-- Contraasiento de un asiento registrado (reverseEntry). Con p_with_actor
-- (anulación de una factura) no exige los permisos de Contabilidad.
create function private.reverse_journal_entry(
  p_doc public.documents,
  p_actor private.actor,
  p_comment text,
  p_with_actor boolean default false
)
returns public.documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_je public.journal_entries;
  v_lines jsonb;
  v_reversal public.documents;
begin
  select * into v_je from public.journal_entries je where je.document_id = p_doc.id;
  select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.credit, 'credit', l.debit, 'notes', l.notes)
                   order by l.line_no)
    into v_lines
    from public.journal_entry_lines l where l.document_id = p_doc.id;
  v_reversal := private.new_journal_entry(p_doc.company_id, p_actor, private.business_date(p_doc.company_id),
    format('Anulación del asiento N.º %s (%s): %s', v_je.entry_number, p_doc.display_number, p_comment),
    'CONTRAASIENTO', p_doc.id, v_lines);
  perform private.post_journal_entry(v_reversal, case when p_with_actor then p_actor end,
    format('Registró %s, contraasiento de %s, como asiento N.º {n}', v_reversal.display_number, p_doc.display_number));
  perform private.link_documents(p_doc.company_id, p_doc.id, v_reversal.id);
  perform private.transition_document(p_doc.id, 'CANCEL', p_comment, p_actor => p_actor,
    p_summary => format('Anuló %s con el contraasiento %s — %s', p_doc.display_number, v_reversal.display_number, p_comment));
  return v_reversal;
end;
$$;

-- Igual que antes, con el contraasiento en una función común (cmdCancelJournalEntry).
create or replace function public.je_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'JOURNAL_ENTRY');
  if v_doc.status <> 'CONFIRMADO' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'journal_entry.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  if exists (select 1 from public.journal_entries je where je.document_id = v_doc.id and je.origin = 'CONTRAASIENTO') then
    perform private.raise_business_error('DATO_INVALIDO', 'Un contraasiento no se anula. Si hubo un error, registrá el asiento correcto.');
  end if;
  perform private.reverse_journal_entry(v_doc, v_actor, v_comment);
end;
$$;

-- Contabilidad cambia la cuenta de una regla (cmdSavePostingRule).
create function public.posting_rule_save(p_company_id uuid, p_rule_id uuid, p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'posting_rule.update');
  v_rule public.posting_rules;
  v_account public.accounts;
  v_before public.accounts;
  v_label text;
begin
  select * into v_rule from public.posting_rules r where r.id = p_rule_id and r.company_id = p_company_id for update;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La regla de imputación no existe en esta empresa.');
  end if;
  v_account := private.account_for(p_company_id, p_account_id::text);
  if not v_account.is_imputable or not v_account.is_active then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Elegí una cuenta imputable y activa: %s %s no admite movimientos.', v_account.code, v_account.name));
  end if;
  if v_rule.account_id = v_account.id then
    return;
  end if;
  select * into v_before from public.accounts a where a.id = v_rule.account_id;
  v_label := private.posting_label(v_rule.event, v_rule.key);
  update public.posting_rules set account_id = v_account.id where id = v_rule.id;
  perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'posting_rule', v_rule.id, v_label,
    format('Cambió la imputación de "%s" a %s %s', v_label, v_account.code, v_account.name), null, null, null,
    jsonb_build_object('account', jsonb_build_object('from', v_before.code || ' ' || v_before.name,
                                                     'to', v_account.code || ' ' || v_account.name)));
end;
$$;

-- ------------------------------------------------------------------ Facturas de proveedor

-- Cantidad de una línea de OC ya facturada en facturas registradas, salvo una (invoicedQuantity).
create function private.invoiced_quantity(p_po_line uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.quantity), 0)
    from public.supplier_invoice_lines l
    join public.documents d on d.id = l.document_id
   where l.po_line_id = p_po_line and d.status in ('REGISTRADA', 'PAGADA_PARCIAL', 'PAGADA')
     and d.id is distinct from p_except
$$;

-- Control por oposición: no se factura más de lo recibido menos lo ya facturado (assertInvoiceable).
create function private.assert_invoiceable(p_po_line uuid, p_quantity numeric, p_except uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_line public.purchase_order_lines;
  v_product public.products;
  v_invoiced numeric;
  v_available numeric;
begin
  select * into v_line from public.purchase_order_lines l where l.id = p_po_line;
  v_invoiced := private.invoiced_quantity(p_po_line, p_except);
  v_available := round(v_line.qty_received - v_invoiced, 3);
  if p_quantity > v_available + 0.000000001 then
    select * into v_product from public.products p where p.id = v_line.product_id;
    perform private.raise_business_error('CANTIDAD_EXCEDIDA',
      format('%s: se recibieron %s y ya se facturaron %s; como mucho se pueden facturar %s.', v_product.code,
             private.format_qty(v_line.qty_received, v_product.uom_code), private.format_qty(v_invoiced, v_product.uom_code),
             private.format_qty(greatest(v_available, 0), v_product.uom_code)),
      'Se paga lo que efectivamente llegó: la factura se controla contra la orden de compra y la recepción.');
  end if;
end;
$$;

-- Registra la factura (registerInvoice): controla otra vez las cantidades y
-- genera el asiento de compra y la deuda. Con letra A el IVA va a crédito
-- fiscal; con letra C es parte del costo.
create function private.register_supplier_invoice(p_doc public.documents)
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
    jsonb_build_object('key', 'PROVEEDORES', 'debit', 0, 'credit', p_doc.total));
  perform private.post_event(v_actor, p_doc, 'COMPRA',
    format('Compra según %s: factura %s %s-%s de %s.', p_doc.display_number, v_si.letter, v_si.point_of_sale,
           v_si.invoice_number, v_supplier.legal_name),
    v_amounts);
end;
$$;

-- Factura del proveedor contra una OC enviada (cmdCreateSupplierInvoice).
-- p_input: {purchase_order_id, point_of_sale, invoice_number, document_date, notes, lines: [{po_line_id, quantity, unit_price}]}
create function public.si_create(p_company_id uuid, p_input jsonb, p_register boolean default false)
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

  v_doc := private.new_document(p_company_id, 'SUPPLIER_INVOICE', v_actor, v_supplier.id, trim(coalesce(p_input ->> 'notes', '')));
  update public.documents d set document_date = v_date where d.id = v_doc.id;
  insert into public.supplier_invoices (document_id, company_id, purchase_order_id, letter, point_of_sale, invoice_number, due_date)
  values (v_doc.id, p_company_id, v_order.id, v_letter, v_pos, v_number,
          v_date + (select po.payment_terms_days from public.purchase_orders po where po.document_id = v_order.id));
  insert into public.supplier_invoice_lines (company_id, document_id, line_no, po_line_id, product_id, quantity, unit_price,
                                             vat_rate, line_subtotal, line_tax, line_total)
  select p_company_id, v_doc.id, ord::int, (l ->> 'po_line_id')::uuid, (l ->> 'product_id')::uuid, (l ->> 'quantity')::numeric,
         (l ->> 'unit_price')::numeric, (l ->> 'vat_rate')::numeric, (l ->> 'subtotal')::numeric, (l ->> 'tax')::numeric,
         (l ->> 'subtotal')::numeric + (l ->> 'tax')::numeric
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord);
  update public.documents d
     set subtotal = t.subtotal, tax_total = t.tax, total = t.subtotal + t.tax
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

create function public.si_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SUPPLIER_INVOICE');
  perform private.require_permission(v_doc.company_id, 'supplier_invoice.create');
  perform private.register_supplier_invoice(v_doc);
end;
$$;

-- El borrador se anula sin más; una factura registrada y sin pagos, con el
-- contraasiento de su asiento de compra (cmdCancelSupplierInvoice).
create function public.si_cancel(p_document_id uuid, p_reason text)
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
  v_doc := private.get_document(p_document_id, 'SUPPLIER_INVOICE');
  if v_doc.status <> 'REGISTRADA' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'supplier_invoice.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  v_entry := private.automatic_entry_of(v_doc.id);
  if v_entry.id is not null then
    v_reversal := private.reverse_journal_entry(v_entry, v_actor, format('%s anulada: %s', v_doc.display_number, v_comment), true);
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', v_comment, p_actor => v_actor,
    p_summary => format('Anuló %s%s — %s', v_doc.display_number,
                        case when v_reversal.id is not null then format(' y su asiento con el contraasiento %s', v_reversal.display_number) else '' end,
                        v_comment));
end;
$$;

-- Igual que antes, y además no se anula una recepción ya facturada: lo
-- facturado nunca queda por encima de lo recibido (cmdCancelGoodsReceipt).
create or replace function public.gr_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'GOODS_RECEIPT');
  v_gr public.goods_receipts;
  v_po public.documents;
  v_line public.goods_receipt_lines;
  v_product public.products;
  v_invoiced numeric;
begin
  perform private.require_active_user();
  if v_doc.status <> 'CONFIRMADO' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and not private.is_supervisor(v_doc.company_id)
     and not exists (select 1 from private.my_role_codes(v_doc.company_id) as rc (code) where rc.code = 'GERENCIA')
     and v_doc.created_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES', 'No podés anular una recepción que registraste vos.',
      'Otro integrante de Depósito o Gerencia debe revisar y anular.');
  end if;
  select * into v_gr from public.goods_receipts g where g.document_id = v_doc.id;
  v_po := private.get_document(v_gr.purchase_order_id, 'PURCHASE_ORDER');
  if v_po.status = 'CERRADO' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está cerrada: la recepción ya no puede anularse.', v_po.display_number));
  end if;
  for v_line in select * from public.goods_receipt_lines l where l.document_id = v_doc.id order by l.line_no loop
    v_invoiced := private.invoiced_quantity(v_line.po_line_id);
    if v_invoiced > (select round(pl.qty_received - v_line.quantity, 3) from public.purchase_order_lines pl
                      where pl.id = v_line.po_line_id) + 0.000000001 then
      select * into v_product from public.products p where p.id = v_line.product_id;
      perform private.raise_business_error('TRANSICION_INVALIDA',
        format('No se puede anular %s: de %s ya se facturaron %s. Primero hay que anular la factura del proveedor.',
               v_doc.display_number, v_product.code, private.format_qty(v_invoiced, v_product.uom_code)),
        'Lo facturado nunca puede superar lo recibido (control por oposición).');
    end if;
  end loop;
  perform private.transition_document(v_doc.id, 'CANCEL', p_reason,
    p_summary => format('Anuló %s con contramovimiento — %s', v_doc.display_number, trim(coalesce(p_reason, ''))));
  for v_line in select * from public.goods_receipt_lines l where l.document_id = v_doc.id order by l.line_no loop
    update public.purchase_order_lines set qty_received = round(qty_received - v_line.quantity, 3) where id = v_line.po_line_id;
    perform private.post_stock_movement(v_doc.company_id, v_line.product_id, v_gr.warehouse_id, 'ANULACION_RECEPCION',
      -v_line.quantity, null, v_doc.id, v_line.id, private.business_date(v_doc.company_id));
  end loop;
  perform private.recompute_purchase_order(v_po.id);
end;
$$;

grant execute on function public.posting_rule_save(uuid, uuid, uuid) to authenticated;
grant execute on function public.si_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.si_confirm(uuid) to authenticated;
grant execute on function public.si_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- OC enviadas con mercadería recibida y todavía sin facturar (invoiceableOrders).
create function public.orders_invoiceable(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'supplier_invoice.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object('order', private.document_item(d), 'lines', o.lines) order by d.number)
      from public.documents d
      cross join lateral (
        select jsonb_agg(jsonb_build_object('line', to_jsonb(pl), 'product', to_jsonb(p), 'invoiced', x.invoiced,
                                            'pending', round(pl.qty_received - x.invoiced, 3))
                         order by pl.line_no) as lines
          from public.purchase_order_lines pl
          join public.products p on p.id = pl.product_id
          cross join lateral (select private.invoiced_quantity(pl.id) as invoiced) as x
         where pl.document_id = d.id and round(pl.qty_received - x.invoiced, 3) > 0.000000001
      ) as o
     where d.company_id = p_company_id and d.doc_type = 'PURCHASE_ORDER'
       and d.status in ('ENVIADO', 'RECIBIDO_PARCIAL', 'RECIBIDO', 'CERRADO') and o.lines is not null
  ), '[]');
end;
$$;

-- Lo pagado de una factura: desde la Fase 3b, por las órdenes de pago pagadas.
create function private.invoice_paid(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select 0::numeric $$;

-- Factura registrada en la cuenta corriente (PayableInvoice).
create function private.payable_invoice(p_doc public.documents, p_today date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_doc.id, 'display_number', p_doc.display_number, 'path', private.doc_path(p_doc.id),
    'invoice_label', si.letter || ' ' || si.point_of_sale || '-' || si.invoice_number,
    'document_date', p_doc.document_date, 'due_date', si.due_date, 'total', p_doc.total, 'paid', x.paid,
    'pending', p_doc.total - x.paid, 'overdue', si.due_date < p_today and p_doc.total - x.paid > 0)
    from public.supplier_invoices si
    cross join lateral (select private.invoice_paid(p_doc.id) as paid) as x
   where si.document_id = p_doc.id
$$;

-- Saldo con cada proveedor que tiene facturas registradas, por código (listPayables).
create function public.payables_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.business_date(p_company_id);
begin
  perform private.require_read(p_company_id, 'payable.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'supplier', jsonb_build_object('id', s.id, 'code', s.code, 'legal_name', s.legal_name, 'tax_id', s.tax_id,
                                            'payment_terms_days', s.payment_terms_days),
             'balance', coalesce(t.balance, 0), 'invoices', coalesce(t.invoices, 0), 'overdue', coalesce(t.overdue, 0),
             'next_due', t.next_due)
           order by s.code collate "C")
      from public.suppliers s
      left join lateral (
        select sum((i ->> 'pending')::numeric) as balance, count(*) as invoices,
               sum(case when (i ->> 'overdue')::boolean then (i ->> 'pending')::numeric else 0 end) as overdue,
               min((i ->> 'due_date')::date) as next_due
          from public.documents d
          cross join lateral (select private.payable_invoice(d, v_today) as i) as x
         where d.company_id = p_company_id and d.doc_type = 'SUPPLIER_INVOICE' and d.supplier_id = s.id
           and d.status in ('REGISTRADA', 'PAGADA_PARCIAL', 'PAGADA') and (i ->> 'pending')::numeric > 0
      ) as t on true
     where s.company_id = p_company_id
       and exists (
         select 1 from public.documents d
          where d.company_id = p_company_id and d.doc_type = 'SUPPLIER_INVOICE' and d.supplier_id = s.id
            and d.status in ('REGISTRADA', 'PAGADA_PARCIAL', 'PAGADA'))
  ), '[]');
end;
$$;

-- Cuenta corriente de un proveedor (supplierAccount): facturas con saldo acumulado y las pendientes.
create function public.supplier_account(p_company_id uuid, p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_supplier public.suppliers;
  v_today date := private.business_date(p_company_id);
begin
  perform private.require_read(p_company_id, 'payable.read');
  select * into v_supplier from public.suppliers s where s.id = p_supplier_id and s.company_id = p_company_id;
  if not found then
    return null;
  end if;
  return (
    with invoices as (
      select d.*, si.letter, si.point_of_sale, si.invoice_number
        from public.documents d join public.supplier_invoices si on si.document_id = d.id
       where d.company_id = p_company_id and d.doc_type = 'SUPPLIER_INVOICE' and d.supplier_id = v_supplier.id
         and d.status in ('REGISTRADA', 'PAGADA_PARCIAL', 'PAGADA')
    ),
    moves as (
      select i.id, i.display_number, i.document_date, i.number, i.total,
             'Factura ' || i.letter || ' ' || i.point_of_sale || '-' || i.invoice_number as description,
             sum(i.total) over (order by i.document_date, i.number rows between unbounded preceding and current row) as balance
        from invoices i
    )
    select jsonb_build_object(
      'supplier', to_jsonb(v_supplier),
      'movements', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'document_id', m.id, 'display_number', m.display_number, 'path', private.doc_path(m.id),
                 'date', m.document_date, 'description', m.description, 'debit', 0, 'credit', m.total,
                 'balance', m.balance)
               order by m.document_date, m.number)
          from moves m), '[]'::jsonb),
      'pending', coalesce((
        select jsonb_agg(p.i order by d.document_date, d.number)
          from public.documents d
          cross join lateral (select private.payable_invoice(d, v_today) as i) as p
         where d.id in (select i.id from invoices i) and (p.i ->> 'pending')::numeric > 0), '[]'::jsonb),
      'balance', coalesce((select sum(i.total) from invoices i), 0)
    )
  );
end;
$$;

-- Reglas de imputación de la empresa, en el orden del catálogo (listPostingRules).
create function public.posting_rules_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'posting_rule.read');
  return coalesce((
    select jsonb_agg(to_jsonb(r) || jsonb_build_object(
             'event_label', k.event_label, 'key_label', k.key_label,
             'account', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name))
           order by k.sort)
      from public.posting_rules r
      join public.posting_keys k on k.event = r.event and k.key = r.key
      join public.accounts a on a.id = r.account_id
     where r.company_id = p_company_id
  ), '[]');
end;
$$;

grant execute on function public.orders_invoiceable(uuid) to authenticated;
grant execute on function public.payables_list(uuid) to authenticated;
grant execute on function public.supplier_account(uuid, uuid) to authenticated;
grant execute on function public.posting_rules_list(uuid) to authenticated;

-- ------------------------------------------------------------------ Documentos: la factura en las lecturas comunes

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
$$;

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
    select l.line_no, null::uuid from public.journal_entry_lines l where l.document_id = p_doc.id
  ),
  codes as (
    select array_agg(p.code order by l.line_no) as list, count(*) as n
      from lines l join public.products p on p.id = l.product_id
  )
  select private.document_json(p_doc) || jsonb_build_object(
    'status_info', private.status_info(p_doc.doc_type, p_doc.status),
    'supplier_name', coalesce((select s.legal_name from public.suppliers s where s.id = p_doc.supplier_id), ''),
    'sector_name', coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), '—'),
    'created_by_name', private.full_name(p_doc.created_by),
    'line_count', (select count(*) from lines),
    'summary', coalesce(
      (select je.description from public.journal_entries je where je.document_id = p_doc.id),
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
begin
  case p_doc.doc_type || ':' || p_doc.status
    when 'PURCHASE_REQUISITION:BORRADOR' then
      return jsonb_build_object('who', v_sector,
        'text', 'Completar los ítems, justificar la necesidad y enviar la solicitud a Compras.');
    when 'PURCHASE_REQUISITION:SOLICITADO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Debe incluir la solicitud en una orden de compra a un proveedor, o rechazarla indicando el motivo.');
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
      return jsonb_build_object('who', 'Próxima fase',
        'text', 'Circuito de compra completo. En la Fase 3 continuará con la factura del proveedor, el pago y el asiento contable.');
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
    else
      v_lines := null;
  end case;

  return jsonb_build_object(
    'doc', private.document_item(p_doc),
    'lines', coalesce(v_lines, '[]'),
    'journal', case when p_doc.doc_type = 'JOURNAL_ENTRY' then private.journal_view(p_doc) end,
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
                        array['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'SUPPLIER_INVOICE', 'STOCK_ADJUSTMENT',
                              'JOURNAL_ENTRY'],
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

-- ------------------------------------------------------------------ Empresas: reglas de imputación

-- Igual que antes, y además las reglas base de imputación (startAccounting).
create or replace function private.start_accounting(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_system private.actor := row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor;
  v_year int := extract(year from private.business_date(p_company))::int;
  v_fy public.fiscal_years;
  v_fy_id uuid;
  v_lines jsonb;
  v_doc public.documents;
begin
  if not exists (select 1 from public.accounts a where a.company_id = p_company) then
    perform private.insert_base_chart(p_company);
  end if;
  perform private.insert_base_posting_rules(p_company);
  select * into v_fy from public.fiscal_years y where y.company_id = p_company and y.start_date = make_date(v_year, 1, 1);
  if not found then
    v_fy_id := private.create_fiscal_year(p_company, v_year);
    select * into v_fy from public.fiscal_years y where y.id = v_fy_id;
  end if;
  if exists (select 1 from public.documents d where d.company_id = p_company and d.doc_type = 'JOURNAL_ENTRY') then
    return;
  end if;
  with amounts as (
    select a.id, a.code, o.debit - o.credit as amount
      from private.opening_amounts() as o
      join public.accounts a on a.company_id = p_company and a.code = o.code and a.is_imputable
    union all
    select a.id, a.code, l.quantity_delta * l.unit_cost
      from public.documents d
      join public.stock_adjustments sa on sa.document_id = d.id
      join public.stock_adjustment_lines l on l.document_id = d.id
      join public.products p on p.id = l.product_id
      join public.accounts a on a.company_id = p_company and a.code = private.inventory_account(p.product_type) and a.is_imputable
     where d.company_id = p_company and d.doc_type = 'STOCK_ADJUSTMENT' and d.status = 'CONFIRMADO'
       and sa.reason_code = 'INVENTARIO_INICIAL'
  ),
  balanced as (
    select x.id, x.code, x.amount from amounts x
    union all
    select a.id, a.code, -(select coalesce(sum(x.amount), 0) from amounts x)
      from public.accounts a
     where a.company_id = p_company and a.code = private.opening_balancing_account() and a.is_imputable
  ),
  net as (
    select b.id, b.code, round(sum(b.amount), 2) as net from balanced b group by b.id, b.code
  )
  select jsonb_agg(jsonb_build_object('account_id', n.id, 'debit', greatest(n.net, 0), 'credit', greatest(-n.net, 0), 'notes', '')
                   order by (n.net > 0) desc, n.code collate "C")
    into v_lines
    from net n where n.net <> 0;
  v_doc := private.new_journal_entry(p_company, v_system, v_fy.start_date,
    format('Asiento de apertura del %s: saldos iniciales de la empresa.', lower(v_fy.name)), 'APERTURA', null,
    coalesce(v_lines, '[]'::jsonb));
  perform private.post_journal_entry(v_doc, v_system,
    format('Registró %s, asiento N.º {n} de apertura del ejercicio', v_doc.display_number));
end;
$$;

-- Igual que antes, y además copia las reglas de imputación con las cuentas de la empresa nueva.
create or replace function private.clone_company(p_template uuid, p_course uuid, p_slug text, p_owner uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_member uuid;
begin
  insert into public.companies (id, course_id, slug, legal_name, trade_name, tax_id, vat_condition, activity, address_line,
                                city, province, start_date, simulation_date, is_template, status, settings)
  select v_id, p_course, p_slug, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.activity, c.address_line,
         c.city, c.province, c.start_date, c.simulation_date, false, 'ACTIVA', c.settings
    from public.companies c where c.id = p_template;

  insert into public.islands (company_id, number, name)
  select v_id, i.number, i.name from public.islands i where i.company_id = p_template;
  insert into public.sectors (company_id, code, name, island_id)
  select v_id, s.code, s.name, ni.id
    from public.sectors s
    left join public.islands oi on oi.id = s.island_id
    left join public.islands ni on ni.company_id = v_id and ni.number = oi.number
   where s.company_id = p_template;
  insert into public.warehouses (company_id, code, name, is_active)
  select v_id, w.code, w.name, w.is_active from public.warehouses w where w.company_id = p_template;
  insert into public.company_modules (company_id, module_code, is_enabled)
  select v_id, m.module_code, m.is_enabled from public.company_modules m where m.company_id = p_template;
  insert into public.approval_rules (company_id, doc_type, level, min_amount, max_amount, approver_role,
                                     require_different_user, description, is_active)
  select v_id, r.doc_type, r.level, r.min_amount, r.max_amount, r.approver_role, r.require_different_user, r.description, r.is_active
    from public.approval_rules r where r.company_id = p_template;

  insert into public.suppliers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, lead_time_days, category, notes, is_active)
  select v_id, s.code, s.legal_name, s.trade_name, s.tax_id, s.vat_condition, s.address_line, s.city, s.province,
         s.phone, s.email, s.contact_name, s.payment_terms_days, s.lead_time_days, s.category, s.notes, s.is_active
    from public.suppliers s where s.company_id = p_template;
  insert into public.customers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, credit_limit, notes, is_active)
  select v_id, c.code, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.address_line, c.city, c.province,
         c.phone, c.email, c.contact_name, c.payment_terms_days, c.credit_limit, c.notes, c.is_active
    from public.customers c where c.company_id = p_template;
  -- El proveedor y el depósito habituales apuntan a los de la empresa nueva (mismo código).
  insert into public.products (company_id, code, name, description, category, product_type, uom_code, is_stockable,
                               standard_cost, sale_price, vat_rate, min_stock, reorder_qty, default_supplier_id,
                               default_warehouse_id, location, is_active)
  select v_id, p.code, p.name, p.description, p.category, p.product_type, p.uom_code, p.is_stockable,
         p.standard_cost, p.sale_price, p.vat_rate, p.min_stock, p.reorder_qty, ns.id, nw.id, p.location, p.is_active
    from public.products p
    left join public.suppliers os on os.id = p.default_supplier_id
    left join public.suppliers ns on ns.company_id = v_id and ns.code = os.code
    left join public.warehouses ow on ow.id = p.default_warehouse_id
    left join public.warehouses nw on nw.company_id = v_id and nw.code = ow.code
   where p.company_id = p_template;
  insert into public.accounts (company_id, code, name, account_type, normal_side, level, is_imputable, description, is_active)
  select v_id, a.code, a.name, a.account_type, a.normal_side, a.level, a.is_imputable, a.description, a.is_active
    from public.accounts a where a.company_id = p_template;
  insert into public.posting_rules (company_id, event, key, account_id)
  select v_id, r.event, r.key, na.id
    from public.posting_rules r
    join public.accounts oa on oa.id = r.account_id
    join public.accounts na on na.company_id = v_id and na.code = oa.code
   where r.company_id = p_template;

  if p_owner is not null then
    insert into public.company_members (company_id, user_id, job_title)
    values (v_id, p_owner, 'Docente a cargo') returning id into v_member;
    insert into public.member_roles (company_id, member_id, role_code) values (v_id, v_member, 'DOCENTE');
  end if;
  return v_id;
end;
$$;
