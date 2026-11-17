-- 103. Fase 8e.2 (docs/FASE_8_BANCO_Y_FISCO.md §4): la cuenta corriente tributaria, los intereses
-- resarcitorios y el pago de las declaraciones por el banco. Tesorería paga la declaración siempre por
-- transferencia desde la cuenta del Banco Aula, con los intereses resarcitorios si ya venció (4 %
-- mensual simple por los días de atraso, con mes de 30 días, a la cuenta Intereses resarcitorios): se
-- registra el asiento del pago, la orden llega al banco y la declaración queda "Pago en el banco"; el
-- fisco imputa el pago (queda Pagada) cuando el banco procesa la orden. Con el módulo del banco
-- bloqueado, el banco funciona como operado por el sistema (como decía la 8a). Lectura nueva: la
-- cuenta corriente tributaria (tax_account). Traducción de "Impuestos" y "Banco Aula" de engine.ts
-- (8e.2).
--
-- El estado y las transiciones nuevos están en la migración de catálogos siguiente; la cuenta y las
-- reglas nuevas, en la de la plantilla y en la de las empresas existentes.

-- ------------------------------------------------------------------ Tablas

alter table public.tax_returns
  add column interest numeric(14, 2) not null default 0 check (interest >= 0),
  add column imputed_on date;

-- Las declaraciones ya pagadas (desde una caja o un banco) quedan imputadas el día del pago, sin intereses.
update public.tax_returns t
   set imputed_on = t.paid_on
  from public.documents d
 where d.id = t.document_id and d.status = 'PAGADA' and t.imputed_on is null;

-- ------------------------------------------------------------------ Auxiliares

