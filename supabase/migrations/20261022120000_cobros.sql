-- 37. Fase 4c (docs/FASE_4_VENTAS_Y_CLIENTES.md §5): recibo de cobro con su
-- asiento, estado de la factura de venta según lo cobrado, antigüedad de
-- saldos y cobros en el flujo de fondos real y proyectado. Traducción de la
-- sección "Recibos de cobro" de src/lib/mock/engine.ts y de sus lecturas en
-- queries.ts, con los mismos mensajes y la misma forma de datos.
--
-- El tipo de documento, sus estados, transiciones, tarea, permisos y la clave
-- de imputación COBRO están en la migración de catálogos siguiente; la regla
-- base del asiento de cobro, en la de la plantilla.

-- ------------------------------------------------------------------ Tablas

-- Recibo de cobro: 1 a 1 con documents (tipo CUSTOMER_RECEIPT).
create table public.customer_receipts (
  document_id uuid primary key,
  doc_type text not null default 'CUSTOMER_RECEIPT' check (doc_type = 'CUSTOMER_RECEIPT'),
  company_id uuid not null,
  treasury_account_id uuid not null,  -- caja o banco donde ingresa el dinero
  payment_method text not null check (payment_method in ('TRANSFERENCIA', 'CHEQUE', 'EFECTIVO')),
  reference text not null default '', -- número de la transferencia o del cheque del cliente
  received_on date,                   -- al confirmarse: la fecha del asiento
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, treasury_account_id) references public.accounts (company_id, id)
);

create table public.customer_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  invoice_id uuid not null,
  amount numeric(14, 2) not null check (amount > 0),
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.customer_receipts (company_id, document_id) on delete cascade,
  foreign key (company_id, invoice_id) references public.sales_invoices (company_id, document_id)
);
create index customer_receipt_lines_invoice_idx on public.customer_receipt_lines (invoice_id);

do $$
declare
  t text;
begin
  foreach t in array array['customer_receipts', 'customer_receipt_lines'] loop
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

create policy customer_receipts_select on public.customer_receipts for select to authenticated
  using (company_id in (select private.companies_with_permission('customer_receipt.read')));
create policy customer_receipt_lines_select on public.customer_receipt_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('customer_receipt.read')));

-- ------------------------------------------------------------------ Facturas de venta: lo cobrado

-- Facturas de venta que generaron deuda: registradas, cobradas en parte o cobradas (INVOICED_SALES_STATUSES).
create or replace function private.invoiced_sales_statuses()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['REGISTRADA', 'COBRADA_PARCIAL', 'COBRADA'] $$;

