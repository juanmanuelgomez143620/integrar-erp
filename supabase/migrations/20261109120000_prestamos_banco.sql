-- 88. Fase 8c.1 (docs/FASE_8_BANCO_Y_FISCO.md §3): los préstamos del Banco Aula. Gerencia los pide
-- con los indicadores del libro mayor (liquidez corriente, endeudamiento y cuota sobre las ventas del
-- mes); quien opera el banco (no quien lo pidió: SoD-13) los aprueba con la tasa y el plazo o los
-- rechaza con el motivo, y si lo opera el sistema decide en el momento. Al aprobarlo, el banco
-- acredita el importe y arma el cronograma por sistema francés; las cuotas se debitan al vencer, en
-- dos movimientos (capital e intereses). Contabilidad registra la acreditación y las cuotas desde la
-- conciliación, con el mismo asiento que los cargos, que ahora junta créditos y débitos del banco.
-- Traducción de la sección "Préstamos del Banco Aula" de engine.ts (8c.1).
--
-- El permiso loan.create y las claves de la imputación están en la migración de catálogos
-- siguiente; las reglas, en la de la plantilla; las empresas que ya existían las reciben en la última
-- de esta fase.

-- ------------------------------------------------------------------ Tablas

-- Los movimientos del banco suman los tipos del préstamo: la acreditación y las cuotas.
alter table public.bank_movements drop constraint bank_movements_charge_check;
alter table public.bank_movements add constraint bank_movements_charge_check
  check (charge in ('COMISION', 'IMPUESTO_DC', 'INTERESES', 'RECHAZO', 'PRESTAMO', 'CUOTA_CAPITAL', 'CUOTA_INTERES'));

-- Un préstamo: lo pide Gerencia (con los indicadores de ese día) y lo evalúa quien opera el banco.
create table public.bank_loans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  bank_account_id uuid not null,
  number int not null check (number > 0),
  amount numeric(14, 2) not null check (amount > 0),
  months int not null check (months in (6, 12, 18, 24)),
  purpose text not null check (length(purpose) between 3 and 200),
  status text not null default 'SOLICITADO' check (status in ('SOLICITADO', 'RECHAZADO', 'VIGENTE', 'CANCELADO')),
  requested_by uuid,
  requested_on date not null,
  liquidity numeric(14, 2),
  debt_ratio numeric(14, 2),
  sales_share numeric(14, 2),
  rate numeric(6, 2) check (rate between 0 and 200),
  evaluated_by uuid,
  evaluated_on date,
  rejection_reason text,
  granted_on date,
  created_at timestamptz not null default now(),
  unique (bank_account_id, number),
  unique (company_id, id),
  foreign key (company_id, bank_account_id) references public.bank_accounts (company_id, id) on delete cascade
);

-- Su cronograma: una fila por cuota.
create table public.bank_loan_installments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  loan_id uuid not null,
  n int not null check (n > 0),
  due_on date not null,
  principal numeric(14, 2) not null check (principal >= 0),
  interest numeric(14, 2) not null check (interest >= 0),
  status text not null default 'PENDIENTE' check (status in ('PENDIENTE', 'DEBITADA')),
  debited_on date,
  unique (loan_id, n),
  check ((status = 'DEBITADA') = (debited_on is not null)),
  foreign key (company_id, loan_id) references public.bank_loans (company_id, id) on delete cascade
);

alter table public.bank_loans enable row level security;
alter table public.bank_loan_installments enable row level security;
revoke all on table public.bank_loans, public.bank_loan_installments from anon, authenticated;
grant select on table public.bank_loans, public.bank_loan_installments to authenticated;
create policy bank_loans_select on public.bank_loans for select to authenticated
  using (company_id in (select private.companies_with_permission('bank.read')));
create policy bank_loan_installments_select on public.bank_loan_installments for select to authenticated
  using (company_id in (select private.companies_with_permission('bank.read')));
create trigger bank_loans_same_company before update on public.bank_loans
  for each row execute function private.prevent_company_change();
create trigger bank_loan_installments_same_company before update on public.bank_loan_installments
  for each row execute function private.prevent_company_change();

-- ------------------------------------------------------------------ Auxiliares

