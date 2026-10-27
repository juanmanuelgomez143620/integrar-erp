-- 54. Fase 6c (docs/FASE_6_RRHH_Y_SUELDOS.md §4): Tesorería paga los sueldos y, después,
-- las cargas sociales de cada liquidación, desde una caja o un banco con saldo (SoD-6:
-- quien liquidó no paga); los dos pagos entran al flujo de fondos (real y proyectado), y
-- un informe compara la mano de obra del taller aplicada a las órdenes con la real de los
-- sueldos. Traducción de payPayroll en src/lib/mock/engine.ts y de sus lecturas en queries.ts.
--
-- Los estados, las transiciones, las tareas y las claves de imputación nuevos están en la
-- migración de catálogos siguiente; las reglas de los asientos, en la de la plantilla.

-- ------------------------------------------------------------------ Los pagos de la liquidación

alter table public.payrolls
  add column salaries_paid_on date,
  add column salaries_account_id uuid,
  add column charges_paid_on date,
  add column charges_account_id uuid,
  add foreign key (company_id, salaries_account_id) references public.accounts (company_id, id),
  add foreign key (company_id, charges_account_id) references public.accounts (company_id, id);

-- ------------------------------------------------------------------ Auxiliares

-- El vencimiento de las cargas sociales de un mes aaaa-mm: el día 10 del mes siguiente (chargesDue).
create function private.payroll_charges_due(p_period text)
returns date
language sql
immutable
set search_path = ''
as $$ select ((p_period || '-10')::date + interval '1 month')::date $$;

-- Las cargas sociales de una liquidación: los aportes retenidos más las contribuciones (payrollCharges).
create function private.payroll_charges(p_doc uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(round(sum(l.deductions + l.employer), 2), 0) from public.payroll_lines l where l.document_id = p_doc
$$;

-- Quienes liquidaron los sueldos (SoD-6): quien preparó la liquidación y quien la confirmó (payrollLiquidators).
create function private.payroll_liquidators(p_doc public.documents)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[p_doc.created_by, (
    select e.actor_user_id from public.audit_events e
     where e.document_id = p_doc.id and e.action = 'CONFIRM'
     order by e.id
     limit 1)], null)
$$;

-- ------------------------------------------------------------------ Comandos

-- Tesorería paga desde una caja o un banco con saldo: primero los sueldos (los netos de
-- todos los empleados) y después las cargas sociales (los aportes retenidos y las
-- contribuciones). SoD-6: quien liquidó los sueldos no los paga (payPayroll).
create function private.payroll_pay(p_document_id uuid, p_account_id uuid, p_salaries boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_p public.payrolls;
  v_account public.accounts;
  v_amount numeric;
  v_balance numeric;
  v_period text;
  v_count int;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  perform private.require_transition(v_doc, 'PAY');
  v_actor := private.require_permission(v_doc.company_id, 'payroll.pay');
  if p_salaries and v_doc.status <> 'CONFIRMADA' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('Los sueldos de %s ya están pagados: faltan las cargas sociales.', v_doc.display_number));
  end if;
  if not p_salaries and v_doc.status <> 'SUELDOS_PAGADOS' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('Primero se pagan los sueldos de %s; después, sus cargas sociales.', v_doc.display_number));
  end if;
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and not private.is_supervisor(v_doc.company_id)
     and (select auth.uid()) = any (private.payroll_liquidators(v_doc)) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés pagar %s: la liquidaste vos.', v_doc.display_number),
      'Separación de funciones: quien liquida los sueldos no los paga. Tiene que pagarlos otro integrante de Tesorería.');
  end if;
  v_account := private.treasury_account(v_doc.company_id, p_account_id::text);
  v_amount := case when p_salaries then v_doc.total else private.payroll_charges(v_doc.id) end;
  v_balance := private.account_balance(v_account.id);
  select * into v_p from public.payrolls p where p.document_id = v_doc.id;
  v_period := private.period_label(v_p.period);
  if v_amount > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No alcanza el saldo de %s %s: hay %s y %s de %s son %s.', v_account.code, v_account.name,
             private.format_money(v_balance), case when p_salaries then 'los sueldos netos' else 'las cargas sociales' end,
             v_period, private.format_money(v_amount)),
      'Antes de pagar hay que controlar que haya fondos: el flujo de fondos proyectado lo anticipa.');
  end if;
  perform private.transition_document(v_doc.id, 'PAY', p_actor => v_actor,
    p_summary => format('Pagó %s de %s (%s): %s%s desde %s %s',
                        case when p_salaries then 'los sueldos' else 'las cargas sociales' end, v_period,
                        v_doc.display_number, private.format_money(v_amount),
                        case when p_salaries then ' netos' else '' end, v_account.code, v_account.name));
  if p_salaries then
    update public.payrolls
       set salaries_paid_on = private.business_date(v_doc.company_id), salaries_account_id = v_account.id
     where document_id = v_doc.id;
  else
    update public.payrolls
       set charges_paid_on = private.business_date(v_doc.company_id), charges_account_id = v_account.id
     where document_id = v_doc.id;
  end if;
  select * into v_doc from public.documents d where d.id = v_doc.id;
  select count(*) into v_count from public.payroll_lines l where l.document_id = v_doc.id;
  if v_amount > 0 then
    perform private.post_event(v_actor, v_doc, case when p_salaries then 'PAGO_SUELDOS' else 'PAGO_CARGAS_SOCIALES' end,
      case when p_salaries
        then format('Pago de los sueldos de %s (%s): %s empleado%s.', v_period, v_doc.display_number, v_count,
                    case when v_count > 1 then 's' else '' end)
        else format('Pago de las cargas sociales de %s (%s): aportes retenidos y contribuciones.', v_period,
                    v_doc.display_number)
      end,
      jsonb_build_array(
        jsonb_build_object('key', case when p_salaries then 'SUELDOS_A_PAGAR' else 'CARGAS_SOCIALES_A_PAGAR' end,
                           'debit', v_amount, 'credit', 0),
        jsonb_build_object('account_id', v_account.id, 'debit', 0, 'credit', v_amount)));
  end if;
