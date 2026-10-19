-- 29. Fase 3d.2 (docs/FASE_3_COMPRAS_Y_TESORERIA.md §7): medio de pago de las
-- órdenes de pago (cheques propios), cheques emitidos y conciliación bancaria
-- simplificada. Traducción de cmdPayPaymentOrder (con su medio de pago) y de la
-- sección "Conciliación bancaria" de src/lib/mock/engine.ts, y de sus lecturas
-- en queries.ts, con los mismos mensajes y la misma forma de datos.
--
-- El tipo de documento, sus estados, su transición y sus permisos están en la
-- migración de catálogos siguiente.

-- ------------------------------------------------------------------ Medio de pago

alter table public.payment_orders
  add column payment_method text check (payment_method in ('TRANSFERENCIA', 'CHEQUE', 'EFECTIVO'));
-- Las órdenes ya pagadas se toman como pagadas por transferencia.
update public.payment_orders set payment_method = 'TRANSFERENCIA' where paid_on is not null;

-- ------------------------------------------------------------------ Tablas

-- Conciliación bancaria: 1 a 1 con documents (tipo BANK_RECONCILIATION). Los
-- importes calculados se guardan como quedaron al confirmarla.
create table public.bank_reconciliations (
  document_id uuid primary key,
  doc_type text not null default 'BANK_RECONCILIATION' check (doc_type = 'BANK_RECONCILIATION'),
  company_id uuid not null,
  account_id uuid not null,               -- el banco (cuenta del rubro Caja y bancos)
  statement_date date not null,           -- fecha del extracto
  statement_balance numeric(14, 2) not null, -- saldo según el extracto
  book_balance numeric(14, 2) not null,   -- saldo según libros a esa fecha
  pending_debits numeric(14, 2) not null, -- entradas que el banco todavía no acreditó
  pending_credits numeric(14, 2) not null, -- pagos que el banco todavía no debitó
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, account_id) references public.accounts (company_id, id)
);
create index bank_reconciliations_account_idx on public.bank_reconciliations (account_id);

-- Los movimientos del mayor que figuraban en el extracto.
create table public.bank_reconciliation_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  journal_line_id uuid not null,
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.bank_reconciliations (company_id, document_id) on delete cascade,
  foreign key (company_id, journal_line_id) references public.journal_entry_lines (company_id, id)
);
create index bank_reconciliation_lines_line_idx on public.bank_reconciliation_lines (journal_line_id);

do $$
declare
  t text;
begin
  foreach t in array array['bank_reconciliations', 'bank_reconciliation_lines'] loop
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

create policy bank_reconciliations_select on public.bank_reconciliations for select to authenticated
  using (company_id in (select private.companies_with_permission('bank_reconciliation.read')));
create policy bank_reconciliation_lines_select on public.bank_reconciliation_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('bank_reconciliation.read')));

-- ------------------------------------------------------------------ Pagar con su medio

-- Igual que antes, y además el medio de pago: con cheque, la referencia es su
-- número (obligatorio). La firma cambia: se reemplaza la función (cmdPayPaymentOrder).
drop function public.op_pay(uuid, text);