-- "48" o "48,5": una tasa o un indicador como lo escribe el simulador en sus textos (decimalText).
create function private.bank_decimal_text(p_value numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(case when p_value::text like '%.%' then rtrim(rtrim(p_value::text, '0'), '.') else p_value::text end,
                 '.', ',')
$$;

-- El cronograma por sistema francés, como el de Banco Aula: cuota fija con la tasa mensual (la anual
-- dividida 12), el interés de cada cuota redondeado al centavo y la última que ajusta el capital;
-- vence el mismo día de cada mes siguiente o el último, si el mes no lo tiene (loanSchedule). La
-- cuota se calcula con la misma aritmética de punto flotante que el simulador; el interés, en
-- centavos enteros con la tasa en centésimos y la mitad hacia arriba.
create function private.bank_loan_schedule(p_amount numeric, p_rate numeric, p_months int, p_from date)
returns table (n int, due_on date, principal numeric, interest numeric)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_cents bigint := round(p_amount * 100);
  v_r float8 := p_rate::float8 / 1200;
  v_points bigint := round(p_rate * 100);
  v_payment bigint;
  v_balance bigint;
  v_interest bigint;
  v_principal bigint;
begin
  v_payment := floor(case when v_r = 0 then v_cents::float8 / p_months
                          else v_cents::float8 * v_r / (1 - power(1 + v_r, (-p_months)::float8)) end + 0.5);
  v_balance := v_cents;
  for i in 1 .. p_months loop
    v_interest := (2 * v_balance * v_points + 120000) / 240000;
    v_principal := case when i = p_months then v_balance else least(v_balance, v_payment - v_interest) end;
    n := i;
    due_on := (p_from + make_interval(months => i))::date;
    principal := round(v_principal / 100.0, 2);
    interest := round(v_interest / 100.0, 2);
    return next;
    v_balance := v_balance - v_principal;
  end loop;
end;
$$;

-- Los indicadores del libro mayor con que el banco evalúa un préstamo: la liquidez corriente, el
-- endeudamiento (pasivo / patrimonio neto, el activo menos el pasivo) y la cuota con la tasa de
-- referencia (48 % anual) como por ciento de las ventas netas del mes; null si no se calculan
-- (loanIndicators).
create function private.bank_loan_indicators(p_company uuid, p_amount numeric, p_months int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.business_date(p_company);
  v_assets numeric;
  v_current_assets numeric;
  v_liabilities numeric;
  v_current_liabilities numeric;
  v_sales numeric;
  v_installment numeric;
  v_equity numeric;
begin
  select coalesce(sum(l.debit - l.credit) filter (where a.code like '1.%'), 0),
         coalesce(sum(l.debit - l.credit) filter (where a.code like '1.1.%'), 0),
         coalesce(-sum(l.debit - l.credit) filter (where a.code like '2.%'), 0),
         coalesce(-sum(l.debit - l.credit) filter (where a.code like '2.1.%'), 0),
         coalesce(-sum(l.debit - l.credit) filter (
           where a.code like '4.1.%' and to_char(d.document_date, 'YYYY-MM') = to_char(v_today, 'YYYY-MM')
             and d.document_date <= v_today), 0)
    into v_assets, v_current_assets, v_liabilities, v_current_liabilities, v_sales
    from public.journal_entry_lines l
    join public.journal_entries je on je.document_id = l.document_id and je.entry_number is not null
    join public.documents d on d.id = l.document_id
    join public.accounts a on a.id = l.account_id
   where d.company_id = p_company;
  select s.principal + s.interest into v_installment
    from private.bank_loan_schedule(p_amount, 48, p_months, v_today) s where s.n = 1;
  v_equity := v_assets - v_liabilities;
  return jsonb_build_object(
    'liquidity', case when v_current_liabilities > 0 then round(v_current_assets / v_current_liabilities, 2) end,
    'debt_ratio', case when v_equity > 0 then round(v_liabilities / v_equity, 2) end,
    'installment', v_installment,
    'sales', v_sales,
    'sales_share', case when v_sales > 0 then round(v_installment / v_sales * 100, 2) end);
end;
$$;

-- Mientras haya un pedido de préstamo sin evaluar y lo opere Tesorería, Tesorería tiene la tarea de
-- evaluarlo (syncLoanTask).
create function private.bank_sync_loan_task(p_company uuid)
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
   where t.company_id = p_company and t.task_type = 'EVALUAR_PRESTAMO' and t.status in ('PENDIENTE', 'EN_CURSO')
   order by t.created_at limit 1;
  if private.bank_mode(p_company) = 'AUTOMATICO'
     or not exists (select 1 from public.bank_loans l where l.company_id = p_company and l.status = 'SOLICITADO') then
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
  values (p_company, 'EVALUAR_PRESTAMO', 'Evaluar el pedido de préstamo de Gerencia',
          'Gerencia pidió un préstamo al Banco Aula: lo evalúa desde la bandeja un integrante de Tesorería que no lo pidió.',
          '{}', 'TESORERIA', 'NORMAL')
  returning id into v_task;
  perform private.notify_roles(
    p_company, array['TESORERIA'], 'NUEVA_TAREA', 'Pedido de préstamo',
    'Gerencia pidió un préstamo al Banco Aula: evalualo desde la bandeja.',
    '/e/' || (select c.slug from public.companies c where c.id = p_company) || '/pagos/banco-aula/bandeja', null, v_task
  );
end;
$$;

-- El banco decide un préstamo: lo rechaza con el motivo (si viene) o lo acredita con la tasa y el
-- plazo, con su cronograma. Gerencia recibe el aviso; Contabilidad registra la acreditación desde la
-- conciliación (decideLoan).
create function private.bank_decide_loan(p_loan uuid, p_rate numeric, p_months int, p_reason text, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan public.bank_loans;
  v_today date;
  v_link text;
  v_account public.bank_accounts;
  v_credit public.bank_movements;
  v_first numeric;
begin
  select * into v_loan from public.bank_loans l where l.id = p_loan;
  v_today := private.business_date(v_loan.company_id);
  v_link := '/e/' || (select c.slug from public.companies c where c.id = v_loan.company_id) || '/pagos/prestamos';
  if p_reason is not null then
    update public.bank_loans
       set status = 'RECHAZADO', rejection_reason = p_reason, evaluated_by = p_user, evaluated_on = v_today
     where id = p_loan;
    perform private.notify_roles(v_loan.company_id, array['GERENCIA'], 'PRESTAMO',
      format('El Banco Aula rechazó el préstamo N.º %s', v_loan.number), 'Motivo: ' || p_reason, v_link, null, null);
    return;
  end if;
  update public.bank_loans
     set status = 'VIGENTE', rate = p_rate, months = p_months, granted_on = v_today, evaluated_by = p_user,
         evaluated_on = v_today
   where id = p_loan;
  select * into v_account from public.bank_accounts b where b.id = v_loan.bank_account_id;
  v_credit := private.bank_add_movement(v_account, 'BANCO', 'CREDITO', v_loan.amount,
    'Acreditación del préstamo N.º ' || v_loan.number, null, null, null, v_today, null);
  update public.bank_movements set charge = 'PRESTAMO' where id = v_credit.id;
  perform private.bank_process_movement(v_credit.id, v_today, p_user);
  insert into public.bank_loan_installments (company_id, loan_id, n, due_on, principal, interest)
  select v_loan.company_id, p_loan, s.n, s.due_on, s.principal, s.interest
    from private.bank_loan_schedule(v_loan.amount, p_rate, p_months, v_today) s;
  perform private.bank_sync_charges_task(v_loan.company_id);
  select i.principal + i.interest into v_first from public.bank_loan_installments i where i.loan_id = p_loan and i.n = 1;
  perform private.notify_roles(v_loan.company_id, array['GERENCIA'], 'PRESTAMO',
    format('El Banco Aula aprobó el préstamo N.º %s', v_loan.number),
    format('Acreditó %s en la cuenta: %s cuotas de %s al %s %% anual. Contabilidad lo registra desde la conciliación.',
           private.format_money(v_loan.amount), p_months, private.format_money(v_first), private.bank_decimal_text(p_rate)),
    v_link, null, null);
end;
$$;

-- Si lo opera el sistema, el banco decide en el momento con la tasa de referencia y el plazo pedido:
-- lo aprueba si la liquidez corriente llega a 1 y la cuota no pasa del 30 % de las ventas; si no, lo
-- rechaza diciendo cuál no alcanzó (autoDecideLoan).
create function private.bank_auto_decide_loan(p_loan uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan public.bank_loans;
  v_reason text;
begin
  select * into v_loan from public.bank_loans l where l.id = p_loan;
  v_reason := case
    when v_loan.liquidity is not null and v_loan.liquidity < 1 then
      format('La liquidez corriente es %s: el banco pide al menos 1.', private.bank_decimal_text(v_loan.liquidity))
    when v_loan.sales_share is not null and v_loan.sales_share > 30 then
      format('La cuota sería el %s %% de las ventas del mes: el banco acepta hasta el 30 %%.',
             private.bank_decimal_text(v_loan.sales_share))
  end;
  perform private.bank_decide_loan(p_loan, case when v_reason is null then 48 end,
                                   case when v_reason is null then v_loan.months end, v_reason, null);
end;
$$;

-- El banco debita las cuotas vencidas de los préstamos vigentes, cada una en dos movimientos (capital
-- e intereses), aunque no haya fondos; con la última, el préstamo queda cancelado. Devuelve cuántas
-- debitó (debitDueInstallments).
create function private.bank_debit_installments(p_company uuid, p_user uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.business_date(p_company);
  v_row record;
  v_account public.bank_accounts;
  v_m public.bank_movements;
  v_count int := 0;
begin
  for v_row in
    select i.id, i.n, i.principal, i.interest, l.id as loan_id, l.number, l.months, l.bank_account_id
      from public.bank_loan_installments i join public.bank_loans l on l.id = i.loan_id
     where l.company_id = p_company and l.status = 'VIGENTE' and i.status = 'PENDIENTE' and i.due_on <= v_today
     order by i.due_on, l.number, i.n
  loop
    select * into v_account from public.bank_accounts b where b.id = v_row.bank_account_id;
    if v_row.principal > 0 then
      v_m := private.bank_add_movement(v_account, 'BANCO', 'DEBITO', v_row.principal,
        format('Préstamo N.º %s · cuota %s de %s: capital', v_row.number, v_row.n, v_row.months),
        null, null, null, v_today, null);
      update public.bank_movements set charge = 'CUOTA_CAPITAL' where id = v_m.id;
      perform private.bank_process_movement(v_m.id, v_today, p_user);
    end if;
    if v_row.interest > 0 then
      v_m := private.bank_add_movement(v_account, 'BANCO', 'DEBITO', v_row.interest,
        format('Préstamo N.º %s · cuota %s de %s: intereses', v_row.number, v_row.n, v_row.months),
        null, null, null, v_today, null);
      update public.bank_movements set charge = 'CUOTA_INTERES' where id = v_m.id;
      perform private.bank_process_movement(v_m.id, v_today, p_user);
    end if;
    update public.bank_loan_installments set status = 'DEBITADA', debited_on = v_today where id = v_row.id;
    if not exists (select 1 from public.bank_loan_installments x where x.loan_id = v_row.loan_id and x.status = 'PENDIENTE') then
      update public.bank_loans set status = 'CANCELADO' where id = v_row.loan_id;
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count > 0 then
    perform private.bank_sync_charges_task(p_company);
  end if;
  return v_count;
end;
$$;

-- ------------------------------------------------------------------ Comandos

-- Gerencia pide un préstamo al Banco Aula: guarda los indicadores del día y espera la evaluación de
-- Tesorería (si lo opera el sistema, decide en el momento). Uno por vez (cmdRequestLoan).
create function public.loan_request(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'loan.create');
  v_account public.bank_accounts;
  v_amount numeric;
  v_months numeric;
  v_purpose text := btrim(coalesce(p_input ->> 'purpose', ''));
  v_waiting int;
  v_indicators jsonb;
  v_loan public.bank_loans;
begin
  select * into v_account from public.bank_accounts b where b.company_id = p_company_id and b.is_active
   order by b.created_at limit 1;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La empresa no tiene cuenta en el Banco Aula.');
  end if;
  if jsonb_typeof(p_input -> 'amount') is distinct from 'number'
     or (p_input ->> 'amount')::numeric <= 0 or (p_input ->> 'amount')::numeric > 50000000
     or round((p_input ->> 'amount')::numeric, 2) <> (p_input ->> 'amount')::numeric then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Indicá el importe del préstamo: hasta %s, con hasta 2 decimales.', private.format_money(50000000)));
  end if;
  v_amount := (p_input ->> 'amount')::numeric;
  if jsonb_typeof(p_input -> 'months') is distinct from 'number'
     or (p_input ->> 'months')::numeric not in (6, 12, 18, 24) then
    perform private.raise_business_error('DATO_INVALIDO', 'El plazo es de 6, 12, 18 o 24 cuotas mensuales.');
  end if;
  v_months := (p_input ->> 'months')::numeric;
  if length(v_purpose) < 3 or length(v_purpose) > 200 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá el destino del préstamo (hasta 200 caracteres).');
  end if;
  select l.number into v_waiting from public.bank_loans l
   where l.company_id = p_company_id and l.status = 'SOLICITADO' order by l.number limit 1;
  if v_waiting is not null then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('El préstamo N.º %s todavía espera la evaluación del banco: se pide de a uno.', v_waiting));
  end if;
  v_indicators := private.bank_loan_indicators(p_company_id, v_amount, v_months::int);
  insert into public.bank_loans (company_id, bank_account_id, number, amount, months, purpose, requested_by,
                                 requested_on, liquidity, debt_ratio, sales_share)
  values (p_company_id, v_account.id,
          coalesce((select max(l.number) from public.bank_loans l where l.bank_account_id = v_account.id), 0) + 1,
          v_amount, v_months::int, v_purpose, (select auth.uid()), private.business_date(p_company_id),
          (v_indicators ->> 'liquidity')::numeric, (v_indicators ->> 'debt_ratio')::numeric,
          (v_indicators ->> 'sales_share')::numeric)
  returning * into v_loan;
  perform private.log_audit(p_company_id, v_actor, 'REQUEST', 'bank_loan', v_loan.id, 'Préstamo N.º ' || v_loan.number,
    format('Pidió al Banco Aula el préstamo N.º %s: %s en %s cuotas, para %s', v_loan.number,
           private.format_money(v_amount), v_loan.months, v_purpose));
  perform private.bank_settle(p_company_id);
  return jsonb_build_object('id', v_loan.id, 'number', v_loan.number,
                            'status', (select l.status from public.bank_loans l where l.id = v_loan.id));
end;
$$;

-- Quien opera el banco evalúa un pedido de préstamo: lo aprueba con la tasa nominal anual y el plazo o
-- lo rechaza con el motivo. Quien lo pidió no lo evalúa (SoD-13) (cmdEvaluateLoan).
create function public.loan_evaluate(p_loan_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan public.bank_loans;
  v_actor private.actor;
  v_sod boolean;
  v_approve boolean := coalesce((p_input ->> 'approve')::boolean, false);
  v_rate numeric;
  v_reason text;
begin
  select * into v_loan from public.bank_loans l where l.id = p_loan_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'El préstamo no existe.');
  end if;
  v_actor := private.require_permission(v_loan.company_id, 'bank.operate');
  if v_loan.status <> 'SOLICITADO' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('El préstamo N.º %s ya está %s.', v_loan.number,
             case v_loan.status when 'RECHAZADO' then 'rechazado' when 'VIGENTE' then 'vigente' else 'cancelado' end));
  end if;
  v_sod := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c
                     where c.id = v_loan.company_id), true)
           and not private.is_supervisor(v_loan.company_id);
  if v_sod and v_loan.requested_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés evaluar el préstamo N.º %s: lo pediste vos.', v_loan.number),
      'Separación de funciones (SoD-13): quien pide un préstamo no lo evalúa. Lo evalúa otro integrante de Tesorería.');
  end if;
  if v_approve then
    if jsonb_typeof(p_input -> 'rate') is distinct from 'number'
       or (p_input ->> 'rate')::numeric < 0 or (p_input ->> 'rate')::numeric > 200
       or round((p_input ->> 'rate')::numeric, 2) <> (p_input ->> 'rate')::numeric then
      perform private.raise_business_error('DATO_INVALIDO', 'La tasa nominal anual va de 0 a 200, con hasta 2 decimales.');
    end if;
    v_rate := (p_input ->> 'rate')::numeric;
    if jsonb_typeof(p_input -> 'months') is distinct from 'number'
       or (p_input ->> 'months')::numeric not in (6, 12, 18, 24) then
      perform private.raise_business_error('DATO_INVALIDO', 'El plazo es de 6, 12, 18 o 24 cuotas mensuales.');
    end if;
    perform private.bank_decide_loan(p_loan_id, v_rate, (p_input ->> 'months')::numeric::int, null, (select auth.uid()));
  else
    v_reason := btrim(coalesce(p_input ->> 'reason', ''));
    if length(v_reason) < 3 then
      perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo del rechazo: lo recibe Gerencia.');
    end if;
    perform private.bank_decide_loan(p_loan_id, null, null, v_reason, (select auth.uid()));
  end if;
  perform private.bank_sync_loan_task(v_loan.company_id);
  select * into v_loan from public.bank_loans l where l.id = p_loan_id;
  perform private.log_audit(v_loan.company_id, v_actor, case when v_approve then 'APPROVE' else 'REJECT' end,
    'bank_loan', v_loan.id, 'Préstamo N.º ' || v_loan.number,
    case when v_approve
      then format('Aprobó el préstamo N.º %s: acreditó %s en %s cuotas al %s %% anual', v_loan.number,
                  private.format_money(v_loan.amount), v_loan.months, private.bank_decimal_text(v_loan.rate))
      else format('Rechazó el préstamo N.º %s: %s', v_loan.number, v_loan.rejection_reason) end);
  return jsonb_build_object('status', v_loan.status);
