-- 109. Fase 8f.2 (docs/FASE_8_BANCO_Y_FISCO.md §4): la multa formal por presentar fuera de término.
-- Cuando el fisco acepta una declaración que se presentó después de su vencimiento, aplica en el
-- momento una multa simulada de $ 100.000 (una por impuesto y mes), que se reduce a la mitad si se paga
-- dentro de los 15 días: el documento nuevo "Multa del fisco" (MUL), vinculado a la declaración, con la
-- tarea de pagarla para Tesorería y el aviso a Impuestos, Gerencia y Tesorería. Tesorería la paga desde el
-- Banco Aula (cuenta Multas fiscales contra el banco) y el fisco la imputa cuando el banco procesa la
-- orden. La multa es también una fila de la cuenta corriente tributaria. Traducción de "Multa por
-- presentar fuera de término (8f.2)" de engine.ts.
--
-- El tipo de documento, sus estados, transiciones, tareas y permisos están en la migración de catálogos
-- siguiente; la cuenta y la regla, en la de la plantilla y en la de las empresas existentes.

-- ------------------------------------------------------------------ Tablas

create table public.tax_fines (
  document_id uuid primary key,
  doc_type text not null default 'TAX_FINE' check (doc_type = 'TAX_FINE'),
  company_id uuid not null,
  tax text not null check (tax in ('IVA', 'IIBB')),
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  tax_return_id uuid not null references public.documents (id),
  presented_on date not null,
  due_date date not null,
  amount numeric(14, 2) not null check (amount > 0),
  reduced_amount numeric(14, 2) not null check (reduced_amount > 0),
  reduction_until date not null,
  paid_on date,
  paid_amount numeric(14, 2),
  paid_account_id uuid,
  imputed_on date,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, paid_account_id) references public.accounts (company_id, id)
);
-- Una multa por obligación (impuesto y mes).
create unique index tax_fines_obligation_idx on public.tax_fines (company_id, tax, period);

alter table public.tax_fines enable row level security;
revoke all on table public.tax_fines from anon, authenticated;
grant select on table public.tax_fines to authenticated;
create trigger tax_fines_same_company before update on public.tax_fines
  for each row execute function private.prevent_company_change();
create policy tax_fines_select on public.tax_fines for select to authenticated
  using (company_id in (select private.companies_with_permission('tax_fine.read')));

-- ------------------------------------------------------------------ Auxiliares

