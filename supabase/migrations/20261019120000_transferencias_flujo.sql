-- 27. Fase 3d.1 (docs/FASE_3_COMPRAS_Y_TESORERIA.md §7): transferencias entre
-- cajas y bancos y flujo de fondos (real y proyectado). Traducción de la
-- sección "Transferencias entre cuentas" de src/lib/mock/engine.ts y de sus
-- lecturas en queries.ts, con los mismos mensajes y la misma forma de datos
-- (las pruebas de paridad lo comparan).
--
-- El tipo de documento, sus estados, transiciones, permisos y su tarea están
-- en la migración de catálogos siguiente.

-- ------------------------------------------------------------------ Tabla

-- Transferencia entre cuentas: 1 a 1 con documents (tipo FUNDS_TRANSFER). El importe es documents.total.
create table public.funds_transfers (
  document_id uuid primary key,
  doc_type text not null default 'FUNDS_TRANSFER' check (doc_type = 'FUNDS_TRANSFER'),
  company_id uuid not null,
  from_account_id uuid not null,          -- caja o banco de origen
  to_account_id uuid not null,            -- caja o banco de destino
  reference text not null default '',     -- número de la boleta de depósito o de la transferencia
  transferred_on date,                    -- fecha en que se confirmó (la del asiento)
  check (from_account_id <> to_account_id),
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, from_account_id) references public.accounts (company_id, id),
  foreign key (company_id, to_account_id) references public.accounts (company_id, id)
);

alter table public.funds_transfers enable row level security;
revoke all on table public.funds_transfers from anon, authenticated;
grant select on table public.funds_transfers to authenticated;
create trigger funds_transfers_same_company before update on public.funds_transfers
  for each row execute function private.prevent_company_change();
create policy funds_transfers_select on public.funds_transfers for select to authenticated
  using (company_id in (select private.companies_with_permission('funds_transfer.read')));

-- ------------------------------------------------------------------ Transferencias: comandos

-- Una caja o un banco de la empresa para transferir: cuenta imputable y activa del rubro Caja y bancos (fundsAccount).
create function private.funds_account(p_company uuid, p_account text, p_side text)
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
    perform private.raise_business_error('DATO_INVALIDO', format('Elegí la cuenta de %s: una caja o un banco de la empresa.', p_side));
  end if;
  if not v_account.is_active then
    perform private.raise_business_error('DATO_INVALIDO', format('La cuenta %s %s está desactivada.', v_account.code, v_account.name));
  end if;
  return v_account;
end;
$$;

-- p_input: {from_account_id, to_account_id, amount, reference, notes} (cmdCreateFundsTransfer)
create function public.ft_create(p_company_id uuid, p_input jsonb, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'funds_transfer.create');
  v_from public.accounts := private.funds_account(p_company_id, p_input ->> 'from_account_id', 'origen');
  v_to public.accounts := private.funds_account(p_company_id, p_input ->> 'to_account_id', 'destino');
  v_amount numeric := (p_input ->> 'amount')::numeric;
  v_reference text := trim(coalesce(p_input ->> 'reference', ''));
  v_doc public.documents;
begin
  if v_from.id = v_to.id then
    perform private.raise_business_error('DATO_INVALIDO', 'La cuenta de origen y la de destino tienen que ser distintas.');
  end if;
  if v_amount is null or v_amount <= 0 or round(v_amount, 2) <> v_amount then
    perform private.raise_business_error('DATO_INVALIDO', 'El importe debe ser mayor que cero y tener hasta 2 decimales.');
  end if;
  if length(v_reference) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'La referencia tiene hasta 60 caracteres.');
  end if;
  v_doc := private.new_document(p_company_id, 'FUNDS_TRANSFER', v_actor, null, trim(coalesce(p_input ->> 'notes', '')));
  update public.documents d set subtotal = v_amount, total = v_amount where d.id = v_doc.id;
  insert into public.funds_transfers (document_id, company_id, from_account_id, to_account_id, reference)
  values (v_doc.id, p_company_id, v_from.id, v_to.id, v_reference);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'funds_transfer', v_doc.id, v_doc.display_number,
    format('Creó %s: %s de %s %s a %s %s', v_doc.display_number, private.format_money(v_amount),
           v_from.code, v_from.name, v_to.code, v_to.name),
    v_doc.id, null, 'BORRADOR');
  if p_confirm then
    perform private.confirm_funds_transfer(v_doc.id);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