end;
$$;

-- Quien opera el banco debita las cuotas vencidas de los préstamos (cmdDebitLoanInstallments).
create function public.loan_installments_debit(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'bank.operate');
  v_account public.bank_accounts;
  v_today date := private.business_date(p_company_id);
  v_count int;
  v_summary text;
begin
  select * into v_account from public.bank_accounts b where b.company_id = p_company_id and b.is_active
   order by b.created_at limit 1;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La empresa no tiene cuenta en el Banco Aula.');
  end if;
  select count(*), string_agg(format('préstamo N.º %s, cuota %s (%s)', l.number, i.n,
                                     private.format_money(i.principal + i.interest)), ', ' order by i.due_on, l.number, i.n)
    into v_count, v_summary
    from public.bank_loan_installments i join public.bank_loans l on l.id = i.loan_id
   where l.company_id = p_company_id and l.status = 'VIGENTE' and i.status = 'PENDIENTE' and i.due_on <= v_today;
  if v_count = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'No hay cuotas vencidas para debitar.');
  end if;
  perform private.bank_debit_installments(p_company_id, (select auth.uid()));
  perform private.log_audit(p_company_id, v_actor, 'DEBIT', 'bank_account', v_account.id,
    'Banco Aula ' || v_account.number,
    format('Debitó %s de préstamos: %s', case when v_count = 1 then 'la cuota' else v_count || ' cuotas' end, v_summary));
  return jsonb_build_object('debited', v_count);