-- La multa formal por presentar fuera de término (imposeLateFilingFine, a validar): si el fisco acepta
-- una declaración que se presentó después de su vencimiento, la aplica en el momento (una por impuesto y
-- mes), con la reducción a la mitad dentro de los 15 días. El documento nace notificado: no tiene borrador.
create function private.tax_fine_impose(p_dj uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_system private.actor := row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor;
  v_dj public.documents;
  v_t public.tax_returns;
  v_presented date;
  v_today date;
  v_amount numeric := 100000;
  v_reduced numeric;
  v_until date;
  v_number record;
  v_fine public.documents;
  v_what text;
begin
  select * into v_dj from public.documents d where d.id = p_dj;
  select * into v_t from public.tax_returns t where t.document_id = p_dj;
  v_presented := (v_t.presented_at at time zone coalesce((select s.timezone from public.school_settings s where s.id = 1), 'America/Argentina/Buenos_Aires'))::date;
  if v_presented <= v_t.due_date then
    return;
  end if;
  if exists (select 1 from public.tax_fines f
              where f.company_id = v_dj.company_id and f.tax = v_t.tax and f.period = v_t.period) then
    return;
  end if;
  v_today := private.business_date(v_dj.company_id);
  v_reduced := round(v_amount / 2, 2);
  v_until := v_today + 15;
  select * into v_number from private.next_document_number(v_dj.company_id, 'TAX_FINE');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id,
                                notes, created_by, subtotal, total)
  values (v_dj.company_id, 'TAX_FINE', v_number.number, v_number.display_number, 'NOTIFICADA', v_today, null, '',
          null, v_amount, v_amount)
  returning * into v_fine;
  insert into public.tax_fines (document_id, company_id, tax, period, tax_return_id, presented_on, due_date, amount,
                                reduced_amount, reduction_until)
  values (v_fine.id, v_fine.company_id, v_t.tax, v_t.period, v_dj.id, v_presented, v_t.due_date, v_amount, v_reduced,
          v_until);
  perform private.link_documents(v_dj.company_id, v_dj.id, v_fine.id);
  v_what := private.tax_name(v_t.tax) || ' de ' || private.period_label(v_t.period);
  perform private.log_audit(v_dj.company_id, v_system, 'CREATE', 'tax_fine', v_fine.id, v_fine.display_number,
    format('El fisco aplicó %s: multa por presentar %s (%s) fuera de término, %s; %s si se paga hasta el %s',
           v_fine.display_number, v_dj.display_number, v_what, private.format_money(v_amount),
           private.format_money(v_reduced), to_char(v_until, 'DD/MM/YYYY')),
    v_fine.id, null, 'NOTIFICADA');
  perform private.notify_roles(v_dj.company_id, array['IMPUESTOS', 'GERENCIA', 'TESORERIA'], 'MULTA',
    format('El fisco aplicó una multa (%s)', v_fine.display_number),
    format('Por presentar %s (%s) fuera de término: %s, o %s si se paga hasta el %s.', v_dj.display_number, v_what,
           private.format_money(v_amount), private.format_money(v_reduced), to_char(v_until, 'DD/MM/YYYY')),
    private.doc_path(v_fine.id));
  perform private.open_tasks_for_status(v_fine.id, v_system);
end;
$$;

-- La multa en su documento (taxFineView): la declaración, el importe, la reducción y el pago.
create function private.tax_fine_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tax', f.tax, 'period', f.period,
    'tax_return', jsonb_build_object('id', d.id, 'display_number', d.display_number, 'path', private.doc_path(d.id)),
    'presented_on', f.presented_on, 'due_date', f.due_date, 'amount', f.amount, 'reduced_amount', f.reduced_amount,
    'reduction_until', f.reduction_until,
    'amount_due', coalesce(f.paid_amount,
                           case when private.business_date(p_doc.company_id) <= f.reduction_until
                                then f.reduced_amount else f.amount end),
    'paid_on', f.paid_on, 'paid_amount', f.paid_amount,
    'paid_account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name)
                       from public.accounts a where a.id = f.paid_account_id),
    'imputed_on', f.imputed_on,
    'bank_order', (select jsonb_build_object('seq', m.seq, 'status', m.status, 'received_on', m.received_on,
                                             'processed_on', m.processed_on,
                                             'transaction_number', m.transaction_number)
                     from public.bank_movements m
                    where m.source_document_id = p_doc.id and m.origin = 'ORDEN' and m.reverses_id is null
                      and m.direction = 'DEBITO'
                    order by m.seq
                    limit 1))
    from public.tax_fines f join public.documents d on d.id = f.tax_return_id
   where f.document_id = p_doc.id
$$;

-- ------------------------------------------------------------------ Comandos