end;
$$;

-- Pagar los sueldos de una liquidación confirmada (cmdPayPayrollSalaries).
create function public.payroll_pay_salaries(p_document_id uuid, p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.payroll_pay(p_document_id, p_account_id, true);
end;
$$;

-- Pagar las cargas sociales de una liquidación con los sueldos pagados (cmdPayPayrollCharges).
create function public.payroll_pay_charges(p_document_id uuid, p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.payroll_pay(p_document_id, p_account_id, false);
end;
$$;

grant execute on function public.payroll_pay_salaries(uuid, uuid) to authenticated;
grant execute on function public.payroll_pay_charges(uuid, uuid) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- Igual que antes, y además las cargas sociales con su vencimiento y los pagos de
-- Tesorería: el día y desde qué caja o banco (payrollView).
create or replace function private.payroll_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'period', p.period, 'payment_date', p.payment_date, 'confirmed_at', p.confirmed_at, 'rates', p.rates,
    'gross', t.gross, 'deductions', t.deductions, 'net', t.net, 'employer', t.employer, 'cost', t.cost,
    'direct_labor', t.direct_labor,
    'charges', t.charges, 'charges_due', private.payroll_charges_due(p.period),
    'salaries_paid_on', p.salaries_paid_on,
    'salaries_account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name)
                           from public.accounts a where a.id = p.salaries_account_id),
    'charges_paid_on', p.charges_paid_on,
    'charges_account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name)
                          from public.accounts a where a.id = p.charges_account_id),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no,
               'employee', jsonb_build_object('id', e.id, 'file_number', e.file_number, 'first_name', e.first_name,
                                              'last_name', e.last_name, 'hire_date', e.hire_date),
               'category', jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name),
               'sector', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name),
               'work_center', case when w.id is null then null
                                   else jsonb_build_object('id', w.id, 'code', w.code, 'name', w.name) end,
               'basic_salary', l.basic_salary, 'seniority_years', l.seniority_years, 'is_direct_labor', l.is_direct_labor,
               'days_worked', l.days_worked, 'absence_days', l.absence_days, 'overtime_50', l.overtime_50,
               'overtime_100', l.overtime_100, 'basic', l.basic, 'seniority', l.seniority, 'attendance', l.attendance,
               'overtime', l.overtime, 'gross', l.gross, 'retirement', l.retirement, 'pami', l.pami, 'health', l.health,
               'deductions', l.deductions, 'net', l.net, 'employer', l.employer)
             order by l.line_no)
        from public.payroll_lines l
        join public.employees e on e.id = l.employee_id
        join public.job_categories c on c.id = l.category_id
        join public.sectors s on s.id = e.sector_id
        left join public.work_centers w on w.id = l.work_center_id
       where l.document_id = p.document_id), '[]'))
    from public.payrolls p
    cross join lateral (
      select coalesce(round(sum(x.gross), 2), 0) as gross,
             coalesce(round(sum(x.deductions), 2), 0) as deductions,
             coalesce(round(sum(x.net), 2), 0) as net,
             coalesce(round(sum(x.employer), 2), 0) as employer,
             coalesce(round(sum(x.gross + x.employer), 2), 0) as cost,
             coalesce(round(sum(x.gross + x.employer) filter (where x.is_direct_labor), 2), 0) as direct_labor,
             coalesce(round(sum(x.deductions + x.employer), 2), 0) as charges
        from public.payroll_lines x where x.document_id = p.document_id
    ) as t
   where p.document_id = p_doc.id
