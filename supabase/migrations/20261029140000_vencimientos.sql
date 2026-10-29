-- 71. Fase 7b.2 (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §3): el calendario de
-- vencimientos de un mes. Los sueldos y las cargas sociales de su liquidación (los ve quien ve
-- las liquidaciones) y los ingresos brutos y el IVA de sus declaraciones, por vencimiento, cada
-- uno pendiente, a pagar o cumplido, y vencido si pasó su fecha sin cumplirse. Sólo una
-- lectura: traducción de obligationsCalendar de src/lib/mock/queries.ts.

create function public.obligations_calendar(p_company_id uuid, p_period text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_today date;
  v_month text;
  v_payroll public.documents;
  v_p public.payrolls;
  v_waiting text;
  v_salaries_paid boolean;
  v_rows jsonb := '[]';
  v_tax text;
  v_dj public.documents;
  v_t public.tax_returns;
begin
  perform private.require_read(p_company_id, 'tax_return.read');
  if coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  select c.start_date into v_start from public.companies c where c.id = p_company_id;
  if p_period < to_char(v_start, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La empresa empezó sus actividades el %s: no hay obligaciones antes.', to_char(v_start, 'DD/MM/YYYY')));
  end if;
  v_today := private.business_date(p_company_id);
  v_month := private.period_label(p_period);
  if private.has_permission(p_company_id, 'payroll.read') then
    select d.* into v_payroll
      from public.documents d join public.payrolls p on p.document_id = d.id
     where d.company_id = p_company_id and d.status <> 'ANULADA' and p.period = p_period
     order by d.number
     limit 1;
    select * into v_p from public.payrolls p where p.document_id = v_payroll.id;
    -- Lo que falta antes de pagar: liquidarla o que Gerencia la autorice.
    v_waiting := case when v_payroll.id is null then 'Sin liquidar'
                      when v_payroll.status = 'BORRADOR' then v_payroll.display_number || ' en borrador'
                      when v_payroll.status = 'PENDIENTE_APROBACION'
                        then v_payroll.display_number || ' espera la autorización de Gerencia' end;
    v_salaries_paid := coalesce(v_payroll.status in ('SUELDOS_PAGADOS', 'PAGADA'), false);
    v_rows := v_rows || jsonb_build_array(
      jsonb_build_object(
        'kind', 'SUELDOS', 'label', 'Sueldos de ' || v_month,
        'due_date', coalesce(v_p.payment_date, private.next_month_day(p_period, 4)),
        'status', case when v_waiting is not null then 'PENDIENTE' when v_salaries_paid then 'CUMPLIDA' else 'A_PAGAR' end,
        'detail', coalesce(v_waiting, case when v_salaries_paid
                                        then 'Pagados el ' || to_char(v_p.salaries_paid_on, 'DD/MM/YYYY')
                                        else 'Autorizada: falta pagar los sueldos' end),
        'amount', v_payroll.total,
        'document', case when v_payroll.id is not null then jsonb_build_object(
          'id', v_payroll.id, 'display_number', v_payroll.display_number, 'path', private.doc_path(v_payroll.id)) end),
      jsonb_build_object(
        'kind', 'CARGAS_SOCIALES', 'label', 'Cargas sociales de ' || v_month,
        'due_date', private.payroll_charges_due(p_period),
        'status', case when v_waiting is not null then 'PENDIENTE' when v_payroll.status = 'PAGADA' then 'CUMPLIDA'
                       else 'A_PAGAR' end,
        'detail', coalesce(v_waiting, case when v_payroll.status = 'PAGADA'
                                        then 'Pagadas el ' || to_char(v_p.charges_paid_on, 'DD/MM/YYYY')
                                        else 'Falta pagarlas' end),
        'amount', case when v_payroll.id is not null then private.payroll_charges(v_payroll.id) end,
        'document', case when v_payroll.id is not null then jsonb_build_object(
          'id', v_payroll.id, 'display_number', v_payroll.display_number, 'path', private.doc_path(v_payroll.id)) end));
  end if;
  foreach v_tax in array array['IIBB', 'IVA'] loop
    select d.* into v_dj
      from public.documents d join public.tax_returns t on t.document_id = d.id
     where d.company_id = p_company_id and d.status <> 'ANULADA' and t.tax = v_tax and t.period = p_period
     order by d.number
     limit 1;
    select * into v_t from public.tax_returns t where t.document_id = v_dj.id;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'kind', v_tax, 'label', case when v_tax = 'IVA' then 'IVA' else 'Ingresos brutos' end || ' de ' || v_month,
      'due_date', private.next_month_day(p_period, case when v_tax = 'IVA' then 20 else 15 end),
      'status', case when v_dj.id is null or v_dj.status = 'BORRADOR' then 'PENDIENTE'
                     when v_dj.status = 'PRESENTADA' then 'A_PAGAR' else 'CUMPLIDA' end,
      'detail', case when v_dj.id is null then 'Sin declarar'
                     when v_dj.status = 'BORRADOR' then v_dj.display_number || ' en borrador'
                     when v_dj.status = 'PRESENTADA' then 'Presentada: falta pagarla'
                     when v_dj.status = 'SIN_SALDO' then 'Presentada sin saldo a pagar'
                     else 'Pagada el ' || to_char(v_t.paid_on, 'DD/MM/YYYY') end,
      'amount', v_dj.total,
      'document', case when v_dj.id is not null then jsonb_build_object(
        'id', v_dj.id, 'display_number', v_dj.display_number, 'path', private.doc_path(v_dj.id)) end));
  end loop;
  return jsonb_build_object(
    'period', p_period,
    'rows', coalesce((
      select jsonb_agg(r || jsonb_build_object('overdue', (r ->> 'due_date')::date < v_today and r ->> 'status' <> 'CUMPLIDA')
                       order by r ->> 'due_date', array_position(array['SUELDOS', 'CARGAS_SOCIALES', 'IIBB', 'IVA'], r ->> 'kind'))
        from jsonb_array_elements(v_rows) as r), '[]'));
end;
$$;

grant execute on function public.obligations_calendar(uuid, text) to authenticated;
