-- 50. Fase 6b (docs/FASE_6_RRHH_Y_SUELDOS.md §3): la liquidación de sueldos de un
-- mes (LIQ): las novedades de cada empleado, el cálculo de cada recibo con los
-- porcentajes de la empresa (que el docente puede cambiar) y el asiento de sueldos
-- al confirmarla, con el taller como mano de obra directa. Traducción de la sección
-- "Liquidación de sueldos" de src/lib/mock/engine.ts y de sus lecturas en queries.ts.
--
-- El tipo de documento, sus estados, transiciones, tarea y claves de imputación están
-- en la migración de catálogos siguiente; la cuenta nueva y sus reglas, en la de la
-- plantilla.

-- ------------------------------------------------------------------ Tablas

-- La liquidación: el mes, la fecha de pago y los porcentajes con que se calculó.
create table public.payrolls (
  document_id uuid primary key,
  doc_type text not null default 'PAYROLL' check (doc_type = 'PAYROLL'),
  company_id uuid not null,
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  payment_date date not null,
  rates jsonb not null,
  confirmed_at timestamptz,
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade
);
create index payrolls_period_idx on public.payrolls (company_id, period);

-- Lo de un empleado: copias de su categoría y antigüedad, sus novedades y los importes.
create table public.payroll_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  employee_id uuid not null,
  category_id uuid not null,
  basic_salary numeric(14, 2) not null,
  seniority_years int not null check (seniority_years >= 0),
  is_direct_labor boolean not null,
  work_center_id uuid,
  days_worked int not null check (days_worked between 0 and 30),
  absence_days int not null check (absence_days between 0 and 30),
  overtime_50 numeric(6, 2) not null default 0 check (overtime_50 between 0 and 200),
  overtime_100 numeric(6, 2) not null default 0 check (overtime_100 between 0 and 200),
  basic numeric(14, 2) not null,
  seniority numeric(14, 2) not null,
  attendance numeric(14, 2) not null,
  overtime numeric(14, 2) not null,
  gross numeric(14, 2) not null,                                    -- remunerativo
  retirement numeric(14, 2) not null,
  pami numeric(14, 2) not null,
  health numeric(14, 2) not null,
  deductions numeric(14, 2) not null,
  net numeric(14, 2) not null,
  employer numeric(14, 2) not null,                                 -- contribuciones de la empresa
  unique (document_id, line_no),
  unique (company_id, id),
  check (days_worked + absence_days <= 30),
  foreign key (company_id, document_id) references public.payrolls (company_id, document_id) on delete cascade,
  foreign key (company_id, employee_id) references public.employees (company_id, id),
  foreign key (company_id, category_id) references public.job_categories (company_id, id),
  foreign key (company_id, work_center_id) references public.work_centers (company_id, id)
);
create index payroll_lines_employee_idx on public.payroll_lines (employee_id);

do $$
declare
  t text;
begin
  foreach t in array array['payrolls', 'payroll_lines'] loop
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

create policy payrolls_select on public.payrolls for select to authenticated
  using (company_id in (select private.companies_with_permission('payroll.read')));
create policy payroll_lines_select on public.payroll_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('payroll.read')));

-- ------------------------------------------------------------------ Auxiliares