-- Confirma la transferencia: controla el saldo de la cuenta de origen y genera el asiento (confirmFundsTransfer).
create function private.confirm_funds_transfer(p_document uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_ft public.funds_transfers;
  v_from public.accounts;
  v_to public.accounts;
  v_balance numeric;
  v_actor private.actor;
begin
  select * into v_doc from public.documents d where d.id = p_document;
  perform private.require_transition(v_doc, 'CONFIRM');
  select * into v_ft from public.funds_transfers t where t.document_id = v_doc.id;
  v_from := private.funds_account(v_doc.company_id, v_ft.from_account_id::text, 'origen');
  v_to := private.funds_account(v_doc.company_id, v_ft.to_account_id::text, 'destino');
  v_balance := private.account_balance(v_from.id);
  if v_doc.total > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No alcanza el saldo de %s %s: hay %s y la transferencia es por %s.', v_from.code, v_from.name,
             private.format_money(v_balance), private.format_money(v_doc.total)),
      'Transferí un importe menor o desde otra cuenta.');
  end if;
  v_actor := private.transition_document(v_doc.id, 'CONFIRM',
    p_summary => format('Confirmó %s: %s de %s %s a %s %s', v_doc.display_number, private.format_money(v_doc.total),
                        v_from.code, v_from.name, v_to.code, v_to.name));
  update public.funds_transfers set transferred_on = private.business_date(v_doc.company_id) where document_id = v_doc.id;
  select * into v_doc from public.documents d where d.id = v_doc.id;
  perform private.post_event(v_actor, v_doc, 'TRANSFERENCIA',
    format('Transferencia de %s a %s según %s%s.', v_from.name, v_to.name, v_doc.display_number,
           case when v_ft.reference <> '' then format(' (%s)', v_ft.reference) else '' end),
    jsonb_build_array(
      jsonb_build_object('account_id', v_to.id, 'debit', v_doc.total, 'credit', 0),
      jsonb_build_object('account_id', v_from.id, 'debit', 0, 'credit', v_doc.total)));
end;
$$;

create function public.ft_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'FUNDS_TRANSFER');
  perform private.require_permission(v_doc.company_id, 'funds_transfer.create');
  perform private.confirm_funds_transfer(v_doc.id);
end;
$$;

-- El borrador se anula sin más. Una confirmada se anula con el contraasiento
-- de su asiento, si los fondos todavía están en la cuenta de destino (cmdCancelFundsTransfer).
create function public.ft_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_reason, ''));
  v_to public.accounts;
  v_balance numeric;
  v_entry public.documents;
  v_reversal public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'FUNDS_TRANSFER');
  if v_doc.status <> 'CONFIRMADA' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'funds_transfer.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  select a.* into v_to from public.funds_transfers t join public.accounts a on a.id = t.to_account_id
   where t.document_id = v_doc.id;
  v_balance := private.account_balance(v_to.id);
  if v_doc.total > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No se puede anular: en %s %s hay %s y la transferencia fue por %s.', v_to.code, v_to.name,
             private.format_money(v_balance), private.format_money(v_doc.total)),
      'Los fondos ya se usaron: para devolverlos, prepará otra transferencia.');
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

grant execute on function public.ft_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.ft_confirm(uuid) to authenticated;
grant execute on function public.ft_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Flujo de fondos

-- De dónde viene un movimiento de fondos: el documento que generó su asiento
-- (en un contraasiento, el del asiento que anula) o, si es manual, su origen (cashConcept).
create function private.cash_concept(p_entry uuid)
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
    when (select x.doc_type from source x) = 'PAYMENT_ORDER' then 'PAGOS'
    when (select x.doc_type from source x) = 'FUNDS_TRANSFER' then 'TRANSFERENCIAS'
    when (select je.origin from public.journal_entries je join base b on je.document_id = b.id) = 'APERTURA' then 'APERTURA'
    else 'OTROS'
  end
$$;

