-- 83. Fase 8b.1 (docs/FASE_8_BANCO_Y_FISCO.md §3): los cargos del mes del Banco Aula. Quien opera el
-- banco (Tesorería o el docente) cierra cada mes terminado, en orden y desde que la cuenta opera en la
-- app: el banco debita, con la fecha del cierre, la comisión de mantenimiento, el impuesto a los
-- débitos y créditos (0,6 % de lo que movieron las órdenes del mes) y los intereses por descubierto
-- (tasa mensual sobre el saldo negativo de cada día, mes de 30 días). Contabilidad los registra
-- desde la conciliación con un asiento automático que no le manda una orden al banco; si lo anula,
-- vuelven a quedar sin registrar. Traducción de la sección "Banco Aula" de engine.ts (8b.1).
--
-- Las claves de la imputación están en la migración de catálogos siguiente; las reglas, en la de
-- la plantilla; las empresas que ya existían las reciben en la última de esta fase.

-- ------------------------------------------------------------------ Tablas

alter table public.bank_accounts
  add column monthly_fee numeric(14, 2) not null default 15000 check (monthly_fee >= 0),
  add column overdraft_rate numeric(6, 3) not null default 6 check (overdraft_rate >= 0),
  add column charges_from date not null
    default (date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires'))::date;

-- Una cuenta que ya existía cobra desde el mes de hoy (de la fecha de la empresa): los de antes no pagan.
update public.bank_accounts b set charges_from = date_trunc('month', private.business_date(b.company_id))::date;

alter table public.bank_movements
  add column charge text check (charge in ('COMISION', 'IMPUESTO_DC', 'INTERESES', 'RECHAZO'));

-- El cierre de un mes: lo que el banco debitó por la cuenta.
create table public.bank_closings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  bank_account_id uuid not null,
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  closed_on date not null,
  closed_by uuid,
  fee numeric(14, 2) not null,
  tax numeric(14, 2) not null,
  interest numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  unique (bank_account_id, period),
  foreign key (company_id, bank_account_id) references public.bank_accounts (company_id, id) on delete cascade
);

alter table public.bank_closings enable row level security;
revoke all on table public.bank_closings from anon, authenticated;
grant select on table public.bank_closings to authenticated;
create policy bank_closings_select on public.bank_closings for select to authenticated
  using (company_id in (select private.companies_with_permission('bank.read')));

-- ------------------------------------------------------------------ Auxiliares

-- "2026-10" → "10/2026" (periodLabel).
create function private.bank_period_label(p_period text)
returns text
language sql
immutable
set search_path = ''
as $$ select substr(p_period, 6, 2) || '/' || substr(p_period, 1, 4) $$;

-- El mes que el banco tiene que cerrar: el más viejo que ya terminó y no se cerró, desde que la
-- cuenta opera en la app; null si no hay ninguno (bankMonthToClose).
create function private.bank_month_to_close(p_account public.bank_accounts, p_today date)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select to_char(p.month, 'YYYY-MM')
    from generate_series(date_trunc('month', p_account.charges_from::timestamp),
                         date_trunc('month', p_today::timestamp) - interval '1 month', interval '1 month') as p (month)
   where not exists (select 1 from public.bank_closings c
                      where c.bank_account_id = p_account.id and c.period = to_char(p.month, 'YYYY-MM'))
   order by p.month
   limit 1
$$;