end;
$$;

-- ------------------------------------------------------------------ Lecturas

-- Los préstamos de la empresa en el Banco Aula, con su cronograma, del más nuevo al más viejo, y las
-- condiciones del banco (bankLoans).
create function public.bank_loans(p_company_id uuid)
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

-- Lo que vería el banco si Gerencia pidiera hoy un préstamo; null si el importe o el plazo no son
-- válidos (loanPreview).
create function public.loan_preview(p_company_id uuid, p_amount numeric, p_months int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'loan.create');
  if p_months is null or p_months not in (6, 12, 18, 24) or p_amount is null or p_amount <= 0
     or p_amount > 50000000 or round(p_amount, 2) <> p_amount then
    return null;
  end if;
  return private.bank_loan_indicators(p_company_id, p_amount, p_months);
end;
$$;

grant execute on function public.loan_request(uuid, jsonb) to authenticated;
grant execute on function public.loan_evaluate(uuid, jsonb) to authenticated;
grant execute on function public.loan_installments_debit(uuid) to authenticated;
grant execute on function public.bank_loans(uuid) to authenticated;
grant execute on function public.loan_preview(uuid, numeric, int) to authenticated;

-- Contabilidad registra lo que el banco movió por su cuenta (los cargos, la acreditación y las cuotas
-- de un préstamo): lo que el banco debitó va al debe de la cuenta de su tipo y lo que acreditó, al
-- haber, con el banco del otro lado de cada uno. No le manda una orden al banco (cmdRegisterBankCharges).
create or replace function public.bank_charges_register(p_company_id uuid, p_ids uuid[])
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
  v_debit_accounts uuid[] := '{}';
  v_debits numeric[] := '{}';
  v_credit_accounts uuid[] := '{}';
  v_credits numeric[] := '{}';
  v_found int;
  v_i int;
  v_debited numeric := 0;
  v_credited numeric := 0;
  v_count int := 0;
  v_lines jsonb := '[]';
  v_entry public.documents;