-- Quién opera el banco: Tesorería, salvo que el docente pida que lo opere el sistema o bloquee su
-- módulo: bloqueado, el banco sigue procesando solo (bankMode; 8a, desde la 8e.2).
create or replace function private.bank_mode(p_company uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce((select c.settings ->> 'bank_mode' from public.companies c where c.id = p_company),
                            'ESTUDIANTES') = 'AUTOMATICO'
                or not private.module_enabled(p_company, 'bank') then 'AUTOMATICO'
              else 'ESTUDIANTES' end
$$;

-- Los días de atraso de un pago, desde el vencimiento (taxInterest).
create function private.tax_late_days(p_due date, p_on date)
returns int
language sql
immutable
set search_path = ''
as $$ select greatest(p_on - p_due, 0) $$;

-- Los intereses resarcitorios de un pago fuera de término (taxInterest, a validar): el 4 % mensual
-- simple (FISCO_DEFAULTS.interest_rate) sobre el saldo, por los días de atraso, con mes de 30 días, al
-- centavo.
create function private.tax_interest(p_amount numeric, p_due date, p_on date)
returns numeric
language sql
immutable
set search_path = ''
as $$ select round(p_amount * 4 * private.tax_late_days(p_due, p_on) / 3000.0, 2) $$;

-- La orden del pago de una declaración en el Banco Aula, si la hay (taxPaymentOrder).
create function private.tax_payment_order(p_document uuid)
returns public.bank_movements
language sql
stable
security definer
set search_path = ''
as $$
  select m.* from public.bank_movements m
   where m.source_document_id = p_document and m.origin = 'ORDEN' and m.reverses_id is null
     and m.direction = 'DEBITO'
   order by m.seq
   limit 1
$$;

-- Si la orden que el banco procesó es el pago de una declaración, el fisco lo imputa
-- (imputeTaxPayment): la declaración queda Pagada, con la fecha del proceso.
create function private.tax_return_impute(p_order uuid, p_on date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.bank_movements;
  v_doc public.documents;
begin
  select * into v_order from public.bank_movements m where m.id = p_order;
  if v_order.origin <> 'ORDEN' or v_order.reverses_id is not null or v_order.source_document_id is null then
    return;
  end if;
  select * into v_doc from public.documents d where d.id = v_order.source_document_id;
  if v_doc.id is null or v_doc.doc_type <> 'TAX_RETURN' or v_doc.status <> 'PAGO_EN_BANCO' then
    return;
  end if;
  update public.tax_returns set imputed_on = p_on where document_id = v_doc.id;
  perform private.transition_document(v_doc.id, 'SYSTEM', p_to => 'PAGADA',
    p_actor => row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor,
    p_summary => format('El fisco imputó el pago de %s: %s (transacción %s del Banco Aula)', v_doc.display_number,
                        private.format_money(v_order.amount), v_order.transaction_number));
end;
$$;

-- ------------------------------------------------------------------ Comandos

drop function public.tax_return_pay(uuid, uuid);

-- Tesorería paga la declaración (cmdPayTaxReturn, 8e.2): por transferencia desde la cuenta del Banco
-- Aula, con los intereses resarcitorios si ya venció. Se registra el asiento del pago y la orden llega
-- al banco: la declaración queda Pago en el banco hasta que el banco la procesa y el fisco imputa el
-- pago (en el momento, si el banco lo opera el sistema). SoD-10: no la paga quien la liquidó.
create function public.tax_return_pay(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_t public.tax_returns;
  v_bank public.bank_accounts;
  v_account public.accounts;
  v_today date;
  v_days int;
  v_interest numeric;
  v_total numeric;
  v_balance numeric;
  v_month text;
  v_name text;
  v_iva boolean;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'TAX_RETURN');
  perform private.require_transition(v_doc, 'PAY');
  v_actor := private.require_permission(v_doc.company_id, 'tax_return.pay');
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and not private.is_supervisor(v_doc.company_id)
     and (select auth.uid()) = any (private.tax_return_preparers(v_doc)) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés pagar %s: la liquidaste vos.', v_doc.display_number),
      'Separación de funciones: quien liquida un impuesto no lo paga. Tiene que pagarlo otro integrante de Tesorería.');
  end if;
  select * into v_bank from public.bank_accounts b
   where b.company_id = v_doc.company_id and b.is_active
   order by b.created_at, b.id
   limit 1;
  if v_bank.id is null then
    perform private.raise_business_error('DATO_INVALIDO',
      'La empresa no tiene su cuenta en el Banco Aula: los impuestos se pagan desde ahí.');
  end if;
  select * into v_account from public.accounts a where a.id = v_bank.ledger_account_id;
  v_today := private.business_date(v_doc.company_id);
  select * into v_t from public.tax_returns t where t.document_id = v_doc.id;
  v_days := private.tax_late_days(v_t.due_date, v_today);
  v_interest := private.tax_interest(v_doc.total, v_t.due_date, v_today);
  v_total := v_doc.total + v_interest;
  v_balance := private.account_balance(v_account.id);
  v_month := private.period_label(v_t.period);
  v_name := private.tax_name(v_t.tax);
  v_iva := v_t.tax = 'IVA';
  if v_total > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No alcanza el saldo de %s %s: hay %s y el pago %s de %s es %s%s.', v_account.code, v_account.name,
             private.format_money(v_balance), case when v_iva then 'del IVA' else 'de ingresos brutos' end, v_month,
             private.format_money(v_total),
             case when v_interest > 0
               then format(' (con %s de intereses resarcitorios)', private.format_money(v_interest)) else '' end),
      'Antes de pagar hay que controlar que haya fondos: el flujo de fondos proyectado lo anticipa.');
  end if;
  perform private.transition_document(v_doc.id, 'PAY', p_actor => v_actor,
    p_summary => format('Pagó %s por transferencia desde el Banco Aula: %s de %s, %s%s', v_doc.display_number, v_name,
                        v_month, private.format_money(v_doc.total),
                        case when v_interest > 0
                          then format(' y %s de intereses resarcitorios por %s días de atraso',
                                      private.format_money(v_interest), v_days)
                          else '' end));
  update public.tax_returns
     set paid_on = v_today, paid_account_id = v_account.id, interest = v_interest
   where document_id = v_doc.id;
  select * into v_doc from public.documents d where d.id = v_doc.id;
  perform private.post_event(v_actor, v_doc, case when v_iva then 'PAGO_IVA' else 'PAGO_IIBB' end,
    format('Pago %s de %s (%s)%s.', case when v_iva then 'del IVA' else 'de ingresos brutos' end, v_month,
           v_doc.display_number,
           case when v_interest > 0 then format(', con intereses resarcitorios por %s días de atraso', v_days) else '' end),
    jsonb_build_array(
      jsonb_build_object('key', case when v_iva then 'IVA_A_PAGAR' else 'IIBB_A_PAGAR' end,
                         'debit', v_doc.total, 'credit', 0),
      jsonb_build_object('key', 'INTERESES', 'debit', v_interest, 'credit', 0),
      jsonb_build_object('account_id', v_account.id, 'debit', 0, 'credit', v_total)));
