-- 113. Fase 7d.1 (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §5): el tablero de control. Gerencia,
-- Auditoría y el docente (dashboard.read) ven el mes elegido contra el anterior, desde el libro mayor (lo
-- que se movió en el mes y los saldos al cierre, o a hoy en el mes en curso) y el Banco Aula. Cada área
-- aparece si quien mira puede leer lo que la sostiene (ledger.read, y bank.read para el saldo según el
-- banco). Traducción de "Tablero de control (7d.1)" de queries.ts.

-- ------------------------------------------------------------------ Auxiliares

-- Debe menos haber de las cuentas de esos rubros (el código o sus subcuentas) entre dos fechas, según
-- los asientos registrados; sin desde, desde el principio (controlPanel).
create function private.ledger_net(p_company uuid, p_prefixes text[], p_from date, p_to date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(round(sum(l.debit - l.credit), 2), 0)
    from public.journal_entry_lines l
    join public.documents d on d.id = l.document_id
    join public.journal_entries je on je.document_id = d.id
    join public.accounts a on a.id = l.account_id
   where d.company_id = p_company and je.entry_number is not null
     and d.document_date <= p_to and (p_from is null or d.document_date >= p_from)
     and exists (select 1 from unnest(p_prefixes) as p (code) where a.code = p.code or a.code like p.code || '.%')
$$;

-- Un indicador del tablero: el valor del mes elegido y el del anterior (ControlIndicator).
create function private.control_indicator(p_key text, p_label text, p_value numeric, p_previous numeric,
                                          p_better text, p_hint text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('key', p_key, 'label', p_label, 'value', p_value, 'previous', p_previous,
                            'better', p_better, 'hint', p_hint)
$$;

-- ------------------------------------------------------------------ Lecturas nuevas

-- El tablero de control (controlPanel): el mes elegido (aaaa-mm) contra el anterior, por área.
create function public.control_panel(p_company_id uuid, p_period text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_from date;
  v_to date;
  v_pfrom date;
  v_pto date;
  v_ledger boolean;
  v_bank uuid;
  v_sales numeric;
  v_psales numeric;
  v_cost numeric;
  v_pcost numeric;
  v_areas jsonb := '[]';
  v_treasury jsonb := '[]';
begin
  perform private.require_read(p_company_id, 'dashboard.read');
  if coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el mes: el año y el mes, como 2026-11.');
  end if;
  v_today := private.business_date(p_company_id);
  if p_period > to_char(v_today, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO', 'Ese mes todavía no empezó: elegí el actual o uno anterior.');
  end if;
  v_from := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_to := case when p_period = to_char(v_today, 'YYYY-MM') then v_today
               else (v_from + interval '1 month' - interval '1 day')::date end;
  v_pfrom := (v_from - interval '1 month')::date;
  v_pto := v_from - 1;
  v_ledger := private.has_permission(p_company_id, 'ledger.read');
  if v_ledger then
    v_sales := -private.ledger_net(p_company_id, array['4.1'], v_from, v_to);
    v_psales := -private.ledger_net(p_company_id, array['4.1'], v_pfrom, v_pto);
    v_cost := private.ledger_net(p_company_id, array['5.1.01'], v_from, v_to);
    v_pcost := private.ledger_net(p_company_id, array['5.1.01'], v_pfrom, v_pto);
    v_areas := v_areas || jsonb_build_array(
      jsonb_build_object('key', 'RESULTADOS', 'title', 'Resultados', 'indicators', jsonb_build_array(
        private.control_indicator('VENTAS', 'Ventas', v_sales, v_psales, 'UP',
          'Ingresos operativos del mes (cuentas 4.1).'),
        private.control_indicator('COSTO_VENTAS', 'Costo de lo vendido', v_cost, v_pcost, null,
          'Cuentas 5.1.01 del mes.'),
        private.control_indicator('MARGEN', 'Margen bruto', v_sales - v_cost, v_psales - v_pcost, 'UP',
          'Ventas menos costo de lo vendido.'),
        private.control_indicator('RESULTADO', 'Resultado del mes',
          -private.ledger_net(p_company_id, array['4', '5'], v_from, v_to),
          -private.ledger_net(p_company_id, array['4', '5'], v_pfrom, v_pto), 'UP',
          'Todos los ingresos (4) menos todos los egresos (5) del mes.'))),
      jsonb_build_object('key', 'PERSONAL', 'title', 'Personal', 'indicators', jsonb_build_array(
        private.control_indicator('COSTO_LABORAL', 'Costo laboral',
          private.ledger_net(p_company_id, array['5.2.01', '5.1.03'], v_from, v_to),
          private.ledger_net(p_company_id, array['5.2.01', '5.1.03'], v_pfrom, v_pto), null,
          'Sueldos, cargas sociales y mano de obra directa del mes (5.2.01 y 5.1.03).'))),
      jsonb_build_object('key', 'TERCEROS', 'title', 'Clientes y proveedores', 'indicators', jsonb_build_array(
        private.control_indicator('DEUDA_CLIENTES', 'Deuda de los clientes',
          private.ledger_net(p_company_id, array['1.1.03'], null, v_to),
          private.ledger_net(p_company_id, array['1.1.03'], null, v_pto), null,
          'Saldo de las cuentas 1.1.03 al cierre.'),
        private.control_indicator('DEUDA_PROVEEDORES', 'Deuda con los proveedores',
          -private.ledger_net(p_company_id, array['2.1.01'], null, v_to),
          -private.ledger_net(p_company_id, array['2.1.01'], null, v_pto), null,
          'Saldo de las cuentas 2.1.01 al cierre.'))),
      jsonb_build_object('key', 'STOCK', 'title', 'Stock', 'indicators', jsonb_build_array(
        private.control_indicator('BIENES_DE_CAMBIO', 'Bienes de cambio',
          private.ledger_net(p_company_id, array['1.1.05'], null, v_to),
          private.ledger_net(p_company_id, array['1.1.05'], null, v_pto), null,
          'Saldo de las cuentas 1.1.05 al cierre.'))));
    v_treasury := v_treasury || jsonb_build_array(
      private.control_indicator('DISPONIBLE', 'Disponible',
        private.ledger_net(p_company_id, array['1.1.01'], null, v_to),
        private.ledger_net(p_company_id, array['1.1.01'], null, v_pto), 'UP',
        'Cajas y bancos (1.1.01) al cierre, según los libros.'));
  end if;
  select b.id into v_bank from public.bank_accounts b
   where b.company_id = p_company_id and b.is_active
   order by b.created_at, b.id
   limit 1;
  if v_bank is not null and private.has_permission(p_company_id, 'bank.read') then
    v_treasury := v_treasury || jsonb_build_array(
      private.control_indicator('SALDO_BANCO', 'Saldo según el banco', private.bank_balance_at(v_bank, v_to),
        private.bank_balance_at(v_bank, v_pto), 'UP', 'Lo que procesó el Banco Aula hasta el cierre.'));
  end if;
  if v_ledger then
    v_treasury := v_treasury || jsonb_build_array(
      private.control_indicator('PRESTAMOS', 'Préstamos bancarios',
        -private.ledger_net(p_company_id, array['2.1.02'], null, v_to),
        -private.ledger_net(p_company_id, array['2.1.02'], null, v_pto), 'DOWN',
        'Saldo de las cuentas 2.1.02 al cierre.'));
  end if;
  if jsonb_array_length(v_treasury) > 0 then
    v_areas := v_areas || jsonb_build_array(
      jsonb_build_object('key', 'TESORERIA', 'title', 'Tesorería y banco', 'indicators', v_treasury));
  end if;
  if v_ledger then
    v_areas := v_areas || jsonb_build_array(
      jsonb_build_object('key', 'IMPUESTOS', 'title', 'Impuestos', 'indicators', jsonb_build_array(
        private.control_indicator('DEUDAS_FISCALES', 'Deudas fiscales',
          -private.ledger_net(p_company_id, array['2.1.04'], null, v_to),
          -private.ledger_net(p_company_id, array['2.1.04'], null, v_pto), 'DOWN',
          'IVA e ingresos brutos (2.1.04) al cierre.'),
        private.control_indicator('INTERESES_MULTAS', 'Intereses y multas fiscales',
          private.ledger_net(p_company_id, array['5.3.01.04', '5.3.02.03'], v_from, v_to),
          private.ledger_net(p_company_id, array['5.3.01.04', '5.3.02.03'], v_pfrom, v_pto), 'DOWN',
          'Intereses resarcitorios y multas del fisco del mes (5.3.01.04 y 5.3.02.03).'))));
  end if;
  return jsonb_build_object('period', p_period, 'previous', to_char(v_pfrom, 'YYYY-MM'), 'to', v_to,
                            'previous_to', v_pto, 'areas', v_areas);
end;
$$;

grant execute on function public.control_panel(uuid, text) to authenticated;
