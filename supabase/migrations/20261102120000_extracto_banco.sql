-- 82. Fase 8a.2 (docs/FASE_8_BANCO_Y_FISCO.md §3): el extracto del Banco Aula de un período (el saldo
-- al empezar, lo procesado día por día con su número de transacción y el saldo final) y la
-- conciliación de la cuenta del banco contra ese extracto: su saldo ya no se escribe, es el del banco
-- a esa fecha, y la conciliación trae lo que el banco procesó desde la anterior para puntearlo.
-- Traducción de bankStatement y de reconciliationCandidates (queries.ts) y del control nuevo de
-- cmdCreateBankReconciliation (engine.ts). Sin catálogos nuevos: usa bank.read.

-- ------------------------------------------------------------------ Auxiliares

-- Lo procesado de una cuenta en el orden del extracto (el saldo inicial y después por número de
-- transacción), con el saldo después de cada movimiento (statementLines).
create function private.bank_statement_lines(p_account uuid)
returns table (id uuid, line_date date, transaction_number text, concept text, debit numeric, credit numeric,
               balance numeric, ord bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.processed_on, m.transaction_number, m.concept,
         case when m.direction = 'DEBITO' then m.amount else 0 end,
         case when m.direction = 'CREDITO' then m.amount else 0 end,
         sum(case when m.direction = 'CREDITO' then m.amount else -m.amount end)
           over (order by m.processed_on, m.transaction_number collate "C" nulls first
                 rows between unbounded preceding and current row),
         row_number() over (order by m.processed_on, m.transaction_number collate "C" nulls first)
    from public.bank_movements m
   where m.bank_account_id = p_account and m.status = 'PROCESADO'
$$;

-- Una línea del extracto (BankStatementLine).
create function private.bank_statement_line_json(p_id uuid, p_date date, p_transaction text, p_concept text,
                                                 p_debit numeric, p_credit numeric, p_balance numeric)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('id', p_id, 'date', p_date, 'transaction_number', p_transaction, 'concept', p_concept,
                            'debit', p_debit, 'credit', p_credit, 'balance', p_balance)
$$;

-- El saldo según el banco al cierre de un día: lo procesado hasta esa fecha (bankBalanceAt).
create function private.bank_balance_at(p_account uuid, p_date date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when m.direction = 'CREDITO' then m.amount else -m.amount end), 0)
    from public.bank_movements m
   where m.bank_account_id = p_account and m.status = 'PROCESADO' and m.processed_on <= p_date
$$;

-- El extracto del Banco Aula para conciliar una cuenta contable: el saldo a la fecha y lo procesado
-- después de la conciliación anterior; null si la cuenta no es la de un banco del Banco Aula
-- (bankStatementSince).
create function private.bank_statement_since(p_ledger uuid, p_since date, p_up_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bank uuid;
begin
  select b.id into v_bank from public.bank_accounts b where b.ledger_account_id = p_ledger and b.is_active
   order by b.created_at limit 1;
  if v_bank is null then
    return null;
  end if;
  return jsonb_build_object(
    'balance', coalesce((select l.balance from private.bank_statement_lines(v_bank) l
                          where l.line_date <= p_up_to order by l.ord desc limit 1), 0),
    'lines', coalesce((
      select jsonb_agg(private.bank_statement_line_json(l.id, l.line_date, l.transaction_number, l.concept, l.debit,
                                                        l.credit, l.balance) order by l.ord)
        from private.bank_statement_lines(v_bank) l
       where l.line_date <= p_up_to and (p_since is null or l.line_date > p_since)), '[]'::jsonb));
end;
$$;

-- ------------------------------------------------------------------ Lecturas

-- El extracto de un período: el saldo al empezar, lo que el banco procesó día por día y el saldo
-- final; null si la empresa no tiene cuenta (bankStatement).
create function public.bank_statement(p_company_id uuid, p_from text, p_to text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date;
  v_to date;
  v_account public.bank_accounts;
  v_company public.companies;
  v_opening numeric;
begin
  perform private.require_read(p_company_id, 'bank.read');
  v_from := private.parse_date(p_from);
  v_to := private.parse_date(p_to);
  if v_from is null or v_to is null or v_from > v_to then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá el período del extracto: desde y hasta, en ese orden.');
  end if;
  select * into v_account from public.bank_accounts b where b.company_id = p_company_id and b.is_active
   order by b.created_at limit 1;
  if not found then
    return null;
  end if;
  select * into v_company from public.companies c where c.id = p_company_id;
  v_opening := coalesce((select l.balance from private.bank_statement_lines(v_account.id) l
                          where l.line_date < v_from order by l.ord desc limit 1), 0);
  return (
    select jsonb_build_object(
      'holder', jsonb_build_object('legal_name', v_company.legal_name, 'tax_id', v_company.tax_id),
      'account', jsonb_build_object('number', v_account.number, 'bank_key', v_account.bank_key, 'alias', v_account.alias),
      'from', v_from,
      'to', v_to,
      'opening_balance', v_opening,
      'lines', coalesce(jsonb_agg(private.bank_statement_line_json(l.id, l.line_date, l.transaction_number, l.concept,
                                                                   l.debit, l.credit, l.balance) order by l.ord), '[]'::jsonb),
      'debits', coalesce(sum(l.debit), 0),
      'credits', coalesce(sum(l.credit), 0),
      'closing_balance', coalesce((array_agg(l.balance order by l.ord desc))[1], v_opening))
      from private.bank_statement_lines(v_account.id) l
     where l.line_date between v_from and v_to);
end;
$$;

grant execute on function public.bank_statement(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------ Funciones que cambian

-- Igual que antes, y además, en la cuenta de un banco del Banco Aula, el saldo del extracto tiene que ser
-- el del banco a esa fecha (cmdCreateBankReconciliation).
create or replace function public.br_create(p_company_id uuid, p_input jsonb)
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
  v_bank uuid;
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
  -- Con el Banco Aula (Fase 8a.2), el extracto no se escribe: es el del banco a esa fecha.
  select b.id into v_bank from public.bank_accounts b where b.ledger_account_id = v_account.id and b.is_active
   order by b.created_at limit 1;
  if v_bank is not null and private.bank_balance_at(v_bank, v_date) <> v_balance then
    perform private.raise_business_error('DATO_INVALIDO',
      format('El saldo del extracto del Banco Aula al %s es %s: es el que se concilia.', to_char(v_date, 'DD/MM/YYYY'),
             private.format_money(private.bank_balance_at(v_bank, v_date))));
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

-- Igual que antes, y además el extracto del Banco Aula cuando la cuenta es la de un banco (reconciliationCandidates).
create or replace function public.reconciliation_candidates(p_company_id uuid, p_account_id uuid, p_statement_date text)
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
       where l.line_id not in (select private.reconciled_lines(v_account.id))), '[]'::jsonb),
    'bank', private.bank_statement_since(v_account.id,
      (select r.statement_date from public.bank_reconciliations r where r.document_id = v_last.id), v_date)
  );
end;
$$;