create function public.op_pay(p_document_id uuid, p_reference text, p_method text default 'TRANSFERENCIA')
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
  v_phrase text;
  v_noun text;
  v_number text;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYMENT_ORDER');
  perform private.require_transition(v_doc, 'PAY');
  v_actor := private.require_permission(v_doc.company_id, 'payment_order.pay');
  if length(v_ref) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'La referencia del pago tiene hasta 60 caracteres.');
  end if;
  if p_method is null or p_method not in ('TRANSFERENCIA', 'CHEQUE', 'EFECTIVO') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el medio de pago: transferencia, cheque o efectivo.');
  end if;
  if p_method = 'CHEQUE' and v_ref !~ '^\d{1,8}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá el número del cheque (hasta 8 números).',
      'Queda en el registro de cheques emitidos.');
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
  v_phrase := case p_method when 'CHEQUE' then 'con cheque' when 'EFECTIVO' then 'en efectivo' else 'por transferencia' end;
  v_noun := case p_method when 'CHEQUE' then 'cheque' when 'EFECTIVO' then 'efectivo' else 'transferencia' end;
  v_number := case when v_ref <> '' then ' N.º ' || v_ref else '' end;
  perform private.transition_document(v_doc.id, 'PAY', p_actor => v_actor,
    p_summary => format('Pagó %s %s%s: %s a %s desde %s %s', v_doc.display_number, v_phrase, v_number,
                        private.format_money(v_doc.total), v_supplier.legal_name, v_account.code, v_account.name));
  update public.payment_orders
     set payment_reference = v_ref, paid_on = private.business_date(v_doc.company_id), payment_method = p_method
   where document_id = v_doc.id;
  select * into v_doc from public.documents d where d.id = v_doc.id;
  perform private.post_event(v_actor, v_doc, 'PAGO',
    format('Pago a %s según %s (%s%s).', v_supplier.legal_name, v_doc.display_number, v_noun, v_number),
    jsonb_build_array(
      jsonb_build_object('key', 'PROVEEDORES', 'debit', v_doc.total, 'credit', 0),
      jsonb_build_object('account_id', v_account.id, 'debit', 0, 'credit', v_doc.total)));
  for v_line in select * from public.payment_order_lines l where l.document_id = v_doc.id order by l.line_no loop
    perform private.recompute_invoice(v_line.invoice_id);
  end loop;
end;
$$;