end;
$$;

grant execute on function public.tax_return_pay(uuid) to authenticated;

-- ------------------------------------------------------------------ Lecturas nuevas

-- La cuenta corriente tributaria de la empresa (taxAccount, Fase 8e.2): las declaraciones que el
-- fisco aceptó, de la más nueva a la más vieja (en un mes, ingresos brutos y después el IVA), con lo
-- declarado, los intereses (los pagados o, vencida sin pagar, a hoy), lo imputado y el saldo.
create function public.tax_account(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_rows jsonb;
begin
  perform private.require_read(p_company_id, 'fisco.read');
  v_today := private.business_date(p_company_id);
  select coalesce(jsonb_agg(r.item order by r.period desc, r.tax), '[]') into v_rows
    from (
      select t.period, t.tax, jsonb_build_object(
               'document', jsonb_build_object('id', d.id, 'display_number', d.display_number,
                                              'path', private.doc_path(d.id)),
               'tax', t.tax, 'period', t.period, 'due_date', t.due_date, 'transaction_code', t.transaction_code,
               'declared', d.total, 'balance_in_favor', t.balance_in_favor,
               'interest', x.interest, 'paid', x.paid,
               'imputed_on', case when d.status = 'PAGADA' then t.imputed_on end,
               'bank_transaction', case when d.status = 'PAGADA' and o.status = 'PROCESADO'
                                     then o.transaction_number end,
               'balance', d.total + x.interest - x.paid,
               'state', case when d.status = 'SIN_SALDO' then 'SIN_SALDO'
                             when d.status = 'PAGADA' then 'PAGADA'
                             when d.status = 'PAGO_EN_BANCO'
                               then case when o.status = 'RECHAZADO' then 'RECHAZADA' else 'EN_EL_BANCO' end
                             when v_today > t.due_date then 'VENCIDA'
                             else 'A_VENCER' end) as item
        from public.documents d
        join public.tax_returns t on t.document_id = d.id
        cross join lateral (
          select case when d.status = 'PRESENTADA' then private.tax_interest(d.total, t.due_date, v_today)
                      else t.interest end as interest,
                 case when d.status = 'PAGADA' then d.total + t.interest else 0 end as paid) x
        left join lateral (
          select m.status, m.transaction_number from public.bank_movements m
           where m.source_document_id = d.id and m.origin = 'ORDEN' and m.reverses_id is null
             and m.direction = 'DEBITO'
           order by m.seq
           limit 1) o on true
       where d.company_id = p_company_id and d.doc_type = 'TAX_RETURN'
         and d.status in ('PRESENTADA', 'SIN_SALDO', 'PAGO_EN_BANCO', 'PAGADA')
    ) r;
  return jsonb_build_object('date', v_today, 'rows', v_rows,
    'balance', coalesce((select sum((e ->> 'balance')::numeric) from jsonb_array_elements(v_rows) e), 0));
end;
$$;

grant execute on function public.tax_account(uuid) to authenticated;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, y si la orden que procesó es el pago de una declaración, el fisco lo imputa
-- (executeBankOrder).
create or replace function private.bank_execute_order(p_id uuid, p_on date, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.bank_movements;
  v_account public.bank_accounts;
  v_available numeric;
  v_fee public.bank_movements;
  v_task uuid;
begin
  select * into v_order from public.bank_movements m where m.id = p_id;
  select * into v_account from public.bank_accounts b where b.id = v_order.bank_account_id for update;
  select coalesce(sum(case when m.direction = 'CREDITO' then m.amount else -m.amount end), 0) + v_account.overdraft_limit
    into v_available
    from public.bank_movements m where m.bank_account_id = v_account.id and m.status = 'PROCESADO';
  if v_order.direction = 'CREDITO' or v_order.amount <= v_available then
    perform private.bank_process_movement(p_id, p_on, p_user);
    perform private.tax_return_impute(p_id, p_on);
    return;
  end if;
  update public.bank_movements set status = 'RECHAZADO', processed_on = p_on, processed_by = p_user where id = p_id;
  v_fee := private.bank_add_movement(v_account, 'BANCO', 'DEBITO',
    case when v_order.cheque_number is not null then 4000 else 2500 end,
    case when v_order.cheque_number is not null then 'Comisión por rechazo del cheque N.º ' || v_order.cheque_number
         else 'Comisión por rechazo de la orden N.º ' || v_order.seq end,
    null, null, null, p_on, null);
  update public.bank_movements set charge = 'RECHAZO' where id = v_fee.id;
  perform private.bank_process_movement(v_fee.id, p_on, p_user);
  v_task := private.bank_sync_rejected_task(v_order.company_id);
  perform private.bank_sync_charges_task(v_order.company_id);
  perform private.notify_roles(
    v_order.company_id, array['TESORERIA'], 'ORDEN_RECHAZADA', 'El Banco Aula rechazó una orden',
    format('La orden N.º %s (%s, %s) supera el saldo más el acuerdo de descubierto: el banco no la debitó y cobró %s de comisión. Anulá la operación y volvé a pagar, o reenviala cuando haya fondos.',
           v_order.seq, v_order.concept, private.format_money(v_order.amount), private.format_money(v_fee.amount)),
    '/e/' || (select c.slug from public.companies c where c.id = v_order.company_id) || '/pagos/banco-aula/bandeja',
    null, v_task
  );
end;
$$;

-- Igual que antes, y al bloquear o habilitar el módulo del banco, el banco se pone al día (cmdSetModule).
create or replace function public.company_set_module(p_company_id uuid, p_module text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_name text;
begin
  select mo.name into v_name from public.modules mo where mo.code = p_module and mo.is_lockable;
  if v_name is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Ese módulo no se puede bloquear.');
  end if;
  insert into public.company_modules (company_id, module_code, is_enabled, updated_at, updated_by)
  values (p_company_id, p_module, p_enabled, now(), (select auth.uid()))
  on conflict (company_id, module_code) do update
    set is_enabled = excluded.is_enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  -- Bloqueado, el fisco responde solo (8e.1): recibe lo que esperaba; habilitado, vuelven sus tareas.
  if p_module = 'fisco' then
    perform private.fisco_settle(p_company_id);
  end if;
  -- Lo mismo con el banco (8e.2, como decía la 8a): bloqueado, procesa solo lo pendiente.
  if p_module = 'bank' then
    perform private.bank_settle(p_company_id);
  end if;
  perform private.log_audit(p_company_id, v_actor, 'SETTINGS', 'company_module', p_company_id, v_name,
    format('%s el módulo %s', case when p_enabled then 'Habilitó' else 'Bloqueó' end, v_name));
end;
$$;

-- Igual que antes, y además los intereses resarcitorios (los pagados o, vencida sin pagar, a hoy), la
-- imputación del fisco y la orden del pago en el Banco Aula (taxReturnView).
create or replace function private.tax_return_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tax', t.tax, 'period', t.period, 'due_date', t.due_date, 'tax_amount', t.tax_amount, 'credits', t.credits,
    'previous_balance', t.previous_balance, 'amount_due', p_doc.total, 'balance_in_favor', t.balance_in_favor,
    'presented_at', t.presented_at, 'paid_on', t.paid_on,
    'paid_account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name)
                       from public.accounts a where a.id = t.paid_account_id),
    'interest', t.interest, 'imputed_on', t.imputed_on,
    'interest_to_date',
      case when p_doc.status = 'PRESENTADA'
                and private.tax_late_days(t.due_date, private.business_date(p_doc.company_id)) > 0
        then jsonb_build_object(
               'days', private.tax_late_days(t.due_date, private.business_date(p_doc.company_id)),
               'interest', private.tax_interest(p_doc.total, t.due_date, private.business_date(p_doc.company_id)))
      end,
    'bank_order', (select jsonb_build_object('seq', m.seq, 'status', m.status, 'received_on', m.received_on,
                                             'processed_on', m.processed_on,
                                             'transaction_number', m.transaction_number)
                     from public.bank_movements m
                    where m.source_document_id = p_doc.id and m.origin = 'ORDEN' and m.reverses_id is null
                      and m.direction = 'DEBITO'
                    order by m.seq
                    limit 1),
    'base', t.base, 'rate', t.rate,
    'withholdings', case when t.tax = 'IIBB' then coalesce((
      select jsonb_agg(jsonb_build_object(
               'entry_date', c.entry_date, 'sign', c.sign,
               'source', jsonb_build_object('id', s.id, 'doc_type', s.doc_type, 'display_number', s.display_number,
                                            'path', private.doc_path(s.id)),
               'kind', case when s.doc_type = 'SUPPLIER_INVOICE' then 'PERCEPCION' else 'RETENCION' end,
               'voucher', case when s.doc_type = 'SUPPLIER_INVOICE'
                            then (select si.letter || ' ' || si.point_of_sale || '-' || si.invoice_number
                                    from public.supplier_invoices si where si.document_id = s.id)
                            else s.display_number end,
               'counterparty', case when s.doc_type = 'SUPPLIER_INVOICE'
                                 then (select x.legal_name from public.suppliers x where x.id = s.supplier_id)
                                 else (select x.legal_name from public.customers x where x.id = s.customer_id) end,
               'amount', c.amount)
             order by c.entry_date, c.entry_number)
        from private.iibb_credits(p_doc.company_id, t.period) c join public.documents s on s.id = c.source_id), '[]')
      else '[]' end)
    from public.tax_returns t
   where t.document_id = p_doc.id
$$;

-- Igual que antes, y qué sigue con la declaración presentada (con los intereses si venció) y con el
-- pago en el banco (nextStep).
create or replace function private.next_step(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sector text := coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), 'el sector solicitante');
  v_route public.route_sheet_lines;
  v_route_number text;
  v_delivery text;
  v_req public.approval_requests;
  v_rule text;
  v_loaded int;
  v_invited int;
  v_awarded public.documents;
  v_rfq_number text;
  v_tax public.tax_returns;
  v_order public.bank_movements;
  v_days int;
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
        'text', case when p_doc.status_reason <> ''
          then format('Gerencia la devolvió: "%s". Corregir las novedades y volver a enviarla a autorizar.',
                      p_doc.status_reason)
          else 'Cargar las novedades del mes de cada empleado (los días o las horas trabajadas, las ausencias sin aviso y las horas extra), revisar los recibos y enviar la liquidación a Gerencia para que la autorice.'
        end);
    when 'PAYROLL:PENDIENTE_APROBACION' then
      return jsonb_build_object('who', 'Gerencia',
        'text', format('Revisar los recibos y los totales (%s netos) y autorizar la liquidación: se registra el asiento de sueldos y Tesorería recibe la tarea de pagar. Si hay que corregir algo, devolverla a RRHH con el motivo.',
                       private.format_money(p_doc.total)));
    when 'PAYROLL:CONFIRMADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar los sueldos el %s: %s netos. Los aportes retenidos y las contribuciones quedan en Cargas sociales a pagar hasta que se depositen.',
                       coalesce((select to_char(x.payment_date, 'DD/MM/YYYY') from public.payrolls x
                                  where x.document_id = p_doc.id), '—'),
                       private.format_money(p_doc.total)));
    when 'PAYROLL:SUELDOS_PAGADOS' then
      return (
        select jsonb_build_object('who', 'Tesorería',
          'text', format('Pagar las cargas sociales antes del %s: %s entre los aportes retenidos a los empleados, las contribuciones de la empresa y lo de los sindicatos.',
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
      v_delivery := private.delivery_status(p_doc.id);
      v_route := private.last_route_line(p_doc.id);
      v_route_number := (select d.display_number from public.documents d where d.id = v_route.document_id);
      if v_delivery = 'PROGRAMADO' then
        return jsonb_build_object('who', 'Logística',
          'text', format('Está en la hoja de ruta %s, que todavía no salió.', v_route_number));
      elsif v_delivery = 'EN_CAMINO' then
        return jsonb_build_object('who', 'Logística',
          'text', format('Va en camino al cliente con la hoja de ruta %s: al volver, Logística la rinde.', v_route_number));
      elsif v_delivery = 'ENTREGADO' then
        return jsonb_build_object('who', '—',
          'text', format('Entregado con la hoja de ruta %s: lo recibió %s.', v_route_number, v_route.received_by));
      end if;
      return jsonb_build_object('who', 'Logística',
        'text', case when v_route.id is not null
          then format('No se entregó con %s: %s. Logística lo incluye en otra hoja de ruta.', v_route_number, v_route.reason)
          else 'La mercadería salió del depósito (bajó el stock y se registró el costo de lo vendido). Falta llevarla al cliente: Logística la incluye en una hoja de ruta.' end);
    when 'ROUTE_SHEET:BORRADOR' then
      return jsonb_build_object('who', 'Logística',
        'text', 'Cargar la mercadería de los remitos en el orden de visita, controlar el transporte y salir a repartir: los remitos pasan a "en camino".');
    when 'ROUTE_SHEET:EN_CAMINO' then
      return jsonb_build_object('who', 'Logística',
        'text', 'Al volver, rendir la hoja: qué remitos se entregaron (y quién los recibió) y cuáles no (y por qué). Ventas recibe un aviso por cada uno.');
    when 'TAX_RETURN:BORRADOR' then
      return jsonb_build_object('who', 'Impuestos',
        'text', case when (select t.tax from public.tax_returns t where t.document_id = p_doc.id) = 'IIBB'
          then 'Revisar las ventas netas del mes y las percepciones y retenciones sufridas, y presentar la declaración: se registra el asiento del impuesto.'
          else 'Revisar los libros IVA del mes (el débito y el crédito fiscal) y presentar la declaración: se registra el asiento del impuesto.' end);
    when 'TAX_RETURN:ENVIADA' then
      return jsonb_build_object('who', 'Fisco (Impuestos)',
        'text', 'El fisco la recibe: controla lo declarado con los comprobantes que autorizó en el mes y la acepta con un acuse (se registra el asiento del impuesto) o la observa con el motivo. No la recibe quien la preparó o la presentó.');
    when 'TAX_RETURN:OBSERVADA' then
      return jsonb_build_object('who', 'Impuestos',
        'text', 'El fisco la observó' || coalesce(' con este motivo: «' || nullif(p_doc.status_reason, '') || '»', '')
                || '. Hay que anularla y presentarla de nuevo.');
    when 'TAX_RETURN:PRESENTADA' then
      select * into v_tax from public.tax_returns t where t.document_id = p_doc.id;
      v_days := private.tax_late_days(v_tax.due_date, private.business_date(p_doc.company_id));
      return jsonb_build_object('who', 'Tesorería',
        'text', case when v_days > 0
          then format('Pagar %s al fisco (simulado) por transferencia desde el Banco Aula: venció el %s y a hoy suma %s de intereses resarcitorios (%s días de atraso).',
                      private.format_money(p_doc.total), to_char(v_tax.due_date, 'DD/MM/YYYY'),
                      private.format_money(private.tax_interest(p_doc.total, v_tax.due_date,
                                                                private.business_date(p_doc.company_id))),
                      v_days)
          else format('Pagar %s al fisco (simulado) por transferencia desde el Banco Aula antes del %s.',
                      private.format_money(p_doc.total), to_char(v_tax.due_date, 'DD/MM/YYYY')) end);
    when 'TAX_RETURN:PAGO_EN_BANCO' then
      v_order := private.tax_payment_order(p_doc.id);
      if v_order.status = 'RECHAZADO' then
        return jsonb_build_object('who', 'Tesorería',
          'text', format('El Banco Aula rechazó la orden N.º %s por falta de fondos: hay que reenviarla desde la bandeja del banco cuando haya fondos. Hasta que el banco la procese, el fisco no imputa el pago.',
                         v_order.seq));
      end if;
      return jsonb_build_object('who', 'Banco Aula (Tesorería)',
        'text', format('El pago está en el Banco Aula%s: lo procesa un integrante de Tesorería que no lo envió y, cuando el banco lo debita, el fisco lo imputa.',
                       case when v_order.id is not null then format(' (orden N.º %s)', v_order.seq) else '' end));
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

-- Igual que antes: con el pago en el banco la obligación sigue a pagar, y pagada dice cuándo la imputó
-- el fisco y los intereses (obligationsCalendar).
create or replace function public.obligations_calendar(p_company_id uuid, p_period text)
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
      'status', case when v_dj.id is null or v_dj.status in ('BORRADOR', 'ENVIADA', 'OBSERVADA') then 'PENDIENTE'
                     when v_dj.status in ('PRESENTADA', 'PAGO_EN_BANCO') then 'A_PAGAR' else 'CUMPLIDA' end,
      'detail', case when v_dj.id is null then 'Sin declarar'
                     when v_dj.status = 'BORRADOR' then v_dj.display_number || ' en borrador'
                     when v_dj.status = 'ENVIADA' then 'Enviada al fisco: espera el acuse'
                     when v_dj.status = 'OBSERVADA' then 'Observada por el fisco: hay que presentarla de nuevo'
                     when v_dj.status = 'PRESENTADA' then 'Presentada: falta pagarla'
                     when v_dj.status = 'PAGO_EN_BANCO' then
                       case when (private.tax_payment_order(v_dj.id)).status = 'RECHAZADO'
                         then 'El banco rechazó el pago por falta de fondos: hay que reenviarlo'
                         else 'Pago en el banco: el fisco lo imputa cuando el banco lo procesa' end
                     when v_dj.status = 'SIN_SALDO' then 'Presentada sin saldo a pagar'
                     else 'Pagada el ' || to_char(coalesce(v_t.imputed_on, v_t.paid_on), 'DD/MM/YYYY')
                          || case when v_t.interest > 0
                               then ', con ' || private.format_money(v_t.interest) || ' de intereses resarcitorios'
                               else '' end end,
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

-- Igual que antes, y en la declaración, los intereses que se pagaron y cuándo el fisco imputó el pago
-- (document_json).
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
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at,
               'perception', x.perception))
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
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at,
               'authorization_code', x.authorization_code, 'authorization_due', x.authorization_due))
        from public.sales_invoices x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rc', jsonb_build_object(
               'treasury_account_id', x.treasury_account_id, 'payment_method', x.payment_method, 'reference', x.reference,
               'received_on', x.received_on, 'retention', x.retention))
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
    || coalesce((
      select jsonb_build_object('tr', jsonb_build_object(
               'tax', x.tax, 'period', x.period, 'due_date', x.due_date, 'tax_amount', x.tax_amount, 'credits', x.credits,
               'previous_balance', x.previous_balance, 'balance_in_favor', x.balance_in_favor,
               'presented_at', x.presented_at, 'paid_on', x.paid_on, 'paid_account_id', x.paid_account_id,
               'base', x.base, 'rate', x.rate, 'control_amount', x.control_amount, 'transaction_code', x.transaction_code,
               'received_on', x.received_on, 'received_by', x.received_by,
               'interest', x.interest, 'imputed_on', x.imputed_on))
        from public.tax_returns x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rs', jsonb_build_object(
               'carrier_id', x.carrier_id, 'vehicle_id', x.vehicle_id, 'driver_id', x.driver_id,
               'departed_at', x.departed_at, 'closed_at', x.closed_at))
        from public.route_sheets x where x.document_id = p_doc.id), '{}')
$$;