-- Tesorería paga la multa del fisco (cmdPayTaxFine): por transferencia desde el Banco Aula, a la mitad
-- dentro del plazo de la reducción. Como la declaración, queda en el banco hasta que el fisco la imputa.
create function public.tax_fine_pay(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_f public.tax_fines;
  v_bank public.bank_accounts;
  v_account public.accounts;
  v_today date;
  v_reduced boolean;
  v_amount numeric;
  v_balance numeric;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'TAX_FINE');
  perform private.require_transition(v_doc, 'PAY');
  v_actor := private.require_permission(v_doc.company_id, 'tax_fine.pay');
  select * into v_bank from public.bank_accounts b
   where b.company_id = v_doc.company_id and b.is_active
   order by b.created_at, b.id
   limit 1;
  if v_bank.id is null then
    perform private.raise_business_error('DATO_INVALIDO',
      'La empresa no tiene su cuenta en el Banco Aula: las multas se pagan desde ahí.');
  end if;
  select * into v_account from public.accounts a where a.id = v_bank.ledger_account_id;
  v_today := private.business_date(v_doc.company_id);
  select * into v_f from public.tax_fines f where f.document_id = v_doc.id;
  v_reduced := v_today <= v_f.reduction_until;
  v_amount := case when v_reduced then v_f.reduced_amount else v_f.amount end;
  v_balance := private.account_balance(v_account.id);
  if v_amount > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No alcanza el saldo de %s %s: hay %s y la multa es %s.', v_account.code, v_account.name,
             private.format_money(v_balance), private.format_money(v_amount)),
      'Antes de pagar hay que controlar que haya fondos: el flujo de fondos proyectado lo anticipa.');
  end if;
  perform private.transition_document(v_doc.id, 'PAY', p_actor => v_actor,
    p_summary => format('Pagó %s por transferencia desde el Banco Aula: %s%s', v_doc.display_number,
                        private.format_money(v_amount),
                        case when v_reduced then ', con la reducción a la mitad' else '' end));
  update public.tax_fines set paid_on = v_today, paid_amount = v_amount, paid_account_id = v_account.id
   where document_id = v_doc.id;
  select * into v_doc from public.documents d where d.id = v_doc.id;
  perform private.post_event(v_actor, v_doc, 'PAGO_MULTA',
    format('Pago de la multa del fisco por presentar fuera de término la declaración de %s de %s (%s).',
           private.tax_name(v_f.tax), private.period_label(v_f.period), v_doc.display_number),
    jsonb_build_array(
      jsonb_build_object('key', 'MULTA', 'debit', v_amount, 'credit', 0),
      jsonb_build_object('account_id', v_account.id, 'debit', 0, 'credit', v_amount)));
end;
$$;