-- Los porcentajes de la empresa para liquidar: los que configuró el docente y, los
-- demás, por defecto (payrollRates y PAYROLL_DEFAULT_RATES).
create function private.payroll_rates(p_company uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('seniority_pct', 1, 'attendance_pct', 8.33, 'retirement_pct', 11, 'pami_pct', 3,
                            'health_pct', 3, 'employer_pct', 24)
         || coalesce((select c.settings -> 'payroll' from public.companies c where c.id = p_company), '{}')
$$;

-- "05/2027": el mes liquidado, para los textos (periodLabel).
create function private.period_label(p_period text)
returns text
language sql
immutable
set search_path = ''
as $$ select substr(p_period, 6, 2) || '/' || substr(p_period, 1, 4) $$;

-- El último día de un mes aaaa-mm (periodEnd).
create function private.period_end(p_period text)
returns date
language sql
immutable
set search_path = ''
as $$ select ((p_period || '-01')::date + interval '1 month' - interval '1 day')::date $$;

-- Los importes de un empleado, cada concepto redondeado a centavos (payrollAmounts).
create function private.payroll_amounts(p_rates jsonb, p_basic numeric, p_years int, p_days int, p_absences int,
                                        p_overtime_50 numeric, p_overtime_100 numeric)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_basic numeric := round(p_basic * p_days / 30, 2);
  v_seniority numeric := round(v_basic * (p_rates ->> 'seniority_pct')::numeric * p_years / 100, 2);
  v_attendance numeric := case when p_absences = 0
    then round((v_basic + v_seniority) * (p_rates ->> 'attendance_pct')::numeric / 100, 2) else 0 end;
  v_hourly numeric := round((p_basic + round(p_basic * (p_rates ->> 'seniority_pct')::numeric * p_years / 100, 2)) / 200, 2);
  v_overtime numeric := round(round(v_hourly * 1.5 * p_overtime_50, 2) + round(v_hourly * 2 * p_overtime_100, 2), 2);
  v_gross numeric := round(v_basic + v_seniority + v_attendance + v_overtime, 2);
  v_retirement numeric := round(v_gross * (p_rates ->> 'retirement_pct')::numeric / 100, 2);
  v_pami numeric := round(v_gross * (p_rates ->> 'pami_pct')::numeric / 100, 2);
  v_health numeric := round(v_gross * (p_rates ->> 'health_pct')::numeric / 100, 2);
  v_deductions numeric := round(v_retirement + v_pami + v_health, 2);
begin
  return jsonb_build_object(
    'basic', v_basic, 'seniority', v_seniority, 'attendance', v_attendance, 'overtime', v_overtime, 'gross', v_gross,
    'retirement', v_retirement, 'pami', v_pami, 'health', v_health, 'deductions', v_deductions,
    'net', round(v_gross - v_deductions, 2),
    'employer', round(v_gross * (p_rates ->> 'employer_pct')::numeric / 100, 2));
end;
$$;

-- Los totales de la liquidación: el remunerativo (subtotal) y los netos a pagar (total).
create function private.payroll_set_totals(p_doc uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.documents d
     set subtotal = t.gross, total = t.net
    from (select coalesce(round(sum(l.gross), 2), 0) as gross, coalesce(round(sum(l.net), 2), 0) as net
            from public.payroll_lines l where l.document_id = p_doc) as t
   where d.id = p_doc
$$;

-- ------------------------------------------------------------------ Comandos

-- RRHH prepara la liquidación de un mes con el personal activo que ingresó hasta el
-- fin del mes (cmdCreatePayroll). p_input: {period, payment_date, notes}
create function public.payroll_create(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'payroll.create');
  v_company public.companies;
  v_period text := coalesce(p_input ->> 'period', '');
  v_payment date;
  v_notes text := trim(coalesce(p_input ->> 'notes', ''));
  v_other public.documents;
  v_end date;
  v_count int;
  v_rates jsonb;
  v_doc public.documents;
begin
  select * into v_company from public.companies c where c.id = p_company_id;
  if v_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  if v_period > to_char(private.business_date(p_company_id), 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO', 'Ese mes todavía no empezó: no se puede liquidar.');
  end if;
  if v_period < to_char(v_company.start_date, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La empresa empezó sus actividades el %s: no hay sueldos antes.', to_char(v_company.start_date, 'DD/MM/YYYY')));
  end if;
  select d.* into v_other
    from public.documents d join public.payrolls p on p.document_id = d.id
   where d.company_id = p_company_id and d.status <> 'ANULADA' and p.period = v_period
   order by d.number limit 1;
  if v_other.id is not null then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Ya hay una liquidación de %s: %s.', private.period_label(v_period), v_other.display_number));
  end if;
  v_payment := private.parse_date(p_input ->> 'payment_date');
  if v_payment is null then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de pago no es válida.');
  end if;
  if v_payment < (v_period || '-01')::date then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de pago no puede ser anterior al mes liquidado.');
  end if;
  if length(v_notes) > 500 then
    perform private.raise_business_error('DATO_INVALIDO', 'Las observaciones tienen hasta 500 caracteres.');
  end if;
  v_end := private.period_end(v_period);
  select count(*) into v_count
    from public.employees e where e.company_id = p_company_id and e.status = 'ACTIVO' and e.hire_date <= v_end;
  if v_count = 0 then
    perform private.raise_business_error('DATO_INVALIDO',
      format('No hay personal activo para liquidar %s.', private.period_label(v_period)));
  end if;
  v_rates := private.payroll_rates(p_company_id);
  v_doc := private.new_document(p_company_id, 'PAYROLL', v_actor, null, v_notes);
  insert into public.payrolls (document_id, company_id, period, payment_date, rates)
  values (v_doc.id, p_company_id, v_period, v_payment, v_rates);
  insert into public.payroll_lines (company_id, document_id, line_no, employee_id, category_id, basic_salary, seniority_years,
                                    is_direct_labor, work_center_id, days_worked, absence_days, overtime_50, overtime_100,
                                    basic, seniority, attendance, overtime, gross, retirement, pami, health, deductions, net,
                                    employer)
  select p_company_id, v_doc.id, x.line_no, x.employee_id, x.category_id, x.basic_salary, x.years, x.is_direct_labor,
         x.work_center_id, x.days, 0, 0, 0,
         (y.a ->> 'basic')::numeric, (y.a ->> 'seniority')::numeric, (y.a ->> 'attendance')::numeric,
         (y.a ->> 'overtime')::numeric, (y.a ->> 'gross')::numeric, (y.a ->> 'retirement')::numeric,
         (y.a ->> 'pami')::numeric, (y.a ->> 'health')::numeric, (y.a ->> 'deductions')::numeric,
         (y.a ->> 'net')::numeric, (y.a ->> 'employer')::numeric
    from (
      select row_number() over (order by e.file_number)::int as line_no, e.id as employee_id, c.id as category_id,
             c.basic_salary, c.is_direct_labor, e.work_center_id,
             extract(year from age(v_end, e.hire_date))::int as years,
             -- Quien ingresó en el mes cobra desde su ingreso (mes comercial de 30 días).
             case when to_char(e.hire_date, 'YYYY-MM') = v_period
               then 31 - least(extract(day from e.hire_date)::int, 30) else 30 end as days
        from public.employees e join public.job_categories c on c.id = e.category_id
       where e.company_id = p_company_id and e.status = 'ACTIVO' and e.hire_date <= v_end
    ) as x
    cross join lateral (
      select private.payroll_amounts(v_rates, x.basic_salary, x.years, x.days, 0, 0, 0) as a
    ) as y;
  perform private.payroll_set_totals(v_doc.id);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'payroll', v_doc.id, v_doc.display_number,
    format('Creó %s: sueldos de %s (%s empleado%s)', v_doc.display_number, private.period_label(v_period), v_count,
           case when v_count > 1 then 's' else '' end),
    v_doc.id, null, 'BORRADOR');
  perform private.open_tasks_for_status(v_doc.id, v_actor);
  return private.created_result(v_doc.id);
end;
$$;

-- Cambia las novedades de la liquidación en borrador y recalcula los importes
-- (cmdUpdatePayrollLines). p_lines: [{line_id, days_worked, absence_days, overtime_50, overtime_100}]
create function public.payroll_update_lines(p_document_id uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_rates jsonb;
  v_line jsonb;
  v_l public.payroll_lines;
  v_seen uuid[] := '{}';
  v_who text;
  v_days numeric;
  v_absences numeric;
  v_overtime_50 numeric;
  v_overtime_100 numeric;
  v_a jsonb;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  v_actor := private.require_permission(v_doc.company_id, 'payroll.create');
  if v_doc.status <> 'BORRADOR' then
    perform private.raise_business_error('TRANSICION_INVALIDA', 'Sólo se cambian las novedades de una liquidación en borrador.');
  end if;
  select p.rates into v_rates from public.payrolls p where p.document_id = v_doc.id;
  -- Primero se controla todo; después se recalcula.
  for v_line in select l from jsonb_array_elements(coalesce(p_lines, '[]')) as l loop
    select * into v_l from public.payroll_lines x where x.id::text = v_line ->> 'line_id' and x.document_id = v_doc.id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Uno de los empleados no es de la liquidación.');
    end if;
    if v_l.id = any (v_seen) then
      perform private.raise_business_error('DATO_INVALIDO', 'Un empleado está dos veces: indicá sus novedades una sola vez.');
    end if;
    v_seen := v_seen || v_l.id;
    select e.last_name || ', ' || e.first_name into v_who from public.employees e where e.id = v_l.employee_id;
    v_days := (v_line ->> 'days_worked')::numeric;
    v_absences := (v_line ->> 'absence_days')::numeric;
    if v_days is null or v_absences is null or v_days <> trunc(v_days) or v_absences <> trunc(v_absences)
       or v_days < 0 or v_days > 30 or v_absences < 0 or v_absences > 30 or v_days + v_absences > 30 then
      perform private.raise_business_error('DATO_INVALIDO',
        format('Los días trabajados y las ausencias de %s son enteros que juntos no pasan de 30.', v_who));
    end if;
    v_overtime_50 := (v_line ->> 'overtime_50')::numeric;
    v_overtime_100 := (v_line ->> 'overtime_100')::numeric;
    if v_overtime_50 is null or v_overtime_100 is null or v_overtime_50 < 0 or v_overtime_50 > 200
       or v_overtime_100 < 0 or v_overtime_100 > 200 or round(v_overtime_50, 2) <> v_overtime_50
       or round(v_overtime_100, 2) <> v_overtime_100 then
      perform private.raise_business_error('DATO_INVALIDO',
        format('Las horas extra de %s van de 0 a 200, con hasta 2 decimales.', v_who));
    end if;
  end loop;
  for v_line in select l from jsonb_array_elements(coalesce(p_lines, '[]')) as l loop
    select * into v_l from public.payroll_lines x where x.id::text = v_line ->> 'line_id';
    v_a := private.payroll_amounts(v_rates, v_l.basic_salary, v_l.seniority_years, (v_line ->> 'days_worked')::int,
                                   (v_line ->> 'absence_days')::int, (v_line ->> 'overtime_50')::numeric,
                                   (v_line ->> 'overtime_100')::numeric);
    update public.payroll_lines
       set days_worked = (v_line ->> 'days_worked')::int, absence_days = (v_line ->> 'absence_days')::int,
           overtime_50 = (v_line ->> 'overtime_50')::numeric, overtime_100 = (v_line ->> 'overtime_100')::numeric,
           basic = (v_a ->> 'basic')::numeric, seniority = (v_a ->> 'seniority')::numeric,
           attendance = (v_a ->> 'attendance')::numeric, overtime = (v_a ->> 'overtime')::numeric,
           gross = (v_a ->> 'gross')::numeric, retirement = (v_a ->> 'retirement')::numeric,
           pami = (v_a ->> 'pami')::numeric, health = (v_a ->> 'health')::numeric,
           deductions = (v_a ->> 'deductions')::numeric, net = (v_a ->> 'net')::numeric,
           employer = (v_a ->> 'employer')::numeric
     where id = v_l.id;
  end loop;
  perform private.payroll_set_totals(v_doc.id);
  perform private.log_audit(v_doc.company_id, v_actor, 'UPDATE', 'payroll', v_doc.id, v_doc.display_number,
    format('Cambió las novedades de %s', v_doc.display_number), v_doc.id);
end;
$$;

-- Confirmar: quedan los recibos y se registra el asiento de sueldos; el taller, como
-- mano de obra directa (cmdConfirmPayroll).
create function public.payroll_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_p public.payrolls;
  v_t record;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  perform private.require_transition(v_doc, 'CONFIRM');
  perform private.require_permission(v_doc.company_id, 'payroll.create');
  select * into v_p from public.payrolls p where p.document_id = v_doc.id;
  select count(*) as n,
         coalesce(round(sum(l.gross), 2), 0) as gross,
         coalesce(round(sum(l.net), 2), 0) as net,
         coalesce(round(sum(l.deductions + l.employer), 2), 0) as charges,
         coalesce(round(sum(l.gross) filter (where not l.is_direct_labor), 2), 0) as others_gross,
         coalesce(round(sum(l.employer) filter (where not l.is_direct_labor), 2), 0) as others_employer,
         coalesce(round(sum(l.gross + l.employer) filter (where l.is_direct_labor), 2), 0) as direct
    into v_t
    from public.payroll_lines l where l.document_id = v_doc.id;
  if v_t.gross <= 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'La liquidación no tiene importes: revisá los días trabajados.');
  end if;
  v_actor := private.transition_document(v_doc.id, 'CONFIRM',
    p_summary => format('Confirmó %s: sueldos de %s, %s netos a pagar', v_doc.display_number,
                        private.period_label(v_p.period), private.format_money(v_doc.total)));
  update public.payrolls set confirmed_at = now() where document_id = v_doc.id;
  perform private.post_event(v_actor, v_doc, 'SUELDOS',
    format('Sueldos de %s (%s): %s empleado%s.', private.period_label(v_p.period), v_doc.display_number, v_t.n,
           case when v_t.n > 1 then 's' else '' end),
    jsonb_build_array(
      jsonb_build_object('key', 'REMUNERACIONES', 'debit', v_t.others_gross, 'credit', 0),
      jsonb_build_object('key', 'CONTRIBUCIONES', 'debit', v_t.others_employer, 'credit', 0),
      jsonb_build_object('key', 'MANO_DE_OBRA_DIRECTA', 'debit', v_t.direct, 'credit', 0),
      jsonb_build_object('key', 'SUELDOS_A_PAGAR', 'debit', 0, 'credit', v_t.net),
      jsonb_build_object('key', 'CARGAS_SOCIALES_A_PAGAR', 'debit', 0, 'credit', v_t.charges)));
end;
$$;

-- Anular: la que está en borrador, sin más; la confirmada, con el contraasiento del de
-- sueldos (cmdCancelPayroll).
create function public.payroll_cancel(p_document_id uuid, p_reason text)
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
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  if v_doc.status <> 'CONFIRMADA' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  v_actor := private.require_permission(v_doc.company_id, 'payroll.cancel');
  if length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  v_entry := private.automatic_entry_of(v_doc.id);
  if v_entry.id is not null then
    v_reversal := private.reverse_journal_entry(v_entry, v_actor, format('%s anulada: %s', v_doc.display_number, v_comment), true);
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', v_comment, p_actor => v_actor,
    p_summary => format('Anuló %s%s — %s', v_doc.display_number,
                        case when v_reversal.id is not null
                          then format(': el contraasiento %s revirtió el de sueldos', v_reversal.display_number) else '' end,
                        v_comment));
end;
$$;

grant execute on function public.payroll_create(uuid, jsonb) to authenticated;
grant execute on function public.payroll_update_lines(uuid, jsonb) to authenticated;
grant execute on function public.payroll_confirm(uuid) to authenticated;
grant execute on function public.payroll_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Configuración de la empresa

-- Igual que antes, y además los porcentajes de la liquidación de sueldos, que se
-- validan (de 0 a 100, con hasta 2 decimales) (cmdUpdateCompanySettings).
create or replace function public.company_update_settings(p_company_id uuid, p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_before jsonb;
  v_after jsonb;
  v_rates jsonb;
  v_key text;
  v_value jsonb;
begin
  select c.settings into v_before from public.companies c where c.id = p_company_id for update;
  select v_before || coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_after
    from jsonb_each(p_settings)
   where key in ('sod_enabled', 'allow_negative_stock') and jsonb_typeof(value) = 'boolean';
  if jsonb_typeof(p_settings -> 'payroll') = 'object' then
    v_rates := coalesce(v_before -> 'payroll', '{}');
    foreach v_key in array array['seniority_pct', 'attendance_pct', 'retirement_pct', 'pami_pct', 'health_pct',
                                  'employer_pct'] loop
      v_value := p_settings -> 'payroll' -> v_key;
      continue when v_value is null;
      if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric < 0 or (v_value #>> '{}')::numeric > 100
         or round((v_value #>> '{}')::numeric, 2) <> (v_value #>> '{}')::numeric then
        perform private.raise_business_error('DATO_INVALIDO',
          'Los porcentajes de la liquidación van de 0 a 100, con hasta 2 decimales.');
      end if;
      v_rates := v_rates || jsonb_build_object(v_key, v_value);
    end loop;
    v_after := v_after || jsonb_build_object('payroll', v_rates);
  end if;
  update public.companies set settings = v_after where id = p_company_id;
  perform private.log_audit(p_company_id, v_actor, 'SETTINGS', 'company', p_company_id,
    (select c.legal_name from public.companies c where c.id = p_company_id),
    case when jsonb_typeof(p_settings -> 'payroll') = 'object'
      then 'Cambió los porcentajes de la liquidación de sueldos'
      else 'Cambió la configuración de control interno de la empresa' end,
    null, null, null,
    private.diff(v_before, v_after, array['sod_enabled', 'allow_negative_stock', 'payroll']));
end;
$$;

-- ------------------------------------------------------------------ Lecturas

-- La liquidación: el mes, los porcentajes, los totales y lo de cada empleado (payrollView).
create function private.payroll_view(p_doc public.documents)
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
             coalesce(round(sum(x.gross + x.employer) filter (where x.is_direct_labor), 2), 0) as direct_labor
        from public.payroll_lines x where x.document_id = p.document_id
    ) as t
   where p.document_id = p_doc.id
$$;

-- ------------------------------------------------------------------ Lecturas comunes, con la liquidación

-- Igual que antes, con la cabecera de la liquidación de sueldos (document_json).
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
               'period', x.period, 'payment_date', x.payment_date, 'rates', x.rates, 'confirmed_at', x.confirmed_at))
        from public.payrolls x where x.document_id = p_doc.id), '{}')
$$;

-- Igual que antes, con la liquidación de sueldos: sus empleados y el mes liquidado.
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

-- Igual que antes, con la liquidación de sueldos: RRHH la confirma y Tesorería la paga (nextStep).
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

-- Igual que antes, con la liquidación de sueldos: su vista, su lugar en el flujo y sus firmas.
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
                              'DELIVERY_NOTE', 'SALES_INVOICE', 'CUSTOMER_RECEIPT', 'PRODUCTION_ORDER', 'PAYROLL', 'STOCK_ADJUSTMENT',
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

-- Igual que en la 5a (la orden de producción no se libera si faltan materiales): la liquidación no tiene casos propios.
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
