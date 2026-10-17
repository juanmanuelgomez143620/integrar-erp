-- 21. Fase 3b (docs/FASE_3_COMPRAS_Y_TESORERIA.md §5): cajas y bancos y
-- órdenes de pago. Traducción de la sección "Órdenes de pago" de
-- src/lib/mock/engine.ts y de sus lecturas en queries.ts (cuenta corriente con
-- los pagos, cajas y bancos y facturas para pagar), con los mismos mensajes y
-- la misma forma de datos (las pruebas de paridad lo comparan).
--
-- La clave de imputación PAGO está en la migración de catálogos siguiente, y
-- su regla base y el rubro de las cajas y los bancos (private.treasury_rubro),
-- en la de la plantilla.

-- ------------------------------------------------------------------ Catálogos: la acción de pagar

alter table public.permissions drop constraint permissions_action_check;
alter table public.permissions add constraint permissions_action_check
  check (action in ('read', 'create', 'update', 'approve', 'cancel', 'delete', 'export', 'pay'));
alter table public.document_transitions drop constraint document_transitions_action_check;
alter table public.document_transitions add constraint document_transitions_action_check
  check (action in ('SUBMIT', 'APPROVE', 'REJECT', 'WITHDRAW', 'REOPEN', 'SEND', 'CONFIRM', 'CANCEL', 'CLOSE', 'PAY', 'SYSTEM'));

-- ------------------------------------------------------------------ Tablas

-- Orden de pago: 1 a 1 con documents (tipo PAYMENT_ORDER).
create table public.payment_orders (
  document_id uuid primary key,
  doc_type text not null default 'PAYMENT_ORDER' check (doc_type = 'PAYMENT_ORDER'),
  company_id uuid not null,
  treasury_account_id uuid not null,       -- caja o banco: cuenta imputable del rubro Caja y bancos
  payment_reference text not null default '', -- número de transferencia o de cheque
  paid_on date,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, treasury_account_id) references public.accounts (company_id, id)
);

create table public.payment_order_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  invoice_id uuid not null,
  amount numeric(14, 2) not null check (amount > 0),
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.payment_orders (company_id, document_id) on delete cascade,
  foreign key (company_id, invoice_id) references public.supplier_invoices (company_id, document_id)
);
create index payment_order_lines_invoice_idx on public.payment_order_lines (invoice_id);

do $$
declare
  t text;
begin
  foreach t in array array['payment_orders', 'payment_order_lines'] loop
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

create policy payment_orders_select on public.payment_orders for select to authenticated
  using (company_id in (select private.companies_with_permission('payment_order.read')));
create policy payment_order_lines_select on public.payment_order_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('payment_order.read')));

-- ------------------------------------------------------------------ Imputación automática: una cuenta dada

-- Igual que antes, y además un importe puede ir a una cuenta dada en vez de a
-- la de una regla (la caja o el banco de un pago). p_amounts: [{key | account_id, debit, credit}]
create or replace function private.post_event(
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
    if v_amount ? 'account_id' then
      v_account := private.account_for(p_source.company_id, v_amount ->> 'account_id');
    else
      v_account := private.rule_account(p_source.company_id, p_event, v_amount ->> 'key');
    end if;
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

-- ------------------------------------------------------------------ Órdenes de pago: auxiliares

-- Lo que aplican a una factura las órdenes de pago en esos estados, salvo una (appliedToInvoice).
create function private.applied_to_invoice(p_invoice uuid, p_statuses text[], p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.amount), 0)
    from public.payment_order_lines l
    join public.documents d on d.id = l.document_id
   where l.invoice_id = p_invoice and d.status = any (p_statuses) and d.id is distinct from p_except
$$;