-- Los cargos de un mes: la comisión, el impuesto sobre lo que movieron las órdenes y los intereses
-- por el descubierto de cada día (monthCharges).
create function private.bank_month_charges(p_account public.bank_accounts, p_period text)
returns table (fee numeric, tax numeric, interest numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select to_date(p_period || '-01', 'YYYY-MM-DD') as d_from,
           (to_date(p_period || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date as d_to
  ),
  balances as (
    select (select coalesce(sum(case when m.direction = 'CREDITO' then m.amount else -m.amount end), 0)
              from public.bank_movements m
             where m.bank_account_id = p_account.id and m.status = 'PROCESADO' and m.processed_on <= d.day::date) as balance
      from bounds b, generate_series(b.d_from::timestamp, b.d_to::timestamp, interval '1 day') as d (day)
  )
  select p_account.monthly_fee,
         round(coalesce((select sum(m.amount) from public.bank_movements m, bounds b
                          where m.bank_account_id = p_account.id and m.status = 'PROCESADO' and m.origin = 'ORDEN'
                            and m.processed_on between b.d_from and b.d_to), 0) * 0.6 / 100, 2),
         round(coalesce((select sum(-x.balance) from balances x where x.balance < 0), 0) * p_account.overdraft_rate / 3000, 2)
$$;

-- Mientras haya cargos del banco sin registrar, Contabilidad tiene una tarea abierta para
-- registrarlos (syncChargesTask).
create function private.bank_sync_charges_task(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open uuid;
  v_task uuid;
begin
  select t.id into v_open from public.tasks t
   where t.company_id = p_company and t.task_type = 'REGISTRAR_CARGOS_BANCO' and t.status in ('PENDIENTE', 'EN_CURSO')
   order by t.created_at limit 1;
  if not exists (select 1 from public.bank_movements m
                  where m.company_id = p_company and m.origin = 'BANCO' and m.status = 'PROCESADO'
                    and m.journal_line_id is null) then
    if v_open is not null then
      update public.tasks set status = 'RESUELTA', completed_by = (select auth.uid()), completed_at = now()
       where id = v_open;
    end if;
    return;
  end if;
  if v_open is not null then
    return;
  end if;
  insert into public.tasks (company_id, task_type, title, description, context, assigned_role, priority)
  values (p_company, 'REGISTRAR_CARGOS_BANCO', 'Registrar los cargos del Banco Aula',
          'El banco debitó cargos que no están en los libros: registralos desde la conciliación de la cuenta del banco.',
          '{}', 'CONTABILIDAD', 'NORMAL')
  returning id into v_task;
  perform private.notify_roles(
    p_company, array['CONTABILIDAD'], 'NUEVA_TAREA', 'Cargos del Banco Aula',
    'El banco debitó cargos que no están en los libros: registralos desde la conciliación.',
    '/e/' || (select c.slug from public.companies c where c.id = p_company) || '/pagos/conciliaciones/nueva', null, v_task
  );
end;
$$;

-- ------------------------------------------------------------------ Comandos

-- Quien opera el banco cierra un mes: el banco debita, con la fecha de hoy, la comisión, el impuesto
-- y los intereses (las dos últimas si dan algo). En orden, desde el mes en que la cuenta empezó a
-- operar (cmdCloseBankMonth).
create function public.bank_month_close(p_company_id uuid, p_period text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'bank.operate');
  v_account public.bank_accounts;
  v_today date := private.business_date(p_company_id);
  v_label text;
  v_due text;
  v_fee numeric;
  v_tax numeric;
  v_interest numeric;
  v_charge record;
  v_row public.bank_movements;
  v_rate text;
begin
  select * into v_account from public.bank_accounts b where b.company_id = p_company_id and b.is_active
   order by b.created_at limit 1;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La empresa no tiene cuenta en el Banco Aula.');
  end if;
  if coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá el mes que se cierra.');
  end if;
  v_label := private.bank_period_label(p_period);
  if exists (select 1 from public.bank_closings c where c.bank_account_id = v_account.id and c.period = p_period) then
    perform private.raise_business_error('TRANSICION_INVALIDA', format('%s ya está cerrado en el Banco Aula.', v_label));
  end if;
  if p_period >= to_char(v_today, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO', format('%s todavía no terminó.', v_label));
  end if;
  if p_period < to_char(v_account.charges_from, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La cuenta opera en el Banco Aula desde %s: %s no se cierra.',
             private.bank_period_label(to_char(v_account.charges_from, 'YYYY-MM')), v_label));
  end if;
  v_due := private.bank_month_to_close(v_account, v_today);
  if v_due is distinct from p_period then
    perform private.raise_business_error('DATO_INVALIDO', format('Primero hay que cerrar %s.', private.bank_period_label(v_due)));
  end if;
  select c.fee, c.tax, c.interest into v_fee, v_tax, v_interest from private.bank_month_charges(v_account, p_period) c;
  -- La tasa como la escribe la interfaz: sin ceros de más ("6", "6.5").
  v_rate := trim(trailing '.' from trim(trailing '0' from v_account.overdraft_rate::text));
  for v_charge in
    select * from (values
      (1, 'COMISION', v_fee, 'Comisión de mantenimiento de cuenta · ' || v_label),
      (2, 'IMPUESTO_DC', v_tax, 'Impuesto a los débitos y créditos (0,6 %) · ' || v_label),
      (3, 'INTERESES', v_interest, 'Intereses por descubierto (' || v_rate || ' % mensual) · ' || v_label)
    ) as c (n, kind, amount, concept)
    order by c.n
  loop
    continue when v_charge.amount <= 0;
    v_row := private.bank_add_movement(v_account, 'BANCO', 'DEBITO', v_charge.amount, v_charge.concept, null, null, null,
                                       v_today, null);
    update public.bank_movements set charge = v_charge.kind where id = v_row.id;
    perform private.bank_process_movement(v_row.id, v_today, (select auth.uid()));
  end loop;
  insert into public.bank_closings (company_id, bank_account_id, period, closed_on, closed_by, fee, tax, interest)
  values (p_company_id, v_account.id, p_period, v_today, (select auth.uid()), v_fee, v_tax, v_interest);
  perform private.log_audit(p_company_id, v_actor, 'CLOSE_MONTH', 'bank_account', v_account.id,
    'Banco Aula ' || v_account.number,
    format('Cerró %s en el Banco Aula: comisión %s, impuesto a los débitos y créditos %s, intereses %s', v_label,
           private.format_money(v_fee), private.format_money(v_tax), private.format_money(v_interest)));
  perform private.bank_sync_charges_task(p_company_id);
  return jsonb_build_object('period', p_period, 'fee', v_fee, 'tax', v_tax, 'interest', v_interest);
end;
$$;

-- Contabilidad registra cargos que el banco ya debitó: un asiento automático con la cuenta de cada
-- tipo de cargo al debe y el banco al haber, que no le manda una orden al banco (cmdRegisterBankCharges).
create function public.bank_charges_register(p_company_id uuid, p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'bank_reconciliation.create');
  v_id uuid;
  v_m public.bank_movements;
  v_account public.bank_accounts;
  v_target public.accounts;
  v_accounts uuid[] := '{}';
  v_debits numeric[] := '{}';
  v_found int;
  v_i int;
  v_total numeric := 0;
  v_count int := 0;
  v_lines jsonb := '[]';
  v_entry public.documents;
  v_bank_line uuid;
begin
  if coalesce(cardinality(p_ids), 0) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí los cargos del banco que se registran.');
  end if;
  if (select count(distinct x) from unnest(p_ids) as x) <> cardinality(p_ids) then
    perform private.raise_business_error('DATO_INVALIDO', 'Un cargo está dos veces.');
  end if;
  foreach v_id in array p_ids loop
    select * into v_m from public.bank_movements m
     where m.id = v_id and m.company_id = p_company_id and m.origin = 'BANCO' and m.status = 'PROCESADO';
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Uno de los cargos no es de esta empresa.');
    end if;
    if v_m.journal_line_id is not null then
      perform private.raise_business_error('TRANSICION_INVALIDA', format('El cargo %s ya está registrado.', v_m.transaction_number));
    end if;
  end loop;
  -- Al debe, la cuenta de cada tipo de cargo (en el orden en que llegaron); al haber, el banco.
  for v_m in select m.* from public.bank_movements m where m.id = any (p_ids) order by m.seq loop
    if v_account.id is null then
      select * into v_account from public.bank_accounts b where b.id = v_m.bank_account_id;
    end if;
    v_target := private.rule_account(p_company_id, 'CARGOS_BANCARIOS', v_m.charge);
    v_found := null;
    for v_i in 1 .. coalesce(array_length(v_accounts, 1), 0) loop
      if v_accounts[v_i] = v_target.id then
        v_found := v_i;
        exit;
      end if;
    end loop;
    if v_found is null then
      v_accounts := v_accounts || v_target.id;
      v_debits := v_debits || v_m.amount;
    else
      v_debits[v_found] := v_debits[v_found] + v_m.amount;
    end if;
    v_total := v_total + v_m.amount;
    v_count := v_count + 1;
  end loop;
  for v_i in 1 .. array_length(v_accounts, 1) loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts[v_i], 'debit', v_debits[v_i], 'credit', 0, 'notes', ''));
  end loop;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', v_account.ledger_account_id, 'debit', 0, 'credit', v_total, 'notes', ''));
  v_entry := private.new_journal_entry(p_company_id, v_actor, private.business_date(p_company_id),
    format('Cargos del Banco Aula registrados desde la conciliación: %s cargo%s por %s.', v_count,
           case when v_count = 1 then '' else 's' end, private.format_money(v_total)),
    'AUTOMATICO', null, v_lines);
  perform private.post_journal_entry(v_entry, v_actor,
    format('Registró %s, asiento automático N.º {n} de los cargos del Banco Aula', v_entry.display_number));
  select l.id into v_bank_line from public.journal_entry_lines l
   where l.document_id = v_entry.id and l.account_id = v_account.ledger_account_id;
  update public.bank_movements set journal_line_id = v_bank_line where id = any (p_ids);
  perform private.bank_sync_charges_task(p_company_id);
  return private.created_result(v_entry.id);
end;
$$;

grant execute on function public.bank_month_close(uuid, text) to authenticated;
grant execute on function public.bank_charges_register(uuid, uuid[]) to authenticated;

-- ------------------------------------------------------------------ Funciones que cambian

-- Igual que antes, y además la cuenta cobra desde el mes de hoy (openBankAccount).
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
end;
$$;

-- Igual que antes, y además al anular el asiento que registró cargos del banco, vuelven a quedar
-- sin registrar (reverseBankOrders).
create or replace function private.bank_reverse_orders(p_reversal public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_original uuid;
  v_order public.bank_movements;
  v_line public.journal_entry_lines;
  v_mirror uuid;
  v_account public.bank_accounts;
  v_row public.bank_movements;
  v_ids uuid[] := '{}';
  v_withdrawn boolean := false;
  v_unlinked int;
  v_today date := private.business_date(p_reversal.company_id);
begin
  select je.reverses_id into v_original from public.journal_entries je where je.document_id = p_reversal.id;
  if v_original is null then
    return;
  end if;
  -- Al anular el asiento que registró cargos del banco, vuelven a quedar sin registrar (8b.1).
  update public.bank_movements m set journal_line_id = null
    from public.journal_entry_lines l
   where l.id = m.journal_line_id and l.document_id = v_original and m.origin = 'BANCO';
  get diagnostics v_unlinked = row_count;
  if v_unlinked > 0 then
    perform private.bank_sync_charges_task(p_reversal.company_id);
  end if;
  for v_order in
    select m.* from public.bank_movements m join public.journal_entry_lines l on l.id = m.journal_line_id
     where l.document_id = v_original and m.origin = 'ORDEN' and m.reverses_id is null
     order by m.seq
  loop
    if v_order.status = 'PENDIENTE' then
      update public.bank_movements set status = 'ANULADO' where id = v_order.id;
      v_withdrawn := true;
      continue;
    end if;
    continue when v_order.status <> 'PROCESADO';
    select * into v_line from public.journal_entry_lines l where l.id = v_order.journal_line_id;
    select l.id into v_mirror from public.journal_entry_lines l
     where l.document_id = p_reversal.id and l.account_id = v_line.account_id
       and l.debit = v_line.credit and l.credit = v_line.debit
     order by l.line_no limit 1;
    select * into v_account from public.bank_accounts b where b.id = v_order.bank_account_id;
    v_row := private.bank_add_movement(v_account, 'ORDEN',
      case when v_order.direction = 'CREDITO' then 'DEBITO' else 'CREDITO' end, v_order.amount,
      'Reversión de ' || v_order.transaction_number || ': ' || v_order.concept,
      v_order.source_document_id, v_mirror, v_order.id, v_today, (select auth.uid()));
    v_ids := v_ids || v_row.id;
  end loop;
  if cardinality(v_ids) > 0 then
    perform private.bank_settle(p_reversal.company_id, v_ids);
  elsif v_withdrawn then
    perform private.bank_sync_task(p_reversal.company_id);
  end if;
end;
$$;

-- Igual que antes, y además la comisión, la tasa de descubierto y el mes que falta cerrar (bankAccountView).
create or replace function public.bank_account_view(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account public.bank_accounts;
  v_ledger public.accounts;
  v_balance numeric;
begin
  perform private.require_read(p_company_id, 'bank.read');
  select * into v_account from public.bank_accounts b where b.company_id = p_company_id and b.is_active
   order by b.created_at limit 1;
  if not found then
    return null;
  end if;
  select * into v_ledger from public.accounts a where a.id = v_account.ledger_account_id;
  select coalesce(sum(case when m.direction = 'CREDITO' then m.amount else -m.amount end), 0) into v_balance
    from public.bank_movements m where m.bank_account_id = v_account.id and m.status = 'PROCESADO';
  return jsonb_build_object(
    'account', jsonb_build_object(
      'id', v_account.id, 'number', v_account.number, 'bank_key', v_account.bank_key, 'alias', v_account.alias,
      'opened_on', v_account.opened_on, 'overdraft_limit', v_account.overdraft_limit,
      'monthly_fee', v_account.monthly_fee, 'overdraft_rate', v_account.overdraft_rate,
      'ledger', jsonb_build_object('id', v_ledger.id, 'code', v_ledger.code, 'name', v_ledger.name)),
    'mode', private.bank_mode(p_company_id),
    'to_close', private.bank_month_to_close(v_account, private.business_date(p_company_id)),
    'balance', v_balance,
    'book_balance', private.account_balance(v_ledger.id),
    'pending', coalesce((
      select jsonb_agg(private.bank_movement_row(p_company_id, m, null) order by m.seq)
        from public.bank_movements m where m.bank_account_id = v_account.id and m.status = 'PENDIENTE'), '[]'),
    'movements', coalesce((
      select jsonb_agg(private.bank_movement_row(p_company_id, x.m, x.balance)
                       order by (x.m).processed_on desc, (x.m).transaction_number collate "C" desc nulls last)
        from (select m, sum(case when m.direction = 'CREDITO' then m.amount else -m.amount end)
                          over (order by m.processed_on, m.transaction_number collate "C" nulls first
                                rows between unbounded preceding and current row) as balance
                from public.bank_movements m
               where m.bank_account_id = v_account.id and m.status = 'PROCESADO') x), '[]'));
end;
$$;

-- Igual que antes, y además el tipo de cargo (BankMovementRow).
create or replace function private.bank_movement_row(p_company uuid, p_m public.bank_movements, p_balance numeric)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_m.id, 'seq', p_m.seq, 'origin', p_m.origin, 'charge', p_m.charge, 'direction', p_m.direction,
    'amount', p_m.amount,
    'concept', p_m.concept, 'status', p_m.status, 'received_on', p_m.received_on, 'processed_on', p_m.processed_on,
    'transaction_number', p_m.transaction_number,
    'processed_by_name', case when p_m.processed_by is not null then private.full_name(p_m.processed_by) end,
    'ordered_by_name', case when p_m.ordered_by is not null then private.full_name(p_m.ordered_by) end,
    'own', coalesce(p_m.ordered_by = (select auth.uid()), false),
    'source', (select jsonb_build_object('id', d.id, 'display_number', d.display_number, 'path', private.doc_path(d.id))
                 from public.documents d join public.document_types dt on dt.code = d.doc_type
                where d.id = p_m.source_document_id and private.has_permission(p_company, dt.resource || '.read')),
    'balance', p_balance)
$$;

-- Igual que antes, y además los cargos del banco sin registrar (bankStatementSince).
create or replace function private.bank_statement_since(p_ledger uuid, p_since date, p_up_to date)
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
       where l.line_date <= p_up_to and (p_since is null or l.line_date > p_since)), '[]'::jsonb),
    -- Los cargos que el banco debitó hasta esa fecha y no están en los libros (8b.1).
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'date', m.processed_on, 'transaction_number', m.transaction_number,
                                          'charge', m.charge, 'concept', m.concept, 'amount', m.amount)
                       order by m.processed_on, m.transaction_number collate "C" nulls first)
        from public.bank_movements m
       where m.bank_account_id = v_bank and m.status = 'PROCESADO' and m.origin = 'BANCO'
         and m.journal_line_id is null and m.processed_on <= p_up_to), '[]'::jsonb));