begin
  if coalesce(cardinality(p_ids), 0) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí los movimientos del banco que se registran.');
  end if;
  if (select count(distinct x) from unnest(p_ids) as x) <> cardinality(p_ids) then
    perform private.raise_business_error('DATO_INVALIDO', 'Un movimiento está dos veces.');
  end if;
  foreach v_id in array p_ids loop
    select * into v_m from public.bank_movements m
     where m.id = v_id and m.company_id = p_company_id and m.origin = 'BANCO' and m.status = 'PROCESADO';
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Uno de los movimientos no es de esta empresa.');
    end if;
    if v_m.journal_line_id is not null then
      perform private.raise_business_error('TRANSICION_INVALIDA',
        format('El movimiento %s ya está registrado.', v_m.transaction_number));
    end if;
  end loop;
  for v_m in select m.* from public.bank_movements m where m.id = any (p_ids) order by m.seq loop
    if v_account.id is null then
      select * into v_account from public.bank_accounts b where b.id = v_m.bank_account_id;
    end if;
    v_target := private.rule_account(p_company_id, 'CARGOS_BANCARIOS', v_m.charge);
    v_found := null;
    if v_m.direction = 'DEBITO' then
      for v_i in 1 .. coalesce(array_length(v_debit_accounts, 1), 0) loop
        if v_debit_accounts[v_i] = v_target.id then
          v_found := v_i;
          exit;
        end if;
      end loop;
      if v_found is null then
        v_debit_accounts := v_debit_accounts || v_target.id;
        v_debits := v_debits || v_m.amount;
      else
        v_debits[v_found] := v_debits[v_found] + v_m.amount;
      end if;
      v_debited := v_debited + v_m.amount;
    else
      for v_i in 1 .. coalesce(array_length(v_credit_accounts, 1), 0) loop
        if v_credit_accounts[v_i] = v_target.id then
          v_found := v_i;
          exit;
        end if;
      end loop;
      if v_found is null then
        v_credit_accounts := v_credit_accounts || v_target.id;
        v_credits := v_credits || v_m.amount;
      else
        v_credits[v_found] := v_credits[v_found] + v_m.amount;
      end if;
      v_credited := v_credited + v_m.amount;
    end if;
    v_count := v_count + 1;
  end loop;
  for v_i in 1 .. coalesce(array_length(v_debit_accounts, 1), 0) loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_debit_accounts[v_i], 'debit', v_debits[v_i], 'credit', 0, 'notes', ''));
  end loop;
  if v_credited > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_account.ledger_account_id, 'debit', v_credited, 'credit', 0, 'notes', ''));
  end if;
  if v_debited > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_account.ledger_account_id, 'debit', 0, 'credit', v_debited, 'notes', ''));
  end if;
  for v_i in 1 .. coalesce(array_length(v_credit_accounts, 1), 0) loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_credit_accounts[v_i], 'debit', 0, 'credit', v_credits[v_i], 'notes', ''));
  end loop;
  v_entry := private.new_journal_entry(p_company_id, v_actor, private.business_date(p_company_id),
    format('Movimientos del Banco Aula registrados desde la conciliación: %s (%s).',
           case when v_count = 1 then 'un movimiento' else v_count || ' movimientos' end,
           concat_ws(' y ',
             case when v_debited > 0 then 'débitos por ' || private.format_money(v_debited) end,
             case when v_credited > 0 then 'créditos por ' || private.format_money(v_credited) end)),
    'AUTOMATICO', null, v_lines);
  perform private.post_journal_entry(v_entry, v_actor,
    format('Registró %s, asiento automático N.º {n} de los movimientos del Banco Aula', v_entry.display_number));
  update public.bank_movements m
     set journal_line_id = (
       select l.id from public.journal_entry_lines l
        where l.document_id = v_entry.id and l.account_id = v_account.ledger_account_id
          and case when m.direction = 'DEBITO' then l.credit > 0 else l.debit > 0 end
        order by l.line_no limit 1)
   where m.id = any (p_ids);
  perform private.bank_sync_charges_task(p_company_id);
  return private.created_result(v_entry.id);
