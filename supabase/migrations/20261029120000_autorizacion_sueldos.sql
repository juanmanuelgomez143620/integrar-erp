-- 66. Fase 6d.2 (docs/FASE_6D_CONVENIOS.md §2 y §3): Gerencia autoriza la liquidación de
-- sueldos. RRHH la envía a autorizar (ya no la confirma); Gerencia la autoriza (se registra el
-- asiento de sueldos y Tesorería recibe la tarea de pagar) o la devuelve a borrador con el
-- motivo. SoD-11: quien la preparó no la autoriza ni la devuelve; SoD-6: quien la preparó o la
-- envió no la paga. Traducción de cmdSubmitPayroll, cmdApprovePayroll y cmdRejectPayroll de
-- src/lib/mock/engine.ts y de sus lecturas en queries.ts.
--
-- El estado, las transiciones, las tareas y el permiso nuevos están en la migración de
-- catálogos siguiente.

-- ------------------------------------------------------------------ Comandos

-- Ya no se confirma: se envía a autorizar.
drop function public.payroll_confirm(uuid);

-- RRHH envía la liquidación a Gerencia para que la autorice: desde ahí no se cambian las
-- novedades; si hay que corregir algo, Gerencia la devuelve (cmdSubmitPayroll).
create function public.payroll_submit(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_p public.payrolls;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  perform private.require_transition(v_doc, 'SUBMIT');
  perform private.require_permission(v_doc.company_id, 'payroll.create');
  if coalesce((select round(sum(l.gross), 2) from public.payroll_lines l where l.document_id = v_doc.id), 0) <= 0 then
    perform private.raise_business_error('DATO_INVALIDO',
      'La liquidación no tiene importes: revisá los días o las horas trabajadas.');
  end if;
  select * into v_p from public.payrolls p where p.document_id = v_doc.id;
  perform private.transition_document(v_doc.id, 'SUBMIT',
    p_summary => format('Envió %s a autorizar: sueldos de %s, %s netos', v_doc.display_number,
                        private.period_label(v_p.period), private.format_money(v_doc.total)));
end;
$$;

-- Gerencia autoriza o devuelve; quien preparó la liquidación no decide sobre ella (SoD-11,
-- decidePayroll). Devuelve quién actúa.
create function private.decide_payroll(p_document uuid, p_action text)
returns private.actor
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document, 'PAYROLL');
  v_actor private.actor;
begin
  perform private.require_transition(v_doc, p_action);
  v_actor := private.require_permission(v_doc.company_id, 'payroll.approve');
  if not private.is_supervisor(v_doc.company_id)
     and coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and v_doc.created_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      'No podés autorizar ni devolver una liquidación que preparaste vos.',
      'Separación de funciones: quien liquida los sueldos no los autoriza.');
  end if;
  return v_actor;
end;
$$;

-- Gerencia autoriza: quedan los recibos y se registra el asiento de sueldos: el personal del
-- taller, como mano de obra directa; los demás, como sueldos y cargas sociales; lo del
-- sindicato, en Sindicatos a pagar (cmdApprovePayroll).
create function public.payroll_approve(p_document_id uuid, p_comment text)
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
  v_comment text := trim(coalesce(p_comment, ''));
begin
  perform private.require_active_user();
  v_actor := private.decide_payroll(p_document_id, 'APPROVE');
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  select * into v_p from public.payrolls p where p.document_id = v_doc.id;
  select count(*) as n,
         coalesce(round(sum(l.net), 2), 0) as net,
         coalesce(round(sum(l.deductions - l.union_dues + l.employer), 2), 0) as charges,
         coalesce(round(sum(l.union_dues + l.union_contribution), 2), 0) as unions,
         coalesce(round(sum(l.gross) filter (where not l.is_direct_labor), 2), 0) as others_gross,
         coalesce(round(sum(l.employer + l.union_contribution) filter (where not l.is_direct_labor), 2), 0)
           as others_employer,
         coalesce(round(sum(l.gross + l.employer + l.union_contribution) filter (where l.is_direct_labor), 2), 0) as direct
    into v_t
    from public.payroll_lines l where l.document_id = v_doc.id;
  perform private.transition_document(v_doc.id, 'APPROVE', p_comment, p_actor => v_actor,
    p_summary => format('Autorizó %s: sueldos de %s, %s netos a pagar%s', v_doc.display_number,
                        private.period_label(v_p.period), private.format_money(v_doc.total),
                        case when v_comment <> '' then ' — ' || v_comment else '' end));
  update public.payrolls set confirmed_at = now() where document_id = v_doc.id;
  perform private.post_event(v_actor, v_doc, 'SUELDOS',
    format('Sueldos de %s (%s): %s empleado%s.', private.period_label(v_p.period), v_doc.display_number, v_t.n,
           case when v_t.n > 1 then 's' else '' end),
    jsonb_build_array(
      jsonb_build_object('key', 'REMUNERACIONES', 'debit', v_t.others_gross, 'credit', 0),
      jsonb_build_object('key', 'CONTRIBUCIONES', 'debit', v_t.others_employer, 'credit', 0),
      jsonb_build_object('key', 'MANO_DE_OBRA_DIRECTA', 'debit', v_t.direct, 'credit', 0),
      jsonb_build_object('key', 'SUELDOS_A_PAGAR', 'debit', 0, 'credit', v_t.net),
      jsonb_build_object('key', 'CARGAS_SOCIALES_A_PAGAR', 'debit', 0, 'credit', v_t.charges),
      jsonb_build_object('key', 'SINDICATOS_A_PAGAR', 'debit', 0, 'credit', v_t.unions)));