-- Lo que aplican a una factura de venta los recibos de cobro en esos estados, salvo uno (appliedToSalesInvoice).
create function private.applied_to_sales_invoice(p_invoice uuid, p_statuses text[], p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(coalesce(sum(l.amount), 0), 2)
    from public.customer_receipt_lines l
    join public.documents d on d.id = l.document_id
   where l.invoice_id = p_invoice and d.status = any (p_statuses) and d.id is distinct from p_except
$$;

-- Lo cobrado de una factura de venta: sus recibos de cobro confirmados (salesInvoiceCollected).
create function private.sales_invoice_collected(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select private.applied_to_sales_invoice(p_invoice, array['CONFIRMADO']) $$;

-- Lo reservado de una factura de venta en recibos de cobro en borrador, salvo uno (salesInvoiceCommitted).
create function private.sales_invoice_committed(p_invoice uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select private.applied_to_sales_invoice(p_invoice, array['BORRADOR'], p_except) $$;

-- Lo que falta cobrar de una factura de venta registrada: su total menos lo cobrado (salesInvoicePending).
create or replace function private.sales_invoice_pending(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select round(d.total - private.sales_invoice_collected(d.id), 2) from public.documents d where d.id = p_invoice $$;

-- El primer recibo de cobro en borrador que incluye una factura de venta (draftReceiptWith).
create function private.draft_receipt_with(p_invoice uuid)
returns public.documents
language sql
stable
security definer
set search_path = ''
as $$
  select d.*
    from public.documents d
   where d.doc_type = 'CUSTOMER_RECEIPT' and d.status = 'BORRADOR'
     and exists (select 1 from public.customer_receipt_lines l where l.document_id = d.id and l.invoice_id = p_invoice)
   order by d.number
   limit 1
$$;

-- Caja o banco donde ingresa un cobro: una cuenta imputable y activa del rubro Caja y bancos (receiptAccount).
create function private.receipt_account(p_company uuid, p_account text)
returns public.accounts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account public.accounts;
begin
  select * into v_account from public.accounts a where a.company_id = p_company and a.id::text = p_account;
  if not found or not v_account.is_imputable or not starts_with(v_account.code, private.treasury_rubro() || '.') then
    perform private.raise_business_error('DATO_INVALIDO',
      'Elegí la caja o el banco donde ingresa el cobro (una cuenta de Caja y bancos).');
  end if;
  if not v_account.is_active then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La cuenta %s %s está desactivada.', v_account.code, v_account.name));
  end if;
  return v_account;
end;
$$;

-- Estado de una factura de venta según lo cobrado: registrada, cobrada parcialmente o cobrada (recomputeSalesInvoice).
create function private.recompute_sales_invoice(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_collected numeric;
  v_target text;
begin
  select * into v_doc from public.documents d where d.id = p_invoice;
  if not (v_doc.status = any (private.invoiced_sales_statuses())) then
    return;
  end if;
  v_collected := private.sales_invoice_collected(p_invoice);
  v_target := case
    when v_collected >= v_doc.total - 0.000000001 then 'COBRADA'
    when v_collected > 0.000000001 then 'COBRADA_PARCIAL'
    else 'REGISTRADA'
  end;
  if v_target <> v_doc.status then
    perform private.transition_document(v_doc.id, 'SYSTEM', p_to => v_target);
  end if;
end;
$$;

-- Cómo se nombra cada medio dentro de una frase: "por transferencia", "con cheque"… (PAYMENT_VIA).
create function private.payment_via(p_method text, p_noun boolean default false)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_noun then case p_method when 'CHEQUE' then 'cheque' when 'EFECTIVO' then 'efectivo' else 'transferencia' end
    else case p_method when 'CHEQUE' then 'con cheque' when 'EFECTIVO' then 'en efectivo' else 'por transferencia' end
  end
$$;

-- Confirma el cobro: controla de nuevo los saldos de las facturas, genera el
-- asiento (la caja o el banco al debe y Deudores por ventas al haber) y
-- actualiza el estado de cada factura. Quien emitió una factura no registra
-- su cobro, SoD-9 (confirmCustomerReceipt).
create function private.confirm_customer_receipt(p_doc public.documents)
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
                        v_customer.legal_name, private.payment_via(v_rc.payment_method), v_number, v_account.code, v_account.name));
  update public.customer_receipts set received_on = private.business_date(p_doc.company_id) where document_id = p_doc.id;
  select * into v_doc from public.documents d where d.id = p_doc.id;
  perform private.post_event(v_actor, v_doc, 'COBRO',
    format('Cobro a %s según %s (%s%s).', v_customer.legal_name, v_doc.display_number,
           private.payment_via(v_rc.payment_method, true), v_number),
    jsonb_build_array(
      jsonb_build_object('account_id', v_account.id, 'debit', v_doc.total, 'credit', 0),
      jsonb_build_object('key', 'DEUDORES', 'debit', 0, 'credit', v_doc.total)));
  for v_line in select * from public.customer_receipt_lines l where l.document_id = p_doc.id order by l.line_no loop
    perform private.recompute_sales_invoice(v_line.invoice_id);
  end loop;
end;
$$;

-- ------------------------------------------------------------------ Recibos de cobro: comandos

-- p_input: {customer_id, treasury_account_id, payment_method, reference, notes, lines: [{invoice_id, amount}]}
-- (cmdCreateCustomerReceipt)
create function public.rc_create(p_company_id uuid, p_input jsonb, p_confirm boolean default false)
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

  select * into v_number from private.next_document_number(p_company_id, 'CUSTOMER_RECEIPT');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, customer_id, notes, created_by)
  values (p_company_id, 'CUSTOMER_RECEIPT', v_number.number, v_number.display_number, 'BORRADOR', private.business_date(p_company_id),
          (v_actor).sector_id, v_customer.id, trim(coalesce(p_input ->> 'notes', '')), (v_actor).user_id)
  returning * into v_doc;
  insert into public.customer_receipts (document_id, company_id, treasury_account_id, payment_method, reference)
  values (v_doc.id, p_company_id, v_account.id, v_method, v_ref);
  insert into public.customer_receipt_lines (company_id, document_id, line_no, invoice_id, amount)
  select p_company_id, v_doc.id, ord::int, (l ->> 'invoice_id')::uuid, (l ->> 'amount')::numeric
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord);
  select sum(l.amount) into v_total from public.customer_receipt_lines l where l.document_id = v_doc.id;
  update public.documents d set subtotal = v_total, total = v_total where d.id = v_doc.id
  returning d.* into v_doc;
  perform private.link_documents(p_company_id, (l ->> 'invoice_id')::uuid, v_doc.id) from jsonb_array_elements(v_lines) as l;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'customer_receipt', v_doc.id, v_doc.display_number,
    format('Creó %s: cobro a %s por %s %s en %s %s', v_doc.display_number, v_customer.legal_name,
           private.format_money(v_total), private.payment_via(v_method), v_account.code, v_account.name),
    v_doc.id, null, 'BORRADOR');
  if p_confirm then
    perform private.confirm_customer_receipt(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.rc_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'CUSTOMER_RECEIPT');
  perform private.require_permission(v_doc.company_id, 'customer_receipt.create');
  perform private.confirm_customer_receipt(v_doc);