end;
$$;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, salvo los textos: la tarea es de los movimientos del banco sin registrar (cargos y
-- préstamos) (syncChargesTask).
create or replace function private.bank_sync_charges_task(p_company uuid)
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
  values (p_company, 'REGISTRAR_CARGOS_BANCO', 'Registrar los movimientos del Banco Aula',
          'El banco registró movimientos que no están en los libros (cargos, la acreditación o las cuotas de un préstamo): registralos desde la conciliación de la cuenta del banco.',
          '{}', 'CONTABILIDAD', 'NORMAL')
  returning id into v_task;
  perform private.notify_roles(
    p_company, array['CONTABILIDAD'], 'NUEVA_TAREA', 'Movimientos del Banco Aula',
    'El banco registró movimientos que no están en los libros: registralos desde la conciliación.',
    '/e/' || (select c.slug from public.companies c where c.id = p_company) || '/pagos/conciliaciones/nueva', null, v_task
  );
end;
$$;

-- Igual que antes, y además el lado de cada movimiento sin registrar (bankStatementSince).
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
                                          'charge', m.charge, 'direction', m.direction, 'concept', m.concept,
                                          'amount', m.amount)
                       order by m.processed_on, m.transaction_number collate "C" nulls first)
        from public.bank_movements m
       where m.bank_account_id = v_bank and m.status = 'PROCESADO' and m.origin = 'BANCO'
         and m.journal_line_id is null and m.processed_on <= p_up_to), '[]'::jsonb));