$$;

-- La mano de obra del taller de un mes, por centro de trabajo: la aplicada a las órdenes
-- terminadas en el mes (el día de su ingreso al stock) contra la real de la liquidación
-- del mes, si está confirmada (laborVariance).
create function public.labor_variance(p_company_id uuid, p_period text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payroll public.documents;
begin
  perform private.require_read(p_company_id, 'payroll.read');
  if coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  select d.* into v_payroll
    from public.documents d join public.payrolls p on p.document_id = d.id
   where d.company_id = p_company_id and d.status <> 'ANULADA' and p.period = p_period
   order by d.number
   limit 1;
  return (
    with staff as (
      select l.work_center_id, l.gross + l.employer as cost
        from public.payroll_lines l
       where v_payroll.id is not null and v_payroll.status <> 'BORRADOR'
         and l.document_id = v_payroll.id and l.is_direct_labor
    ),
    orders as (
      select d.id, d.display_number, d.number
        from public.documents d
       where d.company_id = p_company_id and d.doc_type = 'PRODUCTION_ORDER' and d.status = 'TERMINADA'
         and to_char((select m.movement_date from public.stock_movements m
                       where m.document_id = d.id and m.movement_type = 'INGRESO_PRODUCCION'
                       order by m.id limit 1), 'YYYY-MM') = p_period
    ),
    ops as (
      select o.work_center_id, coalesce(o.hours_actual, o.hours_planned) as hours,
             round(coalesce(o.hours_actual, o.hours_planned) * o.labor_rate, 2) as applied
        from public.production_order_operations o join orders x on x.id = o.document_id
    ),
    centers as (
      select s.work_center_id from staff s
      union
      select o.work_center_id from ops o
    ),
    rows as (
      select c.work_center_id, w.code, w.name, w.labor_rate,
             coalesce((select round(sum(o.hours), 3) from ops o
                        where o.work_center_id is not distinct from c.work_center_id), 0) as hours,
             coalesce((select round(sum(o.applied), 2) from ops o
                        where o.work_center_id is not distinct from c.work_center_id), 0) as applied,
             coalesce((select round(sum(s.cost), 2) from staff s
                        where s.work_center_id is not distinct from c.work_center_id), 0) as real,
             (select count(*) from staff s where s.work_center_id is not distinct from c.work_center_id) as employees
        from centers c left join public.work_centers w on w.id = c.work_center_id
    )
    select jsonb_build_object(
      'period', p_period,
      'payroll', case when v_payroll.id is null then null else jsonb_build_object(
        'id', v_payroll.id, 'display_number', v_payroll.display_number, 'path', private.doc_path(v_payroll.id),
        'status_info', private.status_info(v_payroll.doc_type, v_payroll.status)) end,
      'orders', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'display_number', x.display_number, 'path', private.doc_path(x.id))
                         order by x.number)
          from orders x), '[]'),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'work_center', case when r.work_center_id is null then null else jsonb_build_object(
                   'id', r.work_center_id, 'code', r.code, 'name', r.name, 'labor_rate', r.labor_rate) end,
                 'hours', r.hours, 'applied', r.applied, 'real', r.real, 'employees', r.employees,
                 'difference', r.applied - r.real)
               order by r.code collate "C" nulls last)
          from rows r), '[]'),
      'hours', coalesce((select sum(r.hours) from rows r), 0),
      'applied', coalesce((select sum(r.applied) from rows r), 0),
      'real', coalesce((select sum(r.real) from rows r), 0),
      'difference', coalesce((select sum(r.applied) - sum(r.real) from rows r), 0))
  );
end;
$$;