end;
$$;

-- El borrador se anula sin más (lo que reservaba se libera). Un recibo cobrado
-- se anula con el contraasiento de su cobro, si el dinero todavía está en la
-- caja o el banco, y sus facturas vuelven a tener saldo (cmdCancelCustomerReceipt).
create function public.rc_cancel(p_document_id uuid, p_reason text)
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
  if v_doc.total > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No se puede anular: en %s %s hay %s y el cobro fue por %s.', v_account.code, v_account.name,
             private.format_money(v_balance), private.format_money(v_doc.total)),
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

-- Igual que antes, y además una factura en un recibo de cobro en borrador no se anula (cmdCancelSalesInvoice).
create or replace function public.fv_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
  v_receipt public.documents;
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
  v_receipt := private.draft_receipt_with(v_doc.id);
  if v_receipt.id is not null then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está en el recibo de cobro %s: primero hay que anular ese recibo.', v_doc.display_number, v_receipt.display_number));
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

grant execute on function public.rc_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.rc_confirm(uuid) to authenticated;
grant execute on function public.rc_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- Facturas de un cliente que se pueden cobrar, de la que vence primero (receiptCandidates).
create function public.receipt_candidates(p_company_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.business_date(p_company_id);
begin
  perform private.require_read(p_company_id, 'customer_receipt.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object('invoice', x.i, 'committed', x.committed,
                                        'available', round((x.i ->> 'pending')::numeric - x.committed, 2))
                     order by si.due_date, d.number)
      from public.documents d
      join public.sales_invoices si on si.document_id = d.id
      cross join lateral (
        select private.receivable_invoice(d, v_today) as i, private.sales_invoice_committed(d.id) as committed
      ) as x
     where d.company_id = p_company_id and d.doc_type = 'SALES_INVOICE' and d.customer_id = p_customer_id
       and d.status in ('REGISTRADA', 'COBRADA_PARCIAL')
  ), '[]');
end;
$$;

-- Igual que antes, con la antigüedad del saldo de cada cliente: a vencer y
-- vencido de 1 a 30, de 31 a 60, de 61 a 90 y de más de 90 días (listReceivables).
create or replace function public.receivables_list(p_company_id uuid)
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
             'next_due', t.next_due,
             'aging', jsonb_build_object(
               'A_VENCER', coalesce(t.a_vencer, 0), 'DE_1_A_30', coalesce(t.de_1_a_30, 0),
               'DE_31_A_60', coalesce(t.de_31_a_60, 0), 'DE_61_A_90', coalesce(t.de_61_a_90, 0),
               'MAS_DE_90', coalesce(t.mas_de_90, 0)))
           order by c.code collate "C")
      from public.customers c
      left join lateral (
        select sum(p.pending) as balance, count(*) as invoices,
               sum(case when p.overdue then p.pending else 0 end) as overdue,
               min(p.due_date) as next_due,
               sum(case when p.days <= 0 then p.pending else 0 end) as a_vencer,
               sum(case when p.days between 1 and 30 then p.pending else 0 end) as de_1_a_30,
               sum(case when p.days between 31 and 60 then p.pending else 0 end) as de_31_a_60,
               sum(case when p.days between 61 and 90 then p.pending else 0 end) as de_61_a_90,
               sum(case when p.days > 90 then p.pending else 0 end) as mas_de_90
          from (
            select (x.i ->> 'pending')::numeric as pending, (x.i ->> 'overdue')::boolean as overdue,
                   (x.i ->> 'due_date')::date as due_date, v_today - (x.i ->> 'due_date')::date as days
              from public.documents d
              cross join lateral (select private.receivable_invoice(d, v_today) as i) as x
             where d.company_id = p_company_id and d.doc_type = 'SALES_INVOICE' and d.customer_id = c.id
               and d.status = any (private.invoiced_sales_statuses()) and (x.i ->> 'pending')::numeric > 0
          ) as p
      ) as t on true
     where c.company_id = p_company_id
       and exists (
         select 1 from public.documents d
          where d.company_id = p_company_id and d.doc_type = 'SALES_INVOICE' and d.customer_id = c.id
            and d.status = any (private.invoiced_sales_statuses()))
  ), '[]');