-- Lo pagado de una factura: sus órdenes de pago pagadas (invoicePaid).
create or replace function private.invoice_paid(p_invoice uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select private.applied_to_invoice(p_invoice, array['PAGADA']) $$;

-- Lo reservado de una factura en órdenes de pago en curso, salvo una (invoiceCommitted).
create function private.invoice_committed(p_invoice uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select private.applied_to_invoice(p_invoice, array['BORRADOR', 'PENDIENTE_APROBACION', 'APROBADA'], p_except) $$;

-- La primera orden de pago en curso que incluye una factura (activeOrderWith).
create function private.active_order_with(p_invoice uuid)
returns public.documents
language sql
stable
security definer
set search_path = ''
as $$
  select d.*
    from public.documents d
   where d.doc_type = 'PAYMENT_ORDER' and d.status in ('BORRADOR', 'PENDIENTE_APROBACION', 'APROBADA')
     and exists (select 1 from public.payment_order_lines l where l.document_id = d.id and l.invoice_id = p_invoice)
   order by d.number
   limit 1
$$;

-- Caja o banco de la empresa: una cuenta imputable y activa del rubro Caja y bancos (treasuryAccount).
create function private.treasury_account(p_company uuid, p_account text)
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
      'Elegí la caja o el banco desde el que se paga (una cuenta de Caja y bancos).');
  end if;
  if not v_account.is_active then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La cuenta %s %s está desactivada.', v_account.code, v_account.name));
  end if;
  return v_account;
end;
$$;

-- Quien registró una factura: la confirmación en su historial (invoiceRegistrant).
create function private.invoice_registrant(p_invoice uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.actor_user_id from public.audit_events e
   where e.document_id = p_invoice and e.action = 'CONFIRM'
   order by e.id
   limit 1
$$;

-- Estado de una factura según lo pagado: registrada, pagada parcialmente o pagada (recomputeInvoice).
create function private.recompute_invoice(p_invoice uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_paid numeric;
  v_target text;
begin
  select * into v_doc from public.documents d where d.id = p_invoice;
  if v_doc.status not in ('REGISTRADA', 'PAGADA_PARCIAL', 'PAGADA') then
    return;
  end if;
  v_paid := private.invoice_paid(p_invoice);
  v_target := case
    when v_paid >= v_doc.total - 0.000000001 then 'PAGADA'
    when v_paid > 0.000000001 then 'PAGADA_PARCIAL'
    else 'REGISTRADA'
  end;
  if v_target <> v_doc.status then
    perform private.transition_document(v_doc.id, 'SYSTEM', p_to => v_target);
  end if;
end;
$$;

-- La acción pedida tiene que existir desde el estado actual (requireTransition).
create function private.require_transition(p_doc public.documents, p_action text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.document_transitions t
     where t.doc_type = p_doc.doc_type and t.from_status = p_doc.status and t.action = p_action
  ) then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está en estado "%s" y no admite esta acción.', p_doc.display_number, private.status_label(p_doc.doc_type, p_doc.status)));
  end if;
end;
$$;

-- ------------------------------------------------------------------ Órdenes de pago: comandos

-- p_input: {supplier_id, treasury_account_id, notes, lines: [{invoice_id, amount}]} (cmdCreatePaymentOrder)
create function public.op_create(p_company_id uuid, p_input jsonb, p_submit boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'payment_order.create');
  v_supplier public.suppliers;
  v_account public.accounts;
  v_line jsonb;
  v_invoice public.documents;
  v_amount numeric;
  v_pending numeric;
  v_committed numeric;
  v_available numeric;
  v_seen uuid[] := '{}';
  v_lines jsonb := '[]';
  v_doc public.documents;
  v_total numeric;
begin
  select * into v_supplier from public.suppliers s
   where s.id::text = p_input ->> 'supplier_id' and s.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el proveedor al que se le paga.');
  end if;
  v_account := private.treasury_account(p_company_id, p_input ->> 'treasury_account_id');
  for v_line in
    select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]'::jsonb)) with ordinality as x (l, ord)
     where nullif(l ->> 'invoice_id', '') is not null and coalesce((l ->> 'amount')::numeric, 0) <> 0
     order by ord
  loop
    select * into v_invoice from public.documents d
     where d.id::text = v_line ->> 'invoice_id' and d.company_id = p_company_id and d.doc_type = 'SUPPLIER_INVOICE';
    if not found or v_invoice.supplier_id is distinct from v_supplier.id then
      perform private.raise_business_error('DATO_INVALIDO', format('Una de las facturas no es de %s.', v_supplier.legal_name));
    end if;
    if v_invoice.id = any (v_seen) then
      perform private.raise_business_error('DATO_INVALIDO', format('%s está dos veces en la orden.', v_invoice.display_number));
    end if;
    v_seen := v_seen || v_invoice.id;
    if v_invoice.status not in ('REGISTRADA', 'PAGADA_PARCIAL') then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s está en estado "%s": se pagan facturas registradas con saldo.', v_invoice.display_number,
               private.status_label(v_invoice.doc_type, v_invoice.status)));
    end if;
    v_amount := (v_line ->> 'amount')::numeric;
    if v_amount <= 0 or round(v_amount, 2) <> v_amount then
      perform private.raise_business_error('DATO_INVALIDO', 'Los importes deben ser mayores que cero y tener hasta 2 decimales.');
    end if;
    v_pending := v_invoice.total - private.invoice_paid(v_invoice.id);
    v_committed := private.invoice_committed(v_invoice.id);
    v_available := v_pending - v_committed;
    if v_amount > v_available + 0.000000001 then
      perform private.raise_business_error('IMPORTE_EXCEDIDO',
        format('%s: el saldo es %s%s; como mucho se pueden pagar %s.', v_invoice.display_number, private.format_money(v_pending),
               case when v_committed > 0
                 then format(' y ya hay %s en otras órdenes de pago en curso', private.format_money(v_committed)) else '' end,
               private.format_money(greatest(v_available, 0))),
        'Una factura no se paga dos veces: lo que está en una orden de pago en curso queda reservado.');
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('invoice_id', v_invoice.id, 'amount', v_amount));
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá qué facturas se pagan y cuánto de cada una.');
  end if;

  v_doc := private.new_document(p_company_id, 'PAYMENT_ORDER', v_actor, v_supplier.id, trim(coalesce(p_input ->> 'notes', '')));
  insert into public.payment_orders (document_id, company_id, treasury_account_id)
  values (v_doc.id, p_company_id, v_account.id);
  insert into public.payment_order_lines (company_id, document_id, line_no, invoice_id, amount)
  select p_company_id, v_doc.id, ord::int, (l ->> 'invoice_id')::uuid, (l ->> 'amount')::numeric
    from jsonb_array_elements(v_lines) with ordinality as x (l, ord);
  select sum(l.amount) into v_total from public.payment_order_lines l where l.document_id = v_doc.id;
  update public.documents d set subtotal = v_total, total = v_total where d.id = v_doc.id;
  perform private.link_documents(p_company_id, (l ->> 'invoice_id')::uuid, v_doc.id) from jsonb_array_elements(v_lines) as l;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'payment_order', v_doc.id, v_doc.display_number,
    format('Creó %s: pago a %s por %s desde %s %s', v_doc.display_number, v_supplier.legal_name,
           private.format_money(v_total), v_account.code, v_account.name), v_doc.id, null, 'BORRADOR');
  if p_submit then
    perform private.submit_payment_order(v_doc.id);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function private.submit_payment_order(p_document uuid)
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
    p_summary => format('Envió %s a aprobación (%s)', v_doc.display_number, private.format_money(v_doc.total)));