grant execute on function public.labor_variance(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Flujo de fondos: los sueldos y las cargas sociales

-- Igual que antes, y los pagos de una liquidación son sueldos y cargas sociales (cashConcept).
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
    when (select x.doc_type from source x) = 'PAYROLL' then 'SUELDOS'
    when (select x.doc_type from source x) = 'FUNDS_TRANSFER' then 'TRANSFERENCIAS'
    when (select je.origin from public.journal_entries je join base b on je.document_id = b.id) = 'APERTURA' then 'APERTURA'
    else 'OTROS'
  end
$$;

-- Igual que antes, con el concepto "Sueldos y cargas sociales" (cashFlow).
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
             ('SUELDOS', 'Sueldos y cargas sociales', 4), ('TRANSFERENCIAS', 'Movimientos entre cajas y bancos', 5),
             ('OTROS', 'Otros asientos de Contabilidad', 6)
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

-- Igual que antes, y además los sueldos sin pagar (en su fecha de pago) y las cargas
-- sociales sin pagar (en su vencimiento): el saldo tras cada tramo también los resta (cashProjection).
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
    payroll as (
      select x.days, x.amount
        from (
          select p.payment_date - v_today as days, d.total as amount
            from public.documents d join public.payrolls p on p.document_id = d.id
           where d.company_id = p_company_id and d.status = 'CONFIRMADA'
          union all
          select private.payroll_charges_due(p.period) - v_today, private.payroll_charges(d.id)
            from public.documents d join public.payrolls p on p.document_id = d.id
           where d.company_id = p_company_id and d.status in ('CONFIRMADA', 'SUELDOS_PAGADOS')
        ) as x
       where x.amount > 0
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
               where r.pending > 0 and (b.lo is null or r.days >= b.lo) and (b.hi is null or r.days <= b.hi)) as receivables,
             coalesce((select sum(s.amount) from payroll s
                        where (b.lo is null or s.days >= b.lo) and (b.hi is null or s.days <= b.hi)), 0) as payroll,
             (select count(*) from payroll s
               where (b.lo is null or s.days >= b.lo) and (b.hi is null or s.days <= b.hi)) as payroll_items
        from buckets b
        left join pending p on (b.lo is null or p.days >= b.lo) and (b.hi is null or p.days <= b.hi)
       group by b.key, b.label, b.sort, b.lo, b.hi
    ),
    running as (
      select t.*, v_balance + sum(t.collections - t.payments - t.payroll) over (order by t.sort) as balance from totals t
    )
    select jsonb_build_object(
      'today', v_today,
      'balance', v_balance,
      'buckets', (
        select jsonb_agg(jsonb_build_object('key', r.key, 'label', r.label, 'collections', r.collections,
                                            'receivables', r.receivables, 'payments', r.payments,
                                            'invoices', r.invoices, 'payroll', r.payroll,
                                            'payroll_items', r.payroll_items, 'balance', r.balance) order by r.sort)
          from running r),
      'shortfall', (select r.key from running r where r.balance < 0 order by r.sort limit 1)
    )
  );
end;
$$;

-- ------------------------------------------------------------------ Lecturas comunes, con los pagos de la liquidación

-- Igual que antes, y la cabecera de la liquidación con sus pagos (document_json).
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
$$;

-- Igual que antes, y con los sueldos pagados Tesorería paga las cargas sociales (nextStep).
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
        'text', 'Cargar las novedades del mes de cada empleado (días trabajados, ausencias sin aviso y horas extra), revisar los recibos y confirmar la liquidación: se registra el asiento de sueldos.');
    when 'PAYROLL:CONFIRMADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar los sueldos el %s: %s netos. Los aportes retenidos y las contribuciones quedan en Cargas sociales a pagar hasta que se depositen.',
                       coalesce((select to_char(x.payment_date, 'DD/MM/YYYY') from public.payrolls x
                                  where x.document_id = p_doc.id), '—'),
                       private.format_money(p_doc.total)));
    when 'PAYROLL:SUELDOS_PAGADOS' then
      return (
        select jsonb_build_object('who', 'Tesorería',
          'text', format('Pagar las cargas sociales antes del %s: %s entre los aportes retenidos a los empleados y las contribuciones de la empresa.',
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

-- Igual que antes, y SoD-6: quien liquidó los sueldos no los paga (availableActions).
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
    if p_doc.doc_type = 'PAYROLL' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and v_uid = any (private.payroll_liquidators(p_doc)) then
      v_reason := 'Separación de funciones: liquidaste estos sueldos; tiene que pagarlos otro integrante de Tesorería.';
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
    if p_doc.doc_type = 'PRODUCTION_ORDER' and v_tr.action = 'RELEASE' and private.production_shortages(p_doc) is not null then
      v_reason := format('Faltan materiales: %s.', private.production_shortages(p_doc));
    end if;
    if p_doc.doc_type = 'SALES_QUOTE' then
      if v_tr.action in ('SEND', 'CONFIRM') and private.sales_quote_expired(p_doc) then
        v_reason := format('La oferta venció el %s: prepará otro presupuesto con los precios del día.',
                           (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id));
      end if;
      if v_tr.action = 'CLOSE' and not private.sales_quote_expired(p_doc) then
        v_reason := format('Vale hasta el %s: todavía no venció.',
                           (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id));
      end if;
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