grant execute on function public.tax_fine_pay(uuid) to authenticated;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, y al aceptar una declaración presentada después de su vencimiento, el fisco aplica la
-- multa (receiveTaxReturn).
create or replace function private.tax_return_receive_doc(p_doc uuid, p_reason text, p_actor private.actor, p_received_by uuid,
                                               p_presenting text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_today date;
  v_code text;
begin
  select * into v_doc from public.documents d where d.id = p_doc;
  v_today := private.business_date(v_doc.company_id);
  if p_reason is not null then
    perform private.transition_document(v_doc.id, case when p_presenting is not null then 'CONFIRM' else 'REJECT' end,
      p_reason, p_to => 'OBSERVADA', p_actor => p_actor,
      p_summary => case when p_presenting is not null then format('%s; el fisco la observó: %s', p_presenting, p_reason)
                        else format('Observó en el fisco %s: %s', v_doc.display_number, p_reason) end);
    update public.documents set status_reason = p_reason where id = v_doc.id;
    update public.tax_returns set received_on = v_today, received_by = p_received_by where document_id = v_doc.id;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fisco_acuse:' || v_doc.company_id, 0));
  v_code := private.tax_return_acuse(v_doc.company_id, v_today);
  perform private.transition_document(v_doc.id, case when p_presenting is not null then 'CONFIRM' else 'APPROVE' end,
    p_to => case when v_doc.total > 0 then 'PRESENTADA' else 'SIN_SALDO' end, p_actor => p_actor,
    p_summary => case when p_presenting is not null then format('%s; el fisco la aceptó con el acuse %s', p_presenting, v_code)
                      else format('Aceptó en el fisco %s con el acuse %s', v_doc.display_number, v_code) end);
  update public.tax_returns set transaction_code = v_code, received_on = v_today, received_by = p_received_by
   where document_id = v_doc.id;
  perform private.tax_return_post_entry(p_actor, v_doc.id);
  perform private.fiscal_notices_fulfill(v_doc.id,
    array['PRESENTACION']
      || case when v_doc.total > 0 then array[]::text[] else array['PAGO'] end
      || case when private.tax_return_control_difference(v_doc.id) = 0 then array['DIFERENCIA'] else array[]::text[] end,
    format('el fisco aceptó %s', v_doc.display_number));
  perform private.tax_fine_impose(v_doc.id);
end;
$$;

-- Igual que antes, y también imputa el pago de una multa (imputeTaxPayment).
create or replace function private.tax_return_impute(p_order uuid, p_on date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.bank_movements;
  v_doc public.documents;
begin
  select * into v_order from public.bank_movements m where m.id = p_order;
  if v_order.origin <> 'ORDEN' or v_order.reverses_id is not null or v_order.source_document_id is null then
    return;
  end if;
  select * into v_doc from public.documents d where d.id = v_order.source_document_id;
  if v_doc.id is null or v_doc.doc_type not in ('TAX_RETURN', 'TAX_FINE') or v_doc.status <> 'PAGO_EN_BANCO' then
    return;
  end if;
  if v_doc.doc_type = 'TAX_RETURN' then
    update public.tax_returns set imputed_on = p_on where document_id = v_doc.id;
  else
    update public.tax_fines set imputed_on = p_on where document_id = v_doc.id;
  end if;
  perform private.transition_document(v_doc.id, 'SYSTEM', p_to => 'PAGADA',
    p_actor => row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor,
    p_summary => format('El fisco imputó el pago de %s: %s (transacción %s del Banco Aula)', v_doc.display_number,
                        private.format_money(v_order.amount), v_order.transaction_number));
  if v_doc.doc_type = 'TAX_RETURN' then
    perform private.fiscal_notices_fulfill(v_doc.id, array['PAGO'], format('el fisco imputó el pago de %s', v_doc.display_number));
  end if;
end;
$$;

-- Igual que antes, y en la multa, sus datos (document_json).
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
               'base', x.base, 'rate', x.rate, 'control_amount', x.control_amount, 'transaction_code', x.transaction_code,
               'received_on', x.received_on, 'received_by', x.received_by,
               'interest', x.interest, 'imputed_on', x.imputed_on))
        from public.tax_returns x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('tf', jsonb_build_object(
               'tax', x.tax, 'period', x.period, 'tax_return_id', x.tax_return_id, 'presented_on', x.presented_on,
               'due_date', x.due_date, 'amount', x.amount, 'reduced_amount', x.reduced_amount,
               'reduction_until', x.reduction_until, 'paid_on', x.paid_on, 'paid_amount', x.paid_amount,
               'paid_account_id', x.paid_account_id, 'imputed_on', x.imputed_on))
        from public.tax_fines x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rs', jsonb_build_object(
               'carrier_id', x.carrier_id, 'vehicle_id', x.vehicle_id, 'driver_id', x.driver_id,
               'departed_at', x.departed_at, 'closed_at', x.closed_at))
        from public.route_sheets x where x.document_id = p_doc.id), '{}')
$$;

