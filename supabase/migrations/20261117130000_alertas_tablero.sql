-- 114. Fase 7d.2 (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §5): las alertas del tablero de control. Arriba
-- de los indicadores, lo que requiere atención hoy (no depende del mes elegido), cada alerta con el enlace a su
-- pantalla y sólo si quien mira puede leerla. Salen de las mismas lecturas que esas pantallas (las cuentas
-- corrientes de clientes y proveedores y el flujo de fondos proyectado), para que el número coincida.
-- Traducción de "Tablero de control (7d.2)" de queries.ts (controlAlerts).

-- ------------------------------------------------------------------ Auxiliares

-- "1 producto" o "3 productos" (plural de queries.ts).
create function private.plural(p_n bigint, p_one text, p_many text)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_n || ' ' || case when p_n = 1 then p_one else p_many end
$$;

-- Una alerta del tablero (ControlAlert).
create function private.control_alert(p_key text, p_severity text, p_title text, p_detail text, p_path text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('key', p_key, 'severity', p_severity, 'title', p_title, 'detail', p_detail,
                            'path', p_path)
$$;

-- Las alertas del tablero (controlAlerts): lo que requiere atención hoy, en este orden. En rojo (danger) lo
-- que ya está en falta; en amarillo (warning), lo demás.
create function private.control_alerts(p_company uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.business_date(p_company);
  v_base text;
  v_alerts jsonb := '[]';
  v_codes text[];
  v_n bigint;
  v_late bigint;
  v_sum numeric;
  v_projection jsonb;
  v_label text;
begin
  select '/e/' || c.slug into v_base from public.companies c where c.id = p_company;
  if private.has_permission(p_company, 'stock.read') then
    select array_agg(p.code order by p.code collate "C") into v_codes
      from public.products p
      cross join lateral (select coalesce(sum(b.qty_on_hand), 0) as qty
                            from public.stock_balances b where b.product_id = p.id) as s
     where p.company_id = p_company and p.is_active and p.is_stockable and p.min_stock > 0
       and s.qty < p.min_stock;
    v_n := coalesce(cardinality(v_codes), 0);
    if v_n > 0 then
      v_alerts := v_alerts || jsonb_build_array(private.control_alert('STOCK_MINIMO', 'warning',
        private.plural(v_n, 'producto', 'productos') || ' bajo el stock mínimo',
        array_to_string(v_codes[1:3], ', ') || case when v_n > 3 then format(' y %s más', v_n - 3) else '' end,
        v_base || '/stock'));
    end if;
  end if;
  if private.has_permission(p_company, 'receivable.read') then
    select count(*), sum((r ->> 'overdue')::numeric) into v_n, v_sum
      from jsonb_array_elements(public.receivables_list(p_company)) as r
     where (r ->> 'overdue')::numeric > 0;
    if v_n > 0 then
      v_alerts := v_alerts || jsonb_build_array(private.control_alert('CLIENTES_VENCIDOS', 'warning',
        private.format_money(v_sum) || ' vencidos de los clientes',
        private.plural(v_n, 'cliente', 'clientes') || ' con facturas vencidas.', v_base || '/ventas/clientes'));
    end if;
  end if;
  if private.has_permission(p_company, 'payable.read') then
    select count(*), sum((r ->> 'overdue')::numeric) into v_n, v_sum
      from jsonb_array_elements(public.payables_list(p_company)) as r
     where (r ->> 'overdue')::numeric > 0;
    if v_n > 0 then
      v_alerts := v_alerts || jsonb_build_array(private.control_alert('PROVEEDORES_VENCIDOS', 'danger',
        private.format_money(v_sum) || ' vencidos con los proveedores',
        private.plural(v_n, 'proveedor', 'proveedores') || ' con facturas vencidas.', v_base || '/pagos/proveedores'));
    end if;
  end if;
  if private.has_permission(p_company, 'treasury.read') then
    v_projection := public.cash_projection(p_company);
    select b ->> 'label' into v_label
      from jsonb_array_elements(v_projection -> 'buckets') as b
     where b ->> 'key' = v_projection ->> 'shortfall';
    if v_label is not null then
      v_alerts := v_alerts || jsonb_build_array(private.control_alert('FALTA_DE_FONDOS', 'danger',
        'Falta de fondos en el flujo proyectado',
        format('El saldo proyectado queda en negativo en el tramo «%s».', v_label), v_base || '/pagos/flujo-de-fondos'));
    end if;
  end if;
  if private.has_permission(p_company, 'tax_return.read') then
    select count(*), sum(d.total) into v_n, v_sum
      from public.documents d join public.tax_returns t on t.document_id = d.id
     where d.company_id = p_company and d.doc_type = 'TAX_RETURN' and d.status = 'PRESENTADA'
       and t.due_date < v_today;
    if v_n > 0 then
      v_alerts := v_alerts || jsonb_build_array(private.control_alert('DECLARACIONES_VENCIDAS', 'danger',
        private.plural(v_n, 'declaración vencida', 'declaraciones vencidas') || ' sin pagar',
        private.format_money(v_sum) || ', más los intereses resarcitorios.', v_base || '/impuestos/declaraciones'));
    end if;
  end if;
  if private.has_permission(p_company, 'bank.read') then
    select count(*) into v_n
      from public.bank_movements m
     where m.company_id = p_company and m.status = 'RECHAZADO';
    if v_n > 0 then
      v_alerts := v_alerts || jsonb_build_array(private.control_alert('BANCO_RECHAZADAS', 'danger',
        private.plural(v_n, 'orden rechazada', 'órdenes rechazadas') || ' por el banco',
        case when v_n = 1 then 'Por falta de fondos: hay que reenviarla cuando haya fondos o anular la operación.'
             else 'Por falta de fondos: hay que reenviarlas cuando haya fondos o anular las operaciones.' end,
        v_base || '/pagos/banco-aula'));
    end if;
    select count(*), sum(i.principal + i.interest) into v_n, v_sum
      from public.bank_loan_installments i join public.bank_loans l on l.id = i.loan_id
     where l.company_id = p_company and l.status = 'VIGENTE' and i.status = 'PENDIENTE' and i.due_on <= v_today;
    if v_n > 0 then
      v_alerts := v_alerts || jsonb_build_array(private.control_alert('CUOTAS_VENCIDAS', 'warning',
        private.plural(v_n, 'cuota vencida', 'cuotas vencidas') || ' de préstamos',
        private.format_money(v_sum) || ' para debitar.', v_base || '/pagos/prestamos'));
    end if;
  end if;
  if private.has_permission(p_company, 'fisco.read') then
    select count(*), count(*) filter (where v_today > n.response_due) into v_n, v_late
      from public.fiscal_notices n
     where n.company_id = p_company and n.status = 'PENDIENTE';
    if v_n > 0 then
      v_alerts := v_alerts || jsonb_build_array(private.control_alert('INTIMACIONES',
        case when v_late > 0 then 'danger' else 'warning' end,
        private.plural(v_n, 'intimación', 'intimaciones') || ' del fisco sin responder',
        case when v_late > 0 then private.plural(v_late, 'tiene', 'tienen') || ' el plazo vencido.'
             else 'Hay que cumplir o responder dentro del plazo.' end,
        v_base || '/fisco/domicilio-fiscal'));
    end if;
  end if;
  if private.has_permission(p_company, 'tax_fine.read') then
    select count(*), sum(case when v_today <= f.reduction_until then f.reduced_amount else f.amount end)
      into v_n, v_sum
      from public.documents d join public.tax_fines f on f.document_id = d.id
     where d.company_id = p_company and d.doc_type = 'TAX_FINE' and d.status = 'NOTIFICADA';
    if v_n > 0 then
      v_alerts := v_alerts || jsonb_build_array(private.control_alert('MULTAS', 'warning',
        private.plural(v_n, 'multa', 'multas') || ' del fisco sin pagar',
        format('A pagar hoy: %s (dentro de los 15 días de notificada, la multa se reduce a la mitad).',
               private.format_money(v_sum)),
        v_base || '/impuestos/multas'));
    end if;
  end if;
  return v_alerts;
end;
$$;

-- ------------------------------------------------------------------ Lecturas con versión nueva

-- El tablero de control (controlPanel), ahora con las alertas de hoy.
create or replace function public.control_panel(p_company_id uuid, p_period text)
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
                            'previous_to', v_pto, 'areas', v_areas, 'alerts', private.control_alerts(p_company_id));
end;
$$;