end;
$$;

-- Igual que antes, y además los cobros al haber (customerAccount): por fecha y, el mismo día, primero las facturas.
create or replace function public.customer_account(p_company_id uuid, p_customer_id uuid)
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
    entries as (
      select i.id, i.display_number, i.number, i.document_date as date, false as receipt,
             'Factura ' || private.sales_invoice_label(i.letter, i.point_of_sale, i.invoice_number) as description,
             i.total as debit, 0::numeric as credit
        from invoices i
      union all
      select d.id, d.display_number, d.number, x.received_on, true,
             'Cobro en ' || a.name || case when x.reference <> '' then ' (' || x.reference || ')' else '' end,
             0::numeric, d.total
        from public.documents d
        join public.customer_receipts x on x.document_id = d.id
        join public.accounts a on a.id = x.treasury_account_id
       where d.company_id = p_company_id and d.doc_type = 'CUSTOMER_RECEIPT' and d.status = 'CONFIRMADO'
         and d.customer_id = v_customer.id
    ),
    moves as (
      select e.*, sum(e.debit - e.credit) over (order by e.date, e.receipt, e.number rows between unbounded preceding and current row) as balance
        from entries e
    )
    select jsonb_build_object(
      'customer', to_jsonb(v_customer),
      'movements', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'document_id', m.id, 'display_number', m.display_number, 'path', private.doc_path(m.id),
                 'date', m.date, 'description', m.description, 'debit', m.debit, 'credit', m.credit,
                 'balance', m.balance)
               order by m.date, m.receipt, m.number)
          from moves m), '[]'::jsonb),
      'pending', coalesce((
        select jsonb_agg(p.i order by d.document_date, d.number)
          from public.documents d
          cross join lateral (select private.receivable_invoice(d, v_today) as i) as p
         where d.id in (select i.id from invoices i) and (p.i ->> 'pending')::numeric > 0), '[]'::jsonb),
      'balance', coalesce((select sum(e.debit - e.credit) from entries e), 0),
      'credit_used', private.customer_credit_used(v_customer.id)
    )
  );
end;
$$;

grant execute on function public.receipt_candidates(uuid, uuid) to authenticated;

-- ------------------------------------------------------------------ Flujo de fondos: los cobros

-- Igual que antes, y los movimientos de un recibo de cobro (o de su contraasiento) son cobros a clientes (cashConcept).
create or replace function private.cash_concept(p_entry uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select coalesce(je.reverses_id, je.document_id) as id from public.journal_entries je where je.document_id = p_entry
  ),
  source as (
    select s.doc_type
      from base b
      join public.document_links k on k.to_document_id = b.id
      join public.documents s on s.id = k.from_document_id and s.doc_type <> 'JOURNAL_ENTRY'
     limit 1
  )
  select case
    when (select x.doc_type from source x) = 'CUSTOMER_RECEIPT' then 'COBROS'
    when (select x.doc_type from source x) = 'PAYMENT_ORDER' then 'PAGOS'
    when (select x.doc_type from source x) = 'FUNDS_TRANSFER' then 'TRANSFERENCIAS'
    when (select je.origin from public.journal_entries je join base b on je.document_id = b.id) = 'APERTURA' then 'APERTURA'
    else 'OTROS'
  end
$$;