end;
$$;

-- Igual que antes, y además la tarea de registrar los cargos lleva a la conciliación (listTasks).
create or replace function private.task_items(p_company uuid, p_all boolean, p_include_closed boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select (select auth.uid()) as uid, array(select private.my_role_codes(p_company)) as roles
  )
  select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object(
           'mine', x.mine,
           'document_label', d.display_number,
           'document_type', d.doc_type,
           'path', case when d.id is not null then private.doc_path(d.id)
                        when t.task_type = 'REPONER_STOCK' then '/e/' || c.slug || '/stock'
                        when t.task_type = 'PROCESAR_BANCO' then '/e/' || c.slug || '/pagos/banco-aula/bandeja'
                        when t.task_type = 'REGISTRAR_CARGOS_BANCO' then '/e/' || c.slug || '/pagos/conciliaciones/nueva' end,
           'assignee_label', case when t.assigned_user_id is not null then private.full_name(t.assigned_user_id)
                                  when t.assigned_role is not null then (select r.name from public.roles r where r.code = t.assigned_role)
                                  else '—' end,
           'claimed_by_name', case when t.claimed_by is not null then private.full_name(t.claimed_by) end,
           'completed_by_name', case when t.completed_by is not null then private.full_name(t.completed_by) end)
         order by t.status = 'EN_CURSO' desc, t.created_at desc), '[]')
    from public.tasks t
    cross join me
    cross join lateral (
      select coalesce(t.assigned_user_id = me.uid, false) or coalesce(t.assigned_role = any (me.roles), false) as mine
    ) x
    join public.companies c on c.id = t.company_id
    left join public.documents d on d.id = t.document_id
   where t.company_id = p_company
     and p_company in (select private.my_companies()) -- sólo quien participa en la empresa (o soporte)
     and (p_include_closed or t.status in ('PENDIENTE', 'EN_CURSO'))
     and (x.mine or p_all)
$$;