grant execute on function public.op_pay(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------ Conciliación: auxiliares

-- Movimientos conciliados por las conciliaciones confirmadas de una cuenta, hasta una (reconciledLineIds).
create function private.reconciled_lines(p_account uuid, p_up_to_number int default null)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select l.journal_line_id
    from public.bank_reconciliation_lines l
    join public.bank_reconciliations r on r.document_id = l.document_id
    join public.documents d on d.id = r.document_id
   where r.account_id = p_account and d.status = 'CONFIRMADA' and (p_up_to_number is null or d.number <= p_up_to_number)
$$;

-- La última conciliación confirmada de una cuenta (lastReconciliation).
create function private.last_reconciliation(p_account uuid)
returns public.documents
language sql
stable
security definer
set search_path = ''
as $$
  select d.* from public.bank_reconciliations r join public.documents d on d.id = r.document_id
   where r.account_id = p_account and d.status = 'CONFIRMADA'
   order by d.number desc
   limit 1
$$;

-- Movimientos de una cuenta en asientos registrados hasta una fecha (accountLinesUpTo), como filas para conciliar.
create function private.account_lines_up_to(p_account uuid, p_up_to date)
returns table (line_id uuid, document_id uuid, display_number text, entry_number int, document_date date,
               line_no int, description text, debit numeric, credit numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, d.id, d.display_number, je.entry_number, d.document_date, l.line_no,
         coalesce(nullif(l.notes, ''), je.description), l.debit, l.credit
    from public.journal_entry_lines l
    join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
    join public.documents d on d.id = l.document_id
   where l.account_id = p_account and d.document_date <= p_up_to
$$;

-- Un movimiento para conciliar, como lo muestra la interfaz (ReconciliationLineView).
create function private.reconciliation_line_json(p_line_id uuid, p_document_id uuid, p_display_number text,
                                                 p_entry_number int, p_date date, p_description text,
                                                 p_debit numeric, p_credit numeric)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'line_id', p_line_id, 'document_id', p_document_id, 'display_number', p_display_number,
    'path', private.doc_path(p_document_id), 'entry_number', p_entry_number, 'date', p_date,
    'description', p_description, 'debit', p_debit, 'credit', p_credit)
$$;

-- ------------------------------------------------------------------ Conciliación: comandos

-- p_input: {account_id, statement_date, statement_balance, journal_line_ids, notes} (cmdCreateBankReconciliation)
create function public.br_create(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'bank_reconciliation.create');
  v_account public.accounts;
  v_date date;
  v_last public.documents;
  v_balance numeric;
  v_marked uuid[] := '{}';
  v_id text;
  v_line uuid;
  v_book numeric;
  v_pending_debits numeric;
  v_pending_credits numeric;
  v_expected numeric;
  v_number record;
  v_doc public.documents;
  v_count int;
begin
  select * into v_account from public.accounts a where a.company_id = p_company_id and a.id::text = p_input ->> 'account_id';
  if not found or not v_account.is_imputable or not starts_with(v_account.code, private.treasury_rubro() || '.') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el banco que se concilia (una cuenta de Caja y bancos).');
  end if;
  v_date := private.parse_date(p_input ->> 'statement_date');
  if v_date is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá la fecha del extracto.');
  end if;
  if v_date > private.business_date(p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha del extracto no puede ser posterior a hoy.');
  end if;
  v_last := private.last_reconciliation(v_account.id);
  if v_last.id is not null and v_date <= (select r.statement_date from public.bank_reconciliations r where r.document_id = v_last.id) then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La fecha del extracto tiene que ser posterior a la de la última conciliación de la cuenta (%s, al %s).',
             v_last.display_number,
             (select to_char(r.statement_date, 'DD/MM/YYYY') from public.bank_reconciliations r where r.document_id = v_last.id)));
  end if;
  v_balance := (p_input ->> 'statement_balance')::numeric;
  if v_balance is null or round(v_balance, 2) <> v_balance then
    perform private.raise_business_error('DATO_INVALIDO', 'El saldo del extracto es un importe con hasta 2 decimales.');
  end if;
  for v_id in
    select x.id from jsonb_array_elements_text(coalesce(p_input -> 'journal_line_ids', '[]')) with ordinality as x (id, ord)
     order by x.ord
  loop
    select l.line_id into v_line
      from private.account_lines_up_to(v_account.id, v_date) l
     where l.line_id::text = v_id and l.line_id not in (select private.reconciled_lines(v_account.id));
    if v_line is not null and v_line = any (v_marked) then
      perform private.raise_business_error('DATO_INVALIDO', 'Un movimiento está dos veces en la conciliación.');
    end if;
    if v_line is null then
      perform private.raise_business_error('DATO_INVALIDO',
        'Uno de los movimientos marcados no es de esta cuenta, es posterior al extracto o ya está conciliado.');
    end if;
    v_marked := v_marked || v_line;
  end loop;
  select coalesce(sum(l.debit - l.credit), 0),
         coalesce(sum(l.debit) filter (where l.line_id not in (select private.reconciled_lines(v_account.id)) and not l.line_id = any (v_marked)), 0),
         coalesce(sum(l.credit) filter (where l.line_id not in (select private.reconciled_lines(v_account.id)) and not l.line_id = any (v_marked)), 0)
    into v_book, v_pending_debits, v_pending_credits
    from private.account_lines_up_to(v_account.id, v_date) l;
  v_expected := v_book - v_pending_debits + v_pending_credits;
  if v_expected <> v_balance then
    perform private.raise_business_error('CONCILIACION_NO_CIERRA',
      format('No cierra: según libros, sin lo pendiente, el extracto tendría que decir %s y dice %s (diferencia de %s).',
             private.format_money(v_expected), private.format_money(v_balance), private.format_money(v_balance - v_expected)),
      'Revisá qué movimientos figuran en el extracto. Si el banco registró algo que no está en los libros (comisiones, intereses), Contabilidad lo registra con un asiento y vuelve a conciliar.');
  end if;

  -- La conciliación nace confirmada: no tiene borrador.
  select * into v_number from private.next_document_number(p_company_id, 'BANK_RECONCILIATION');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, notes, created_by)
  values (p_company_id, 'BANK_RECONCILIATION', v_number.number, v_number.display_number, 'CONFIRMADA',
          private.business_date(p_company_id), (v_actor).sector_id, trim(coalesce(p_input ->> 'notes', '')), (v_actor).user_id)
  returning * into v_doc;
  insert into public.bank_reconciliations (document_id, company_id, account_id, statement_date, statement_balance,
                                           book_balance, pending_debits, pending_credits)
  values (v_doc.id, p_company_id, v_account.id, v_date, v_balance, v_book, v_pending_debits, v_pending_credits);
  insert into public.bank_reconciliation_lines (company_id, document_id, line_no, journal_line_id)
  select p_company_id, v_doc.id, row_number() over (order by l.document_date, l.entry_number, l.line_no), l.line_id
    from private.account_lines_up_to(v_account.id, v_date) l
   where l.line_id = any (v_marked);
  v_count := coalesce(array_length(v_marked, 1), 0);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'bank_reconciliation', v_doc.id, v_doc.display_number,
    format('Concilió %s %s al %s con %s: %s movimiento%s en el extracto, saldo %s', v_account.code, v_account.name,
           to_char(v_date, 'DD/MM/YYYY'), v_doc.display_number, v_count, case when v_count = 1 then '' else 's' end,
           private.format_money(v_balance)),
    v_doc.id, null, 'CONFIRMADA');
  return private.created_result(v_doc.id);