-- Igual que antes, con el concepto "Cobros a clientes" (cashFlow).
create or replace function public.cash_flow(p_company_id uuid, p_from text, p_to text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to date;
begin
  perform private.require_read(p_company_id, 'treasury.read');
  select r.date_from, r.date_to into v_from, v_to from private.book_range(p_from, p_to) as r;
  return (
    with treasury as (
      select a.id, a.code, a.name from public.accounts a
       where a.company_id = p_company_id and a.is_imputable and starts_with(a.code, private.treasury_rubro() || '.')
    ),
    moves as (
      select l.account_id, l.debit, l.credit, d.document_date, private.cash_concept(d.id) as concept
        from public.journal_entry_lines l
        join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
        join public.documents d on d.id = l.document_id
       where l.account_id in (select t.id from treasury t)
    ),
    accounts as (
      select t.id, t.code, t.name,
             coalesce(sum(m.debit - m.credit) filter (where m.document_date < v_from), 0) as opening,
             coalesce(sum(m.debit) filter (where m.document_date between v_from and v_to), 0) as inflow,
             coalesce(sum(m.credit) filter (where m.document_date between v_from and v_to), 0) as outflow
        from treasury t left join moves m on m.account_id = t.id
       group by t.id, t.code, t.name
    ),
    concepts (key, label, sort) as (
      values ('APERTURA', 'Saldos de apertura', 1), ('COBROS', 'Cobros a clientes', 2), ('PAGOS', 'Pagos a proveedores', 3),
             ('TRANSFERENCIAS', 'Movimientos entre cajas y bancos', 4), ('OTROS', 'Otros asientos de Contabilidad', 5)
    )
    select jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'opening', (select coalesce(sum(a.opening), 0) from accounts a),
      'inflow', (select coalesce(sum(a.inflow), 0) from accounts a),
      'outflow', (select coalesce(sum(a.outflow), 0) from accounts a),
      'closing', (select coalesce(sum(a.opening + a.inflow - a.outflow), 0) from accounts a),
      'concepts', (
        select jsonb_agg(jsonb_build_object(
                 'key', c.key, 'label', c.label,
                 'inflow', coalesce((select sum(m.debit) from moves m
                                      where m.concept = c.key and m.document_date between v_from and v_to), 0),
                 'outflow', coalesce((select sum(m.credit) from moves m
                                       where m.concept = c.key and m.document_date between v_from and v_to), 0))
               order by c.sort)
          from concepts c),
      'accounts', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'account', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name),
                 'opening', a.opening, 'inflow', a.inflow, 'outflow', a.outflow,
                 'closing', a.opening + a.inflow - a.outflow)
               order by a.code collate "C")
          from accounts a), '[]'::jsonb)
    )
  );
end;
$$;

