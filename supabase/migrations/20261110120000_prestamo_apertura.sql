-- 92. Fase 8c.2 (docs/FASE_8_BANCO_Y_FISCO.md §3): el préstamo de la apertura. El saldo de Préstamos
-- bancarios del asiento de apertura pasa a ser un préstamo del Banco Aula (24 cuotas al 48 % anual, a
-- validar), vigente desde la apertura y sin acreditación (el dinero ya está en el saldo inicial). Sus
-- cuotas vencen desde el mes siguiente a que la cuenta empezó a operar en la app: como con los cargos,
-- lo de antes no se cobra. Lo recibe toda cuenta que se abre; las empresas que ya existían, en la
-- migración siguiente. Traducción de openBankLoan de engine.ts (8c.2).

alter table public.bank_loans add column opening boolean not null default false;

-- El préstamo que la empresa ya tenía al abrir la cuenta. No hace nada si ya lo tiene o si la apertura
-- no tiene saldo en Préstamos bancarios (openBankLoan).
create function private.bank_open_loan(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.bank_accounts;
  v_amount numeric;
  v_loan uuid;
begin
  select * into v_account from public.bank_accounts b where b.company_id = p_company and b.is_active
   order by b.created_at limit 1;
  if not found or exists (select 1 from public.bank_loans l where l.company_id = p_company and l.opening) then
    return;
  end if;
  select coalesce(sum(l.credit - l.debit), 0) into v_amount
    from public.journal_entry_lines l
    join public.journal_entries je on je.document_id = l.document_id
     and je.entry_number is not null and je.origin = 'APERTURA'
    join public.accounts a on a.id = l.account_id
   where a.company_id = p_company and a.code = '2.1.02.01';
  if v_amount <= 0 then
    return;
  end if;
  insert into public.bank_loans (company_id, bank_account_id, number, amount, months, purpose, status, requested_on,
                                 rate, granted_on, opening)
  values (p_company, v_account.id,
          coalesce((select max(l.number) from public.bank_loans l where l.bank_account_id = v_account.id), 0) + 1,
          v_amount, 24,
          'El préstamo que la empresa ya tenía al abrir la cuenta: el saldo inicial de Préstamos bancarios',
          'VIGENTE', v_account.opened_on, 48, v_account.opened_on, true)
  returning id into v_loan;
  insert into public.bank_loan_installments (company_id, loan_id, n, due_on, principal, interest)
  select p_company, v_loan, s.n, s.due_on, s.principal, s.interest
    from private.bank_loan_schedule(v_amount, 48, 24, v_account.charges_from) s;
end;
$$;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, y además la cuenta nueva recibe el préstamo de la apertura (openBankAccount).
create or replace function private.bank_open_account(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger public.accounts;
  v_opened date;
  v_open_line uuid;
  v_balance numeric;
  v_account public.bank_accounts;
  v_row public.bank_movements;
  v_r record;
  v_original uuid;
  v_order public.bank_movements;
begin
  if exists (select 1 from public.bank_accounts b where b.company_id = p_company) then
    return;
  end if;
  select * into v_ledger from public.accounts a where a.company_id = p_company and a.code = '1.1.01.03';
  if not found then
    return;
  end if;
  select d.document_date, l.id into v_opened, v_open_line
    from public.journal_entry_lines l
    join public.documents d on d.id = l.document_id
    join public.journal_entries je on je.document_id = d.id
   where l.account_id = v_ledger.id and je.entry_number is not null and je.origin = 'APERTURA'
   order by d.document_date, je.entry_number, l.line_no
   limit 1;
  select coalesce(sum(l.debit - l.credit), 0) into v_balance
    from public.journal_entry_lines l join public.journal_entries je on je.document_id = l.document_id
   where l.account_id = v_ledger.id and je.entry_number is not null and je.origin = 'APERTURA';
  v_opened := coalesce(v_opened,
    (select min(y.start_date) from public.fiscal_years y where y.company_id = p_company),
    private.business_date(p_company));
  insert into public.bank_accounts (company_id, ledger_account_id, number, bank_key, alias, opened_on, overdraft_limit,
                                    charges_from)
  values (p_company, v_ledger.id, 'CC 0001-000001', 'SIM0001000000000017',
          private.bank_alias((select c.slug from public.companies c where c.id = p_company)), v_opened, 1000000,
          date_trunc('month', private.business_date(p_company))::date)
  returning * into v_account;
  v_row := private.bank_add_movement(v_account, 'APERTURA', case when v_balance < 0 then 'DEBITO' else 'CREDITO' end,
    abs(v_balance), 'Saldo inicial de la cuenta', null, v_open_line, null, v_opened, null);
  -- El saldo inicial no es una transacción: no lleva número.
  update public.bank_movements set status = 'PROCESADO', processed_on = v_opened where id = v_row.id;
  for v_r in
    select l.*, d.document_date, je.origin, je.reverses_id, je.description
      from public.journal_entry_lines l
      join public.documents d on d.id = l.document_id
      join public.journal_entries je on je.document_id = d.id
     where l.account_id = v_ledger.id and je.entry_number is not null and je.origin <> 'APERTURA'
     order by d.document_date, je.entry_number, l.line_no
  loop
    if v_r.origin <> 'CONTRAASIENTO' then
      v_row := private.bank_add_movement(v_account, 'ORDEN',
        case when v_r.debit > 0 then 'CREDITO' else 'DEBITO' end,
        case when v_r.debit > 0 then v_r.debit else v_r.credit end,
        regexp_replace(v_r.description, '\.$', ''), private.bank_entry_source(v_r.document_id), v_r.id, null,
        v_r.document_date, null);
      perform private.bank_process_movement(v_row.id, v_r.document_date, null);
      continue;
    end if;
    select l.id into v_original from public.journal_entry_lines l
     where l.document_id = v_r.reverses_id and l.account_id = v_r.account_id
       and l.debit = v_r.credit and l.credit = v_r.debit
     order by l.line_no limit 1;
    select * into v_order from public.bank_movements m where m.journal_line_id = v_original and m.reverses_id is null;
    continue when not found;
    v_row := private.bank_add_movement(v_account, 'ORDEN',
      case when v_order.direction = 'CREDITO' then 'DEBITO' else 'CREDITO' end, v_order.amount,
      'Reversión de ' || v_order.transaction_number || ': ' || v_order.concept,
      v_order.source_document_id, v_r.id, v_order.id, v_r.document_date, null);
    perform private.bank_process_movement(v_row.id, v_r.document_date, null);
  end loop;
  perform private.bank_open_loan(p_company);
end;
$$;

-- Igual que antes, y además si es el préstamo de la apertura (bankLoans).
create or replace function public.bank_loans(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  perform private.require_read(p_company_id, 'bank.read');
  v_today := private.business_date(p_company_id);
  return jsonb_build_object(
    'loans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'number', l.number, 'amount', l.amount, 'months', l.months, 'purpose', l.purpose,
        'status', l.status, 'requested_on', l.requested_on,
        'requested_by_name', case when l.requested_by is not null then private.full_name(l.requested_by) end,
        'own', coalesce(l.requested_by = (select auth.uid()), false),
        'liquidity', l.liquidity, 'debt_ratio', l.debt_ratio, 'sales_share', l.sales_share, 'rate', l.rate,
        'evaluated_by_name', case when l.evaluated_by is not null then private.full_name(l.evaluated_by) end,
        'evaluated_on', l.evaluated_on, 'rejection_reason', l.rejection_reason, 'granted_on', l.granted_on,
        'opening', l.opening,
        'outstanding', coalesce((select sum(i.principal) from public.bank_loan_installments i
                                  where i.loan_id = l.id and i.status = 'PENDIENTE'), 0),
        'installments', coalesce((
          select jsonb_agg(jsonb_build_object(
            'n', i.n, 'due_on', i.due_on, 'principal', i.principal, 'interest', i.interest,
            'total', i.principal + i.interest, 'status', i.status, 'debited_on', i.debited_on,
            'due', l.status = 'VIGENTE' and i.status = 'PENDIENTE' and i.due_on <= v_today) order by i.n)
            from public.bank_loan_installments i where i.loan_id = l.id), '[]'::jsonb))
        order by l.number desc)
        from public.bank_loans l where l.company_id = p_company_id), '[]'::jsonb),
    'reference_rate', 48,
    'max_amount', 50000000,
    'terms', jsonb_build_array(6, 12, 18, 24));
end;
$$;