end;
$$;

create function public.op_submit(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYMENT_ORDER');
  perform private.submit_payment_order(v_doc.id);
end;
$$;

-- Gerencia aprueba o rechaza; quien preparó la orden no decide sobre ella (decidePaymentOrder).
create function private.decide_payment_order(p_document uuid, p_action text, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document, 'PAYMENT_ORDER');
  v_actor private.actor;
  v_comment text := trim(coalesce(p_comment, ''));
begin
  perform private.require_transition(v_doc, p_action);
  v_actor := private.require_permission(v_doc.company_id, 'payment_order.approve');
  if not private.is_supervisor(v_doc.company_id)
     and coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and v_doc.created_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      'No podés aprobar ni rechazar una orden de pago que preparaste vos.',
      'Separación de funciones: quien prepara un pago no lo autoriza.');
  end if;
  perform private.transition_document(v_doc.id, p_action, p_comment, p_actor => v_actor,
    p_summary => case when p_action = 'APPROVE' then
      format('Aprobó %s por %s%s', v_doc.display_number, private.format_money(v_doc.total),
             case when v_comment <> '' then ' — ' || v_comment else '' end)
    end);
end;
$$;

create function public.op_approve(p_document_id uuid, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.decide_payment_order(p_document_id, 'APPROVE', p_comment);
end;
$$;

create function public.op_reject(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.decide_payment_order(p_document_id, 'REJECT', p_reason);
end;
$$;

-- Tesorería paga: controla de nuevo los saldos de las facturas y el de la caja
-- o el banco, genera el asiento de pago y actualiza cada factura (cmdPayPaymentOrder).
create function public.op_pay(p_document_id uuid, p_reference text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_ref text := trim(coalesce(p_reference, ''));
  v_sod boolean;
  v_supervisor boolean;
  v_line public.payment_order_lines;
  v_invoice public.documents;
  v_pending numeric;
  v_op public.payment_orders;
  v_account public.accounts;
  v_balance numeric;
  v_supplier public.suppliers;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYMENT_ORDER');
  perform private.require_transition(v_doc, 'PAY');
  v_actor := private.require_permission(v_doc.company_id, 'payment_order.pay');
  if length(v_ref) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'La referencia del pago tiene hasta 60 caracteres.');
  end if;
  v_sod := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true);
  v_supervisor := private.is_supervisor(v_doc.company_id);
  for v_line in select * from public.payment_order_lines l where l.document_id = v_doc.id order by l.line_no loop
    if v_sod and not v_supervisor and private.invoice_registrant(v_line.invoice_id) = (select auth.uid()) then
      perform private.raise_business_error('SEPARACION_FUNCIONES',
        format('No podés pagar %s: la registraste vos.', (select d.display_number from public.documents d where d.id = v_line.invoice_id)),
        'Separación de funciones: quien registra una deuda no la paga. Tiene que pagarla otro integrante de Tesorería.');
    end if;
  end loop;
  for v_line in select * from public.payment_order_lines l where l.document_id = v_doc.id order by l.line_no loop
    select * into v_invoice from public.documents d where d.id = v_line.invoice_id;
    v_pending := v_invoice.total - private.invoice_paid(v_invoice.id);
    if v_invoice.status not in ('REGISTRADA', 'PAGADA_PARCIAL') or v_line.amount > v_pending + 0.000000001 then
      perform private.raise_business_error('IMPORTE_EXCEDIDO',
        format('%s: el saldo pendiente es %s y la orden paga %s.', v_invoice.display_number,
               private.format_money(greatest(v_pending, 0)), private.format_money(v_line.amount)));
    end if;
  end loop;
  select * into v_op from public.payment_orders po where po.document_id = v_doc.id;
  v_account := private.treasury_account(v_doc.company_id, v_op.treasury_account_id::text);
  v_balance := private.account_balance(v_account.id);
  if v_doc.total > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No alcanza el saldo de %s %s: hay %s y la orden es por %s.', v_account.code, v_account.name,
             private.format_money(v_balance), private.format_money(v_doc.total)),
      'Antes de pagar hay que controlar que haya fondos; por ejemplo, depositar el efectivo en el banco.');
  end if;
  select * into v_supplier from public.suppliers s where s.id = v_doc.supplier_id;
  perform private.transition_document(v_doc.id, 'PAY', p_actor => v_actor,
    p_summary => format('Pagó %s: %s a %s desde %s %s%s', v_doc.display_number, private.format_money(v_doc.total),
                        v_supplier.legal_name, v_account.code, v_account.name,
                        case when v_ref <> '' then format(' (%s)', v_ref) else '' end));
  update public.payment_orders
     set payment_reference = v_ref, paid_on = private.business_date(v_doc.company_id)
   where document_id = v_doc.id;
  select * into v_doc from public.documents d where d.id = v_doc.id;
  perform private.post_event(v_actor, v_doc, 'PAGO',
    format('Pago a %s según %s%s.', v_supplier.legal_name, v_doc.display_number,
           case when v_ref <> '' then format(' (%s)', v_ref) else '' end),
    jsonb_build_array(
      jsonb_build_object('key', 'PROVEEDORES', 'debit', v_doc.total, 'credit', 0),
      jsonb_build_object('account_id', v_account.id, 'debit', 0, 'credit', v_doc.total)));
  for v_line in select * from public.payment_order_lines l where l.document_id = v_doc.id order by l.line_no loop
    perform private.recompute_invoice(v_line.invoice_id);
  end loop;