-- Igual que antes, y además lo que falta cobrar de las facturas de venta por
-- vencimiento: el saldo tras cada tramo suma los cobros y resta los pagos (cashProjection).
create or replace function public.cash_projection(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_balance numeric;
begin
  perform private.require_read(p_company_id, 'treasury.read');
  v_today := private.business_date(p_company_id);
  select coalesce(sum(l.debit - l.credit), 0) into v_balance
    from public.journal_entry_lines l
    join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
    join public.accounts a on a.id = l.account_id
   where a.company_id = p_company_id and a.is_imputable and starts_with(a.code, private.treasury_rubro() || '.');
  return (
    with pending as (
      select si.due_date - v_today as days, d.total - private.invoice_paid(d.id) as pending
        from public.documents d join public.supplier_invoices si on si.document_id = d.id
       where d.company_id = p_company_id and d.doc_type = 'SUPPLIER_INVOICE'
         and d.status in ('REGISTRADA', 'PAGADA_PARCIAL', 'PAGADA')
    ),
    receivable as (
      select x.due_date - v_today as days, private.sales_invoice_pending(d.id) as pending
        from public.documents d join public.sales_invoices x on x.document_id = d.id
       where d.company_id = p_company_id and d.doc_type = 'SALES_INVOICE'
         and d.status = any (private.invoiced_sales_statuses())
    ),
    buckets (key, label, sort, lo, hi) as (
      values ('VENCIDAS', 'Vencidas', 1, null::int, -1), ('SEMANA', 'Próximos 7 días', 2, 0, 7),
             ('QUINCENA', 'De 8 a 15 días', 3, 8, 15), ('MES', 'De 16 a 30 días', 4, 16, 30),
             ('DESPUES', 'A más de 30 días', 5, 31, null::int)
    ),
    totals as (
      select b.key, b.label, b.sort,
             coalesce(sum(p.pending) filter (where p.pending > 0), 0) as payments,
             count(p.pending) filter (where p.pending > 0) as invoices,
             coalesce((select sum(r.pending) from receivable r
                        where r.pending > 0 and (b.lo is null or r.days >= b.lo) and (b.hi is null or r.days <= b.hi)), 0) as collections,
             (select count(*) from receivable r
               where r.pending > 0 and (b.lo is null or r.days >= b.lo) and (b.hi is null or r.days <= b.hi)) as receivables
        from buckets b
        left join pending p on (b.lo is null or p.days >= b.lo) and (b.hi is null or p.days <= b.hi)
       group by b.key, b.label, b.sort, b.lo, b.hi
    ),
    running as (
      select t.*, v_balance + sum(t.collections - t.payments) over (order by t.sort) as balance from totals t
    )
    select jsonb_build_object(
      'today', v_today,
      'balance', v_balance,
      'buckets', (
        select jsonb_agg(jsonb_build_object('key', r.key, 'label', r.label, 'collections', r.collections,
                                            'receivables', r.receivables, 'payments', r.payments,
                                            'invoices', r.invoices, 'balance', r.balance) order by r.sort)
          from running r),
      'shortfall', (select r.key from running r where r.balance < 0 order by r.sort limit 1)
    )
  );
end;
$$;

-- ------------------------------------------------------------------ Documentos: el recibo de cobro en las lecturas comunes

-- Recibo de cobro: dónde ingresó el dinero, con qué medio y qué facturas cancela (receiptView).
create function private.receipt_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'treasury_account', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name),
    'payment_method', x.payment_method,
    'reference', x.reference,
    'received_on', x.received_on,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no,
               'invoice', jsonb_build_object(
                 'id', i.id, 'display_number', i.display_number, 'path', private.doc_path(i.id),
                 'invoice_label', private.sales_invoice_label(fv.letter, fv.point_of_sale, fv.invoice_number),
                 'document_date', i.document_date, 'due_date', fv.due_date, 'total', i.total,
                 'status_info', private.status_info(i.doc_type, i.status)),
               'amount', l.amount) order by l.line_no)
        from public.customer_receipt_lines l
        join public.documents i on i.id = l.invoice_id
        join public.sales_invoices fv on fv.document_id = i.id
       where l.document_id = p_doc.id), '[]'::jsonb))
    from public.customer_receipts x join public.accounts a on a.id = x.treasury_account_id
   where x.document_id = p_doc.id
$$;

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
    || coalesce((
      select jsonb_build_object('rc', jsonb_build_object(
               'treasury_account_id', x.treasury_account_id, 'payment_method', x.payment_method, 'reference', x.reference,
               'received_on', x.received_on))
        from public.customer_receipts x where x.document_id = p_doc.id), '{}')
$$;

-- Igual que antes, con las facturas que cancela el recibo de cobro.
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
    select l.line_no, null::uuid from public.customer_receipt_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.bank_reconciliation_lines l where l.document_id = p_doc.id
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

-- Igual que antes, con la factura cobrada en parte y el recibo de cobro (nextStep).
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

-- Igual que antes, con el recibo de cobro: su vista, su lugar en el flujo y sus firmas.
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
    'receipt', case when p_doc.doc_type = 'CUSTOMER_RECEIPT' then private.receipt_view(p_doc) end,
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
                              'DELIVERY_NOTE', 'SALES_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

-- Igual que antes, con los motivos del recibo de cobro: quien emitió la factura no la cobra y no se anula si el dinero ya se usó.
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
    if p_doc.doc_type = 'CUSTOMER_RECEIPT' and v_tr.action = 'CONFIRM' and not v_supervisor and v_sod
       and exists (select 1 from public.customer_receipt_lines l
                    where l.document_id = p_doc.id and private.invoice_registrant(l.invoice_id) = v_uid) then
      v_reason := 'Separación de funciones: emitiste una de las facturas; tiene que cobrarla otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'CUSTOMER_RECEIPT' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' then
      select a.* into v_account from public.customer_receipts x join public.accounts a on a.id = x.treasury_account_id
       where x.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('Los fondos ya se usaron: en %s %s hay %s. Primero hay que anular el movimiento que los usó.',
                           v_account.code, v_account.name, private.format_money(v_balance));
      end if;
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