-- Igual que antes, y en la multa, su vista (documentDetail).
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
    when 'SALES_QUOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'list_price', l.list_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.sales_quote_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.sales_quotes x where x.document_id = p_doc.id;
    when 'PRODUCTION_ORDER' then
      select x.materials_warehouse_id into v_warehouse from public.production_orders x where x.document_id = p_doc.id;
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity_planned, 'notes', '',
               'planned_unit_cost', l.planned_unit_cost, 'qty_issued', l.quantity_issued, 'unit_cost', l.unit_cost,
               -- Mientras no se entregó: lo disponible en el depósito, sin lo reservado para otros.
               'qty_available', case when p_doc.status in ('BORRADOR', 'LIBERADA') then
                 round(private.on_hand_quantity(p.id, v_warehouse) - private.reserved_quantity(p.id, v_warehouse, p_doc.id), 3)
               end) order by l.line_no)
        into v_lines
        from public.production_order_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
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
    'sales_quote', case when p_doc.doc_type = 'SALES_QUOTE' then private.sales_quote_view(p_doc) end,
    'production_order', case when p_doc.doc_type = 'PRODUCTION_ORDER' then private.production_order_view(p_doc) end,
    'payroll', case when p_doc.doc_type = 'PAYROLL' then private.payroll_view(p_doc) end,
    'tax_return', case when p_doc.doc_type = 'TAX_RETURN' then private.tax_return_view(p_doc) end,
    'tax_fine', case when p_doc.doc_type = 'TAX_FINE' then private.tax_fine_view(p_doc) end,
    'route_sheet', case when p_doc.doc_type = 'ROUTE_SHEET' then private.route_sheet_view(p_doc) end,
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
                              'SUPPLIER_INVOICE', 'PAYMENT_ORDER', 'FUNDS_TRANSFER', 'BANK_RECONCILIATION', 'SALES_QUOTE', 'SALES_ORDER',
                              'DELIVERY_NOTE', 'ROUTE_SHEET', 'SALES_INVOICE', 'CUSTOMER_RECEIPT', 'PRODUCTION_ORDER', 'PAYROLL', 'TAX_RETURN',
                              'TAX_FINE', 'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
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
      when 'SALES_QUOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        jsonb_build_object('label', 'Conformidad del cliente', 'name', '', 'sector', '', 'at', ''))
      when 'PRODUCTION_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Planificó', array['CREATE']),
        private.signature(p_doc.id, 'Entregó los materiales', array['ISSUE']),
        private.signature(p_doc.id, 'Terminó', array['FINISH']))
      when 'PAYROLL' then jsonb_build_array(
        private.signature(p_doc.id, 'Liquidó', array['CREATE']),
        private.signature(p_doc.id, 'Confirmó', array['CONFIRM']))
      when 'TAX_RETURN' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        private.signature(p_doc.id, 'Presentó', array['CONFIRM']))
      when 'ROUTE_SHEET' then jsonb_build_array(
        private.signature(p_doc.id, 'Armó', array['CREATE']),
        private.signature(p_doc.id, 'Salió', array['SEND']),
        private.signature(p_doc.id, 'Rindió', array['CLOSE']))
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

-- Igual que antes, y el resumen de la multa en la lista (listItem).
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
    select l.line_no, l.product_id from public.sales_quote_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.production_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.journal_entry_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.payment_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.customer_receipt_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.bank_reconciliation_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.payroll_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.route_sheet_lines l where l.document_id = p_doc.id
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
      (select 'Sueldos de ' || private.period_label(x.period) from public.payrolls x where x.document_id = p_doc.id),
      (select case when x.tax = 'IVA' then 'IVA' else 'Ingresos brutos' end || ' de ' || private.period_label(x.period)
         from public.tax_returns x where x.document_id = p_doc.id),
      (select 'Multa por ' || case when x.tax = 'IVA' then 'IVA' else 'ingresos brutos' end || ' de '
              || private.period_label(x.period)
         from public.tax_fines x where x.document_id = p_doc.id),
      (select private.transport_label(r) from public.route_sheets r where r.document_id = p_doc.id),
      (select p.code || ' ' || p.name
         from public.production_orders o join public.products p on p.id = o.product_id
        where o.document_id = p_doc.id),
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

-- Igual que antes, y qué sigue con la multa notificada o con su pago en el banco (nextStep).
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