end;
$$;

-- Antes de pagarse, la orden se anula sin más. Una orden pagada se anula con
-- el contraasiento de su pago, y sus facturas vuelven a tener saldo (cmdCancelPaymentOrder).
create function public.op_cancel(p_document_id uuid, p_reason text)
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
  v_line public.payment_order_lines;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYMENT_ORDER');
  if v_doc.status <> 'PAGADA' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'payment_order.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  v_entry := private.automatic_entry_of(v_doc.id);
  if v_entry.id is not null then
    v_reversal := private.reverse_journal_entry(v_entry, v_actor, format('%s anulada: %s', v_doc.display_number, v_comment), true);
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', v_comment, p_actor => v_actor,
    p_summary => format('Anuló %s%s — %s', v_doc.display_number,
                        case when v_reversal.id is not null then format(' y su pago con el contraasiento %s', v_reversal.display_number) else '' end,
                        v_comment));
  for v_line in select * from public.payment_order_lines l where l.document_id = v_doc.id order by l.line_no loop
    perform private.recompute_invoice(v_line.invoice_id);
  end loop;
end;
$$;

-- Igual que antes, y además una factura en una orden de pago en curso no se anula (cmdCancelSupplierInvoice).
create or replace function public.si_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
  v_order public.documents;
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
  v_order := private.active_order_with(v_doc.id);
  if v_order.id is not null then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está en la orden de pago %s: primero hay que anular esa orden.', v_doc.display_number, v_order.display_number));
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