-- Flujo de fondos real de un período: saldo inicial, entradas y salidas por
-- concepto y por cuenta, y saldo final (cashFlow).
create function public.cash_flow(p_company_id uuid, p_from text, p_to text)
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
      values ('APERTURA', 'Saldos de apertura', 1), ('PAGOS', 'Pagos a proveedores', 2),
             ('TRANSFERENCIAS', 'Movimientos entre cajas y bancos', 3), ('OTROS', 'Otros asientos de Contabilidad', 4)
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

-- Flujo de fondos proyectado: desde el saldo de hoy, lo que falta pagar de las
-- facturas de proveedores por vencimiento, y el saldo tras cada tramo (cashProjection).
create function public.cash_projection(p_company_id uuid)
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
    buckets (key, label, sort, lo, hi) as (
      values ('VENCIDAS', 'Vencidas', 1, null::int, -1), ('SEMANA', 'Próximos 7 días', 2, 0, 7),
             ('QUINCENA', 'De 8 a 15 días', 3, 8, 15), ('MES', 'De 16 a 30 días', 4, 16, 30),
             ('DESPUES', 'A más de 30 días', 5, 31, null::int)
    ),
    totals as (
      select b.key, b.label, b.sort,
             coalesce(sum(p.pending) filter (where p.pending > 0), 0) as payments,
             count(p.pending) filter (where p.pending > 0) as invoices
        from buckets b
        left join pending p on (b.lo is null or p.days >= b.lo) and (b.hi is null or p.days <= b.hi)
       group by b.key, b.label, b.sort
    ),
    running as (
      select t.*, v_balance - sum(t.payments) over (order by t.sort) as balance from totals t
    )
    select jsonb_build_object(
      'today', v_today,
      'balance', v_balance,
      'buckets', (
        select jsonb_agg(jsonb_build_object('key', r.key, 'label', r.label, 'payments', r.payments,
                                            'invoices', r.invoices, 'balance', r.balance) order by r.sort)
          from running r),
      'shortfall', (select r.key from running r where r.balance < 0 order by r.sort limit 1)
    )
  );
end;
$$;

grant execute on function public.cash_flow(uuid, text, text) to authenticated;
grant execute on function public.cash_projection(uuid) to authenticated;

-- ------------------------------------------------------------------ Documentos: la transferencia en las lecturas comunes

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
    || coalesce((
      select jsonb_build_object('ft', jsonb_build_object(
               'from_account_id', x.from_account_id, 'to_account_id', x.to_account_id, 'reference', x.reference,
               'transferred_on', x.transferred_on))
        from public.funds_transfers x where x.document_id = p_doc.id), '{}')
$$;

-- Igual que antes; el resumen de una transferencia son sus cuentas.
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
      (select fa.name || ' → ' || ta.name
         from public.funds_transfers t
         join public.accounts fa on fa.id = t.from_account_id
         join public.accounts ta on ta.id = t.to_account_id
        where t.document_id = p_doc.id),
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

-- Igual que antes; una transferencia no se confirma sin saldo ni se anula si los fondos ya se usaron.
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
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'action', v_tr.action, 'label', v_tr.label, 'help', v_tr.help_text, 'tone', v_tr.tone,
      'requires_comment', v_tr.requires_comment, 'enabled', v_reason is null, 'reason', v_reason));
  end loop;
  return v_result;
end;
$$;

-- Igual que antes, con la transferencia (nextStep).
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

-- Transferencia: de qué caja o banco a cuál (transferView).
create function private.transfer_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'from_account', jsonb_build_object('id', fa.id, 'code', fa.code, 'name', fa.name),
    'to_account', jsonb_build_object('id', ta.id, 'code', ta.code, 'name', ta.name),
    'reference', t.reference,
    'transferred_on', t.transferred_on)
    from public.funds_transfers t
    join public.accounts fa on fa.id = t.from_account_id
    join public.accounts ta on ta.id = t.to_account_id
   where t.document_id = p_doc.id
$$;

-- Igual que antes, con la transferencia: su vista, su lugar en el flujo y sus firmas.
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
    'transfer', case when p_doc.doc_type = 'FUNDS_TRANSFER' then private.transfer_view(p_doc) end,
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
                              'SUPPLIER_INVOICE', 'PAYMENT_ORDER', 'FUNDS_TRANSFER', 'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;