-- Igual que antes, y las multas, cada una después de su declaración (taxAccount).
create or replace function public.tax_account(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_rows jsonb;
begin
  perform private.require_read(p_company_id, 'fisco.read');
  v_today := private.business_date(p_company_id);
  select coalesce(jsonb_agg(r.item order by r.period desc, r.tax, r.fine), '[]') into v_rows
    from (
      select t.period, t.tax, false as fine, jsonb_build_object(
               'kind', 'DECLARACION',
               'document', jsonb_build_object('id', d.id, 'display_number', d.display_number,
                                              'path', private.doc_path(d.id)),
               'tax', t.tax, 'period', t.period, 'due_date', t.due_date, 'transaction_code', t.transaction_code,
               'declared', d.total, 'balance_in_favor', t.balance_in_favor,
               'interest', x.interest, 'paid', x.paid,
               'imputed_on', case when d.status = 'PAGADA' then t.imputed_on end,
               'bank_transaction', case when d.status = 'PAGADA' and o.status = 'PROCESADO'
                                     then o.transaction_number end,
               'balance', d.total + x.interest - x.paid,
               'state', case when d.status = 'SIN_SALDO' then 'SIN_SALDO'
                             when d.status = 'PAGADA' then 'PAGADA'
                             when d.status = 'PAGO_EN_BANCO'
                               then case when o.status = 'RECHAZADO' then 'RECHAZADA' else 'EN_EL_BANCO' end
                             when v_today > t.due_date then 'VENCIDA'
                             else 'A_VENCER' end) as item
        from public.documents d
        join public.tax_returns t on t.document_id = d.id
        cross join lateral (
          select case when d.status = 'PRESENTADA' then private.tax_interest(d.total, t.due_date, v_today)
                      else t.interest end as interest,
                 case when d.status = 'PAGADA' then d.total + t.interest else 0 end as paid) x
        left join lateral (
          select m.status, m.transaction_number from public.bank_movements m
           where m.source_document_id = d.id and m.origin = 'ORDEN' and m.reverses_id is null
             and m.direction = 'DEBITO'
           order by m.seq
           limit 1) o on true
       where d.company_id = p_company_id and d.doc_type = 'TAX_RETURN'
         and d.status in ('PRESENTADA', 'SIN_SALDO', 'PAGO_EN_BANCO', 'PAGADA')
      union all
      select f.period, f.tax, true, jsonb_build_object(
               'kind', 'MULTA',
               'document', jsonb_build_object('id', d.id, 'display_number', d.display_number,
                                              'path', private.doc_path(d.id)),
               'tax', f.tax, 'period', f.period, 'due_date', f.reduction_until, 'transaction_code', null,
               'declared', y.declared, 'balance_in_favor', 0, 'interest', 0, 'paid', y.paid,
               'imputed_on', case when d.status = 'PAGADA' then f.imputed_on end,
               'bank_transaction', case when d.status = 'PAGADA' and o.status = 'PROCESADO'
                                     then o.transaction_number end,
               'balance', y.declared - y.paid,
               'state', case when d.status = 'PAGADA' then 'PAGADA'
                             when d.status = 'PAGO_EN_BANCO'
                               then case when o.status = 'RECHAZADO' then 'RECHAZADA' else 'EN_EL_BANCO' end
                             else 'A_PAGAR' end)
        from public.documents d
        join public.tax_fines f on f.document_id = d.id
        cross join lateral (
          select coalesce(f.paid_amount, case when v_today <= f.reduction_until then f.reduced_amount
                                              else f.amount end) as declared) z
        cross join lateral (
          select z.declared, case when d.status = 'PAGADA' then z.declared else 0 end as paid) y
        left join lateral (
          select m.status, m.transaction_number from public.bank_movements m
           where m.source_document_id = d.id and m.origin = 'ORDEN' and m.reverses_id is null
             and m.direction = 'DEBITO'
           order by m.seq
           limit 1) o on true
       where d.company_id = p_company_id and d.doc_type = 'TAX_FINE'
    ) r;
  return jsonb_build_object('date', v_today, 'rows', v_rows,
    'balance', coalesce((select sum((e ->> 'balance')::numeric) from jsonb_array_elements(v_rows) e), 0));
end;
$$;