grant execute on function public.op_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.op_submit(uuid) to authenticated;
grant execute on function public.op_approve(uuid, text) to authenticated;
grant execute on function public.op_reject(uuid, text) to authenticated;
grant execute on function public.op_pay(uuid, text) to authenticated;
grant execute on function public.op_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- Cajas y bancos: las cuentas imputables del rubro, con su saldo del libro mayor (treasuryAccounts).
create function public.treasury_accounts(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'treasury.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'account', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'description', a.description,
                                           'is_active', a.is_active),
             'balance', private.account_balance(a.id))
           order by a.code collate "C")
      from public.accounts a
     where a.company_id = p_company_id and a.is_imputable and starts_with(a.code, private.treasury_rubro() || '.')
  ), '[]');
end;
$$;

-- Facturas de un proveedor que se pueden pagar, de la que vence primero (paymentCandidates).
create function public.payment_candidates(p_company_id uuid, p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.business_date(p_company_id);
begin
  perform private.require_read(p_company_id, 'payment_order.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object('invoice', x.i, 'committed', x.committed,
                                        'available', (x.i ->> 'pending')::numeric - x.committed)
                     order by si.due_date, d.number)
      from public.documents d
      join public.supplier_invoices si on si.document_id = d.id
      cross join lateral (select private.payable_invoice(d, v_today) as i, private.invoice_committed(d.id) as committed) as x
     where d.company_id = p_company_id and d.doc_type = 'SUPPLIER_INVOICE' and d.supplier_id = p_supplier_id
       and d.status in ('REGISTRADA', 'PAGADA_PARCIAL')
  ), '[]');
end;
$$;