end;
$$;

-- Igual que antes, y además si lo opera el sistema decide los préstamos pedidos y debita las cuotas
-- vencidas; y mantiene la tarea de evaluar los préstamos (settleBankOrders).
create or replace function private.bank_settle(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_today date := private.business_date(p_company);
begin
  if private.bank_mode(p_company) = 'AUTOMATICO' then
    -- Primero decide los préstamos pedidos y debita las cuotas vencidas (8c); después, las órdenes.
    for v_id in select l.id from public.bank_loans l where l.company_id = p_company and l.status = 'SOLICITADO'
                 order by l.number loop
      perform private.bank_auto_decide_loan(v_id);
    end loop;
    perform private.bank_debit_installments(p_company, null);
    for v_id in
      select m.id from public.bank_movements m
       where m.company_id = p_company and m.status = 'PENDIENTE'
         and (m.presented_on is null or m.presented_on <= v_today)
       order by m.seq
    loop
      perform private.bank_execute_order(v_id, v_today, null);
    end loop;
  end if;
  perform private.bank_sync_task(p_company);
  perform private.bank_sync_loan_task(p_company);
end;
$$;

-- Igual que antes, y además la tarea de evaluar un préstamo lleva a la bandeja (listTasks).
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
                        when t.task_type = 'REGISTRAR_CARGOS_BANCO' then '/e/' || c.slug || '/pagos/conciliaciones/nueva'
                        when t.task_type in ('RESOLVER_RECHAZO_BANCO', 'EVALUAR_PRESTAMO')
                          then '/e/' || c.slug || '/pagos/banco-aula/bandeja' end,
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