end;
$$;

-- Gerencia la devuelve a RRHH con el motivo: vuelve a borrador para corregirla (cmdRejectPayroll).
create function public.payroll_reject(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor;
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_actor := private.decide_payroll(p_document_id, 'REJECT');
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  perform private.transition_document(v_doc.id, 'REJECT', p_reason, p_actor => v_actor,
    p_summary => format('Devolvió %s a RRHH — %s', v_doc.display_number, trim(coalesce(p_reason, ''))));
end;
$$;

grant execute on function public.payroll_submit(uuid) to authenticated;
grant execute on function public.payroll_approve(uuid, text) to authenticated;
grant execute on function public.payroll_reject(uuid, text) to authenticated;

-- ------------------------------------------------------------------ SoD-6

-- Quienes liquidaron los sueldos: quien preparó la liquidación y quien la envió a autorizar
-- (en las de antes de la Fase 6d, quien la confirmó) (payrollLiquidators).
create or replace function private.payroll_liquidators(p_doc public.documents)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[p_doc.created_by] || array(
    select e.actor_user_id from public.audit_events e
     where e.document_id = p_doc.id and e.action in ('SUBMIT', 'CONFIRM')
     order by e.id), null)
$$;

-- ------------------------------------------------------------------ Lecturas comunes, con la autorización de Gerencia

-- Igual que antes, y en la liquidación de sueldos: SoD-11 al autorizarla o devolverla (availableActions).
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
    if p_doc.doc_type = 'PAYROLL' and v_tr.action in ('APPROVE', 'REJECT') and not v_supervisor and v_sod
       and p_doc.created_by = v_uid then
      v_reason := 'Separación de funciones: no podés autorizar ni devolver una liquidación que preparaste vos.';
    end if;
    if p_doc.doc_type = 'PAYROLL' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and v_uid = any (private.payroll_liquidators(p_doc)) then
      v_reason := 'Separación de funciones: liquidaste estos sueldos; tiene que pagarlos otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'TAX_RETURN' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and v_uid = any (private.tax_return_preparers(p_doc)) then
      v_reason := 'Separación de funciones: liquidaste este impuesto; tiene que pagarlo otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'TAX_RETURN' and v_tr.action = 'CANCEL' and p_doc.status <> 'BORRADOR'
       and (private.later_tax_return(p_doc)).id is not null then
      v_reason := format('Sólo se anula la última declaración de %s: %s es posterior.',
                         private.tax_name((select t.tax from public.tax_returns t where t.document_id = p_doc.id)),
                         (private.later_tax_return(p_doc)).display_number);
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

-- Igual que antes, y la liquidación de sueldos pasa por Gerencia: la autoriza o la devuelve a
-- RRHH con el motivo (nextStep).
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
      return jsonb_build_object('who', '—',
        'text', 'La mercadería salió: bajó el stock (ver kardex), el costo de lo vendido está en el libro diario y Ventas fue notificada.');
    when 'TAX_RETURN:BORRADOR' then
      return jsonb_build_object('who', 'Impuestos',
        'text', 'Revisar los libros IVA del mes (el débito y el crédito fiscal) y presentar la declaración: se registra el asiento del impuesto.');
    when 'TAX_RETURN:PRESENTADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar %s al fisco (simulado) antes del %s.', private.format_money(p_doc.total),
                       coalesce((select to_char(t.due_date, 'DD/MM/YYYY') from public.tax_returns t
                                  where t.document_id = p_doc.id), '—')));
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