-- Igual que antes, y además los pagos al debe (supplierAccount): por fecha y, el mismo día, primero las facturas.
create or replace function public.supplier_account(p_company_id uuid, p_supplier_id uuid)
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
    entries as (
      select i.id, i.display_number, i.number, i.document_date as date, false as payment,
             'Factura ' || i.letter || ' ' || i.point_of_sale || '-' || i.invoice_number as description,
             0::numeric as debit, i.total as credit
        from invoices i
      union all
      select d.id, d.display_number, d.number, po.paid_on, true,
             'Pago desde ' || a.name || case when po.payment_reference <> '' then ' (' || po.payment_reference || ')' else '' end,
             d.total, 0::numeric
        from public.documents d
        join public.payment_orders po on po.document_id = d.id
        join public.accounts a on a.id = po.treasury_account_id
       where d.company_id = p_company_id and d.doc_type = 'PAYMENT_ORDER' and d.status = 'PAGADA'
         and d.supplier_id = v_supplier.id
    ),
    moves as (
      select e.*, sum(e.credit - e.debit) over (order by e.date, e.payment, e.number rows between unbounded preceding and current row) as balance
        from entries e
    )
    select jsonb_build_object(
      'supplier', to_jsonb(v_supplier),
      'movements', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'document_id', m.id, 'display_number', m.display_number, 'path', private.doc_path(m.id),
                 'date', m.date, 'description', m.description, 'debit', m.debit, 'credit', m.credit,
                 'balance', m.balance)
               order by m.date, m.payment, m.number)
          from moves m), '[]'::jsonb),
      'pending', coalesce((
        select jsonb_agg(p.i order by d.document_date, d.number)
          from public.documents d
          cross join lateral (select private.payable_invoice(d, v_today) as i) as p
         where d.id in (select i.id from invoices i) and (p.i ->> 'pending')::numeric > 0), '[]'::jsonb),
      'balance', coalesce((select sum(e.credit - e.debit) from entries e), 0)
    )
  );
end;
$$;

grant execute on function public.treasury_accounts(uuid) to authenticated;
grant execute on function public.payment_candidates(uuid, uuid) to authenticated;

-- ------------------------------------------------------------------ Documentos: la orden de pago en las lecturas comunes

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
$$;

-- Igual que antes; en una orden de pago, las líneas son facturas y el resumen, sus números.
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

-- Igual que antes, con la separación de funciones de la orden de pago (availableActions).
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
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'action', v_tr.action, 'label', v_tr.label, 'help', v_tr.help_text, 'tone', v_tr.tone,
      'requires_comment', v_tr.requires_comment, 'enabled', v_reason is null, 'reason', v_reason));
  end loop;
  return v_result;
end;
$$;

-- Igual que antes, con la orden de pago (y la OC recibida ya sigue con la factura del proveedor).
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

-- Facturas que cancela una orden de pago y desde dónde (paymentView).
create function private.payment_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'treasury_account', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name),
    'payment_reference', po.payment_reference,
    'paid_on', po.paid_on,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no,
               'invoice', jsonb_build_object(
                 'id', d.id, 'display_number', d.display_number, 'path', private.doc_path(d.id),
                 'invoice_label', si.letter || ' ' || si.point_of_sale || '-' || si.invoice_number,
                 'document_date', d.document_date, 'due_date', si.due_date, 'total', d.total,
                 'status_info', private.status_info(d.doc_type, d.status)),
               'amount', l.amount)
             order by l.line_no)
        from public.payment_order_lines l
        join public.documents d on d.id = l.invoice_id
        join public.supplier_invoices si on si.document_id = d.id
       where l.document_id = p_doc.id), '[]'::jsonb))
    from public.payment_orders po join public.accounts a on a.id = po.treasury_account_id
   where po.document_id = p_doc.id
$$;

-- Igual que antes, con la orden de pago: sus facturas, su lugar en el flujo y sus firmas.
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
    'payment', case when p_doc.doc_type = 'PAYMENT_ORDER' then private.payment_view(p_doc) end,
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
                        array['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'SUPPLIER_INVOICE', 'PAYMENT_ORDER',
                              'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;