end;
$$;

-- Anular una conciliación deja sus movimientos pendientes otra vez: sólo la última de cada cuenta (cmdCancelBankReconciliation).
create function public.br_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_last public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'BANK_RECONCILIATION');
  perform private.require_permission(v_doc.company_id, 'bank_reconciliation.cancel');
  v_last := private.last_reconciliation((select r.account_id from public.bank_reconciliations r where r.document_id = v_doc.id));
  if v_doc.status = 'CONFIRMADA' and v_last.id is not null and v_last.id <> v_doc.id then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('Sólo se anula la última conciliación de la cuenta (%s).', v_last.display_number));
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
end;
$$;

grant execute on function public.br_create(uuid, jsonb) to authenticated;
grant execute on function public.br_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- Lo que hace falta para conciliar un banco a una fecha; null si la cuenta no es una caja o un banco (reconciliationCandidates).
create function public.reconciliation_candidates(p_company_id uuid, p_account_id uuid, p_statement_date text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_date date;
  v_account public.accounts;
  v_last public.documents;
begin
  perform private.require_read(p_company_id, 'bank_reconciliation.create');
  v_date := private.parse_date(p_statement_date);
  if v_date is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá la fecha del extracto.');
  end if;
  select * into v_account from public.accounts a
   where a.company_id = p_company_id and a.id = p_account_id and a.is_imputable
     and starts_with(a.code, private.treasury_rubro() || '.');
  if not found then
    return null;
  end if;
  v_last := private.last_reconciliation(v_account.id);
  return jsonb_build_object(
    'account', jsonb_build_object('id', v_account.id, 'code', v_account.code, 'name', v_account.name),
    'last', case when v_last.id is not null then (
      select jsonb_build_object('display_number', v_last.display_number, 'path', private.doc_path(v_last.id),
                                'statement_date', r.statement_date, 'statement_balance', r.statement_balance)
        from public.bank_reconciliations r where r.document_id = v_last.id) end,
    'book_balance', (select coalesce(sum(l.debit - l.credit), 0) from private.account_lines_up_to(v_account.id, v_date) l),
    'lines', coalesce((
      select jsonb_agg(private.reconciliation_line_json(l.line_id, l.document_id, l.display_number, l.entry_number,
                                                        l.document_date, l.description, l.debit, l.credit)
             order by l.document_date, l.entry_number, l.line_no)
        from private.account_lines_up_to(v_account.id, v_date) l
       where l.line_id not in (select private.reconciled_lines(v_account.id))), '[]'::jsonb)
  );
end;
$$;

-- Cheques emitidos: los pagos con cheque, con su estado según las conciliaciones (issuedCheques).
create function public.issued_cheques(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'treasury.read');
  return coalesce((
    with cheques as (
      select d.*, po.payment_reference, po.paid_on, po.treasury_account_id,
             (select r.id
                from public.document_links k
                join public.documents je on je.id = k.to_document_id
                join public.journal_entries x on x.document_id = je.id and x.origin = 'AUTOMATICO'
                join public.journal_entry_lines l on l.document_id = je.id and l.account_id = po.treasury_account_id and l.credit > 0
                join public.bank_reconciliation_lines bl on bl.journal_line_id = l.id
                join public.documents r on r.id = bl.document_id and r.status = 'CONFIRMADA'
               where k.from_document_id = d.id
               limit 1) as reconciliation_id
        from public.documents d join public.payment_orders po on po.document_id = d.id
       where d.company_id = p_company_id and d.doc_type = 'PAYMENT_ORDER' and po.payment_method = 'CHEQUE'
         and d.status in ('PAGADA', 'ANULADA')
    )
    select jsonb_agg(jsonb_build_object(
             'payment', private.doc_ref(c.id),
             'number', c.payment_reference,
             'date', c.paid_on,
             'supplier_name', coalesce((select s.legal_name from public.suppliers s where s.id = c.supplier_id), ''),
             'account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name)
                           from public.accounts a where a.id = c.treasury_account_id),
             'amount', c.total,
             'status', case when c.status = 'ANULADA' then 'ANULADO' when c.reconciliation_id is not null then 'DEBITADO' else 'PENDIENTE' end,
             'reconciliation', case when c.status <> 'ANULADA' and c.reconciliation_id is not null then private.doc_ref(c.reconciliation_id) end)
           order by c.paid_on, c.number)
      from cheques c
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.reconciliation_candidates(uuid, uuid, text) to authenticated;
grant execute on function public.issued_cheques(uuid) to authenticated;

-- Conciliación: el extracto contra el mayor, y lo pendiente a su fecha (reconciliationView).
create function private.reconciliation_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with r as (
    select x.* from public.bank_reconciliations x where x.document_id = p_doc.id
  ),
  own as (
    select l.journal_line_id as id from public.bank_reconciliation_lines l where l.document_id = p_doc.id
  ),
  before as (
    select id from r, private.reconciled_lines(r.account_id, p_doc.number - 1) as id
  ),
  lines as (
    select l.* from r, private.account_lines_up_to(r.account_id, r.statement_date) l
  )
  select jsonb_build_object(
    'account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name) from public.accounts a, r where a.id = r.account_id),
    'statement_date', r.statement_date,
    'statement_balance', r.statement_balance,
    'book_balance', r.book_balance,
    'pending_debits', r.pending_debits,
    'pending_credits', r.pending_credits,
    'reconciled', coalesce((
      select jsonb_agg(private.reconciliation_line_json(l.line_id, l.document_id, l.display_number, l.entry_number,
                                                        l.document_date, l.description, l.debit, l.credit)
             order by l.document_date, l.entry_number, l.line_no)
        from lines l where l.line_id in (select o.id from own o)), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(private.reconciliation_line_json(l.line_id, l.document_id, l.display_number, l.entry_number,
                                                        l.document_date, l.description, l.debit, l.credit)
             order by l.document_date, l.entry_number, l.line_no)
        from lines l
       where l.line_id not in (select o.id from own o) and l.line_id not in (select b.id from before b)), '[]'::jsonb))
    from r
$$;

-- ------------------------------------------------------------------ Documentos: medio de pago y conciliación en las lecturas comunes

create or replace function private.payment_view(p_doc public.documents)
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
    'payment_method', po.payment_method,
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
$$;

-- Igual que antes; el resumen de una conciliación es su banco y la fecha del extracto.
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

-- Igual que antes; sólo se anula la última conciliación de cada cuenta.
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
    if p_doc.doc_type = 'BANK_RECONCILIATION' and v_tr.action = 'CANCEL' then
      v_last := private.last_reconciliation((select r.account_id from public.bank_reconciliations r where r.document_id = p_doc.id));
      if v_last.id is not null and v_last.id <> p_doc.id then
        v_reason := format('Sólo se anula la última conciliación de la cuenta (%s).', v_last.display_number);
      end if;
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'action', v_tr.action, 'label', v_tr.label, 'help', v_tr.help_text, 'tone', v_tr.tone,
      'requires_comment', v_tr.requires_comment, 'enabled', v_reason is null, 'reason', v_reason));
  end loop;
  return v_result;
end;
$$;

-- Igual que antes, con la conciliación bancaria (nextStep).
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

-- Igual que antes, con la conciliación bancaria: su vista, su lugar en el flujo y sus firmas.
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
    'reconciliation', case when p_doc.doc_type = 'BANK_RECONCILIATION' then private.reconciliation_view(p_doc) end,
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
                              'SUPPLIER_INVOICE', 'PAYMENT_ORDER', 'FUNDS_TRANSFER', 'BANK_RECONCILIATION', 'STOCK_ADJUSTMENT',
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;
