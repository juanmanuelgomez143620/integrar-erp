-- 14. Lecturas (ARCHITECTURE.md §6; DATABASE.md §13). Una función por cada
-- consulta de src/lib/mock/queries.ts, con la misma forma de datos, el mismo
-- orden y la misma exigencia de permiso: supabase/tests/reads.test.ts carga el
-- mismo estado en ambos lados y las compara usuario por usuario.
--
-- Son "security definer" con la comprobación del simulador (assertPerm, ser
-- supervisor…), igual que las RPC de escritura: cada función decide qué campos
-- devuelve, como la consulta simulada. Los órdenes son explícitos: códigos en
-- orden de bytes (collate "C") y nombres con private.sort_key().

-- ------------------------------------------------------------------ Utilidades

-- Exige un permiso de lectura en la empresa (assertPerm).
create function private.require_read(p_company uuid, p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  if p_permission is null or not private.has_permission(p_company, p_permission) then
    perform private.raise_business_error('SIN_PERMISO', 'Sin permiso de lectura');
  end if;
end;
$$;

-- Para ordenar nombres sin distinguir mayúsculas ni acentos (textKey en queries.ts).
create function private.sort_key(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(translate(coalesce(p_text, ''), 'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇáàäâãéèëêíìïîóòöôõúùüûñç',
                                               'AAAAAEEEEIIIIOOOOOUUUUNCaaaaaeeeeiiiiooooouuuunc'))
$$;

-- Estado con etiqueta, color y descripción (DOC_STATUSES).
create function private.status_info(p_doc_type text, p_status text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('label', s.label, 'badge', s.badge, 'description', s.description, 'final', s.is_final)
    from public.document_statuses s where s.doc_type = p_doc_type and s.code = p_status
$$;

-- Tipos de documento que el usuario puede leer en la empresa (readableDocTypes).
create function private.readable_doc_types(p_company uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(dt.code), '{}')
    from public.document_types dt
   where private.has_permission(p_company, dt.resource || '.read')
$$;

-- ------------------------------------------------------------------ Documentos

-- Cabecera común más el detalle de su tipo (T.Document: pr, po, gr o sa).
create function private.document_json(p_doc public.documents)
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
$$;

-- Fila de un listado de documentos (DocumentListItem).
create function private.document_item(p_doc public.documents)
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
  ),
  codes as (
    select array_agg(p.code order by l.line_no) as list, count(*) as n
      from lines l join public.products p on p.id = l.product_id
  )
  select private.document_json(p_doc) || jsonb_build_object(
    'status_info', private.status_info(p_doc.doc_type, p_doc.status),
    'supplier_name', coalesce((select s.legal_name from public.suppliers s where s.id = p_doc.supplier_id), ''),
    'sector_name', coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), '—'),
    'created_by_name', private.full_name(p_doc.created_by),
    'line_count', (select count(*) from lines),
    'summary', (
      select coalesce(array_to_string(c.list[1:3], ', '), '') || case when c.n > 3 then format(' y %s más', c.n - 3) else '' end
        from codes c),
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

create function public.documents_list(p_company_id uuid, p_doc_type text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, (select dt.resource || '.read' from public.document_types dt where dt.code = p_doc_type));
  return coalesce((
    select jsonb_agg(private.document_item(d) order by d.number desc)
      from public.documents d where d.company_id = p_company_id and d.doc_type = p_doc_type
  ), '[]');
end;
$$;

-- Acciones disponibles para el usuario, con el motivo si está deshabilitada (availableActions).
create function private.available_actions(p_doc public.documents)
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
  v_result jsonb := '[]';
begin
  select * into v_req from public.approval_requests a where a.document_id = p_doc.id and a.status = 'PENDIENTE';
  for v_tr in
    select * from public.document_transitions t
     where t.doc_type = p_doc.doc_type and t.from_status = p_doc.status and t.action <> 'SYSTEM'
     order by t.sort
  loop
    continue when v_tr.permission_code is null or not private.has_permission(p_doc.company_id, v_tr.permission_code);
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
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'action', v_tr.action, 'label', v_tr.label, 'help', v_tr.help_text, 'tone', v_tr.tone,
      'requires_comment', v_tr.requires_comment, 'enabled', v_reason is null, 'reason', v_reason));
  end loop;
  return v_result;
end;
$$;

-- Quién sigue y qué tiene que hacer (nextStep).
create function private.next_step(p_doc public.documents)
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
begin
  case p_doc.doc_type || ':' || p_doc.status
    when 'PURCHASE_REQUISITION:BORRADOR' then
      return jsonb_build_object('who', v_sector,
        'text', 'Completar los ítems, justificar la necesidad y enviar la solicitud a Compras.');
    when 'PURCHASE_REQUISITION:SOLICITADO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Debe incluir la solicitud en una orden de compra a un proveedor, o rechazarla indicando el motivo.');
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
      return jsonb_build_object('who', 'Próxima fase',
        'text', 'Circuito de compra completo. En la Fase 3 continuará con la factura del proveedor, el pago y el asiento contable.');
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
    else
      return jsonb_build_object('who', '—', 'text', coalesce((
        select s.description from public.document_statuses s where s.doc_type = p_doc.doc_type and s.code = p_doc.status), ''));
  end case;
end;
$$;

-- Firma del comprobante impreso: el último evento con alguna de esas acciones.
create function private.signature(p_document uuid, p_label text, p_actions text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('label', p_label) || coalesce((
    select jsonb_build_object('name', e.actor_name, 'sector', e.actor_sector_name, 'at', e.occurred_at)
      from public.audit_events e
     where e.document_id = p_document and e.action = any (p_actions)
     order by e.id desc limit 1
  ), jsonb_build_object('name', '', 'sector', '', 'at', ''))
$$;

-- Detalle de un documento (buildDetail).
create function private.document_detail(p_doc public.documents)
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
  end case;

  return jsonb_build_object(
    'doc', private.document_item(p_doc),
    'lines', coalesce(v_lines, '[]'),
    'supplier', (select to_jsonb(s) from public.suppliers s where s.id = p_doc.supplier_id),
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
             order by array_position(array['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'STOCK_ADJUSTMENT'], d.doc_type),
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
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

create function public.document_detail(p_company_id uuid, p_doc_type text, p_display_number text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_read(p_company_id, (select dt.resource || '.read' from public.document_types dt where dt.code = p_doc_type));
  select * into v_doc from public.documents d
   where d.company_id = p_company_id and d.doc_type = p_doc_type and d.display_number = p_display_number;
  if not found then
    return null;
  end if;
  return private.document_detail(v_doc);
end;
$$;

create function public.document_detail_by_id(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  select * into v_doc from public.documents d where d.id = p_document_id;
  if not found then
    return null;
  end if;
  perform private.require_read(v_doc.company_id, (select dt.resource || '.read' from public.document_types dt where dt.code = v_doc.doc_type));
  return private.document_detail(v_doc);
end;
$$;

-- Líneas de SC con saldo para armar una OC (pendingRequisitionLines).
create function public.requisition_lines_pending(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'purchase_requisition.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'line', to_jsonb(l), 'pending', l.quantity - l.qty_ordered, 'requisition', private.document_item(d),
             'product', to_jsonb(p)) order by d.number, l.line_no)
      from public.documents d
      join public.purchase_requisition_lines l on l.document_id = d.id
      join public.products p on p.id = l.product_id
     where d.company_id = p_company_id and d.doc_type = 'PURCHASE_REQUISITION'
       and d.status in ('SOLICITADO', 'ORDENADO_PARCIAL') and l.quantity - l.qty_ordered > 1e-9
  ), '[]');
end;
$$;

-- OC que se pueden recibir, con lo pendiente de cada línea (receivableOrders).
create function public.orders_receivable(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'purchase_order.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'order', private.document_item(d),
             'lines', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'line', to_jsonb(l), 'product', to_jsonb(p), 'pending', l.quantity - l.qty_received) order by l.line_no)
                 from public.purchase_order_lines l join public.products p on p.id = l.product_id
                where l.document_id = d.id and l.quantity - l.qty_received > 1e-9
             ), '[]')) order by d.number)
      from public.documents d
     where d.company_id = p_company_id and d.doc_type = 'PURCHASE_ORDER' and d.status in ('ENVIADO', 'RECIBIDO_PARCIAL')
  ), '[]');
end;
$$;

-- ------------------------------------------------------------------ Maestros y stock

create function public.customers_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'customer.read');
  return coalesce((
    select jsonb_agg(to_jsonb(c) order by c.code collate "C") from public.customers c where c.company_id = p_company_id
  ), '[]');
end;
$$;

create function public.suppliers_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'supplier.read');
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.code collate "C") from public.suppliers s where s.company_id = p_company_id
  ), '[]');
end;
$$;

-- Producto con su stock total, costo promedio y proveedor habitual (ProductRow).
create function private.product_row(p_product public.products)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(p_product) || jsonb_build_object(
    'stock', b.qty,
    'avg_cost', coalesce(nullif(case when b.qty > 0 then b.value / b.qty else coalesce(b.first_avg, 0) end, 0), p_product.standard_cost),
    'below_min', p_product.is_stockable and p_product.min_stock > 0 and b.qty < p_product.min_stock,
    'supplier_name', coalesce((select s.legal_name from public.suppliers s where s.id = p_product.default_supplier_id), '—')
  )
    from (
      select coalesce(sum(x.qty_on_hand), 0) as qty,
             coalesce(sum(x.qty_on_hand * x.avg_unit_cost), 0) as value,
             (select y.avg_unit_cost from public.stock_balances y join public.warehouses w on w.id = y.warehouse_id
               where y.product_id = p_product.id order by w.code collate "C" limit 1) as first_avg
        from public.stock_balances x where x.product_id = p_product.id
    ) b
$$;

create function public.products_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'product.read');
  return coalesce((
    select jsonb_agg(private.product_row(p) order by p.code collate "C") from public.products p where p.company_id = p_company_id
  ), '[]');
end;
$$;

-- Ficha del producto con saldos por depósito y kardex (productDetail).
create function public.product_detail(p_company_id uuid, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product public.products;
  v_stock boolean;
begin
  perform private.require_read(p_company_id, 'product.read');
  select * into v_product from public.products p where p.company_id = p_company_id and p.code = p_code;
  if not found then
    return null;
  end if;
  v_stock := private.has_permission(p_company_id, 'stock.read');
  return jsonb_build_object(
    'product', private.product_row(v_product),
    'balances', case when v_stock then coalesce((
      select jsonb_agg(to_jsonb(b) || jsonb_build_object('warehouse_name', w.name) order by w.code collate "C")
        from public.stock_balances b join public.warehouses w on w.id = b.warehouse_id
       where b.product_id = v_product.id
    ), '[]') else '[]' end,
    'kardex', case when v_stock then coalesce((
      select jsonb_agg(to_jsonb(m) || jsonb_build_object(
               'warehouse_name', coalesce(w.code, ''),
               'document_label', d.display_number,
               'document_path', case when d.id is not null then private.doc_path(d.id) end,
               'user_name', private.full_name(m.created_by)) order by m.id desc)
        from public.stock_movements m
        left join public.warehouses w on w.id = m.warehouse_id
        left join public.documents d on d.id = m.document_id
       where m.product_id = v_product.id
    ), '[]') else '[]' end
  );
end;
$$;

-- Stock por producto y depósito (listStock); sin saldos, una fila en cero en el depósito habitual.
create function public.stock_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'stock.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'product', to_jsonb(p), 'warehouse', to_jsonb(w), 'qty', x.qty, 'avg_cost', x.avg_cost,
             'value', x.qty * x.avg_cost, 'total_qty', t.total, 'below_min', p.min_stock > 0 and t.total < p.min_stock)
           order by p.code collate "C", w.code collate "C")
      from public.products p
      cross join lateral (
        select coalesce(sum(b.qty_on_hand), 0) as total from public.stock_balances b where b.product_id = p.id
      ) t
      cross join lateral (
        select b.warehouse_id, b.qty_on_hand as qty, b.avg_unit_cost as avg_cost
          from public.stock_balances b where b.product_id = p.id
        union all
        select p.default_warehouse_id, 0, p.standard_cost
         where not exists (select 1 from public.stock_balances b where b.product_id = p.id)
      ) x
      join public.warehouses w on w.id = x.warehouse_id
     where p.company_id = p_company_id and p.is_stockable
  ), '[]');
end;
$$;

-- ------------------------------------------------------------------ Tareas, avisos y auditoría

-- Tareas de la bandeja (listTasks): primero las que alguien está haciendo,
-- después de la más nueva a la más vieja.
create function private.task_items(p_company uuid, p_all boolean, p_include_closed boolean)
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
                        when t.task_type = 'REPONER_STOCK' then '/e/' || c.slug || '/stock' end,
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
     and (p_include_closed or t.status in ('PENDIENTE', 'EN_CURSO'))
     and (x.mine or p_all)
$$;

create function public.tasks_list(p_company_id uuid, p_scope text default 'mine', p_include_closed boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  return private.task_items(
    p_company_id, p_scope = 'all' and private.has_permission(p_company_id, 'task.read'), coalesce(p_include_closed, false));
end;
$$;

-- Avisos propios en la empresa, del más nuevo al más viejo; sin límite, el historial completo.
create function public.notifications_list(p_company_id uuid, p_limit int default 60)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
begin
  return coalesce((
    select jsonb_agg(to_jsonb(n) order by n.created_at desc)
      from (
        select * from public.notifications x
         where x.company_id = p_company_id and x.recipient_user_id = v_uid
         order by x.created_at desc
         limit p_limit
      ) n
  ), '[]');
end;
$$;

-- Auditoría visible (listAudit): todo con audit.read; si no, lo propio y lo de
-- documentos que puede leer.
create function private.audit_items(p_company uuid, p_limit int)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc), '[]')
    from (
      select e.*
        from public.audit_events e
        left join public.documents d on d.id = e.document_id
       where e.company_id = p_company
         and (private.has_permission(p_company, 'audit.read')
              or e.actor_user_id = (select auth.uid())
              or d.doc_type = any (private.readable_doc_types(p_company)))
       order by e.id desc
       limit p_limit
    ) e
$$;

create function public.audit_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  return private.audit_items(p_company_id, null);
end;
$$;

-- Exportar tiene permiso propio (*.export): se valida antes de devolver las filas.
create function public.export_rows(p_company_id uuid, p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  case p_kind
    when 'customers' then
      perform private.require_permission(p_company_id, 'customer.export');
      return public.customers_list(p_company_id);
    when 'suppliers' then
      perform private.require_permission(p_company_id, 'supplier.export');
      return public.suppliers_list(p_company_id);
    when 'products' then
      perform private.require_permission(p_company_id, 'product.export');
      return public.products_list(p_company_id);
    when 'stock' then
      perform private.require_permission(p_company_id, 'stock.export');
      return public.stock_list(p_company_id);
    when 'audit' then
      perform private.require_permission(p_company_id, 'audit.export');
      return public.audit_list(p_company_id);
    else
      perform private.raise_business_error('DATO_INVALIDO', 'Exportación desconocida.');
  end case;
end;
$$;

-- ------------------------------------------------------------------ Tablero

create function public.dashboard(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_stock boolean;
  v_low jsonb;
  v_tasks jsonb;
begin
  perform private.require_active_user();
  v_stock := private.has_permission(p_company_id, 'stock.read');
  select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'name', p.name, 'qty', s.qty, 'min', p.min_stock, 'uom', p.uom_code)
                  order by p.code collate "C"), '[]')
    into v_low
    from public.products p
    cross join lateral (select coalesce(sum(b.qty_on_hand), 0) as qty from public.stock_balances b where b.product_id = p.id) s
   where p.company_id = p_company_id and p.is_stockable and p.min_stock > 0 and s.qty < p.min_stock;
  v_tasks := private.task_items(p_company_id, false, false);
  return jsonb_build_object(
    'kpis', (
      select jsonb_build_object(
        'pr_pending', count(*) filter (where d.doc_type = 'PURCHASE_REQUISITION' and d.status in ('SOLICITADO', 'ORDENADO_PARCIAL')),
        'po_pending_approval', count(*) filter (where d.doc_type = 'PURCHASE_ORDER' and d.status = 'PENDIENTE_APROBACION'),
        'po_pending_amount', coalesce(sum(d.total) filter (where d.doc_type = 'PURCHASE_ORDER' and d.status = 'PENDIENTE_APROBACION'), 0),
        'po_in_transit', count(*) filter (where d.doc_type = 'PURCHASE_ORDER' and d.status in ('ENVIADO', 'RECIBIDO_PARCIAL')),
        'below_min', jsonb_array_length(v_low),
        'inventory_value', case when v_stock then (
          select coalesce(sum(b.qty_on_hand * b.avg_unit_cost), 0) from public.stock_balances b where b.company_id = p_company_id) end,
        'purchases_month', coalesce(sum(d.total) filter (
          where d.doc_type = 'PURCHASE_ORDER' and d.status <> 'ANULADO'
            and to_char(po.approved_at at time zone 'UTC', 'YYYY-MM') = to_char(now() at time zone 'UTC', 'YYYY-MM')), 0),
        'my_tasks', jsonb_array_length(v_tasks))
        from public.documents d
        left join public.purchase_orders po on po.document_id = d.id
       where d.company_id = p_company_id
    ),
    'po_by_status', coalesce((
      select jsonb_agg(jsonb_build_object('status', s.code, 'label', s.label, 'badge', s.badge, 'count', x.n) order by s.sort)
        from public.document_statuses s
        cross join lateral (
          select count(*) as n from public.documents d
           where d.company_id = p_company_id and d.doc_type = 'PURCHASE_ORDER' and d.status = s.code
        ) x
       where s.doc_type = 'PURCHASE_ORDER' and x.n > 0
    ), '[]'),
    'low_stock', case when v_stock then v_low else '[]' end,
    'activity', private.audit_items(p_company_id, 8),
    'tasks', coalesce((select jsonb_agg(t.x order by t.i) from jsonb_array_elements(v_tasks) with ordinality as t (x, i) where t.i <= 6), '[]'),
    'lead_time_hours', (
      select avg(extract(epoch from gr.received_at - pr.created_at) / 3600)
        from public.documents g
        join public.goods_receipts gr on gr.document_id = g.id
        join public.document_links l on l.to_document_id = gr.purchase_order_id
        join public.documents pr on pr.id = l.from_document_id and pr.company_id = g.company_id
       where g.company_id = p_company_id and g.doc_type = 'GOODS_RECEIPT' and g.status = 'CONFIRMADO' and gr.received_at is not null
    ),
    'can', jsonb_build_object(
      'purchasing', private.has_permission(p_company_id, 'purchase_order.read'),
      'stock', v_stock,
      'audit', private.has_permission(p_company_id, 'audit.read'))
  );
end;
$$;

-- ------------------------------------------------------------------ Panel docente y escuela

-- Roles de un integrante (activo o no), en el orden del catálogo.
create function private.member_roles_of(p_member uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', mr.id, 'role_code', mr.role_code, 'role_name', r.name, 'sector_id', mr.sector_id,
    'sector_name', coalesce(s.name, '—'), 'island', i.number
  ) order by r.sort, s.code collate "C" nulls first), '[]'::jsonb)
    from public.member_roles mr
    join public.roles r on r.code = mr.role_code
    left join public.sectors s on s.id = mr.sector_id
    left join public.islands i on i.id = s.island_id
   where mr.member_id = p_member
$$;

-- Integrantes de la empresa con sus roles y actividad (listMembers): sólo supervisores.
create function public.members_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  if not private.is_supervisor(p_company_id) then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo docentes');
  end if;
  return coalesce((
    select jsonb_agg(x.item order by x.island, private.sort_key(x.last_name) collate "C",
                     private.sort_key(x.first_name) collate "C", x.username collate "C")
      from (
        select jsonb_build_object(
                 'user', private.public_profile_json(m.user_id),
                 'member_id', m.id,
                 'job_title', m.job_title,
                 'roles', roles.list,
                 'last_activity', (select e.occurred_at from public.audit_events e
                                    where e.company_id = p_company_id and e.actor_user_id = m.user_id
                                    order by e.id desc limit 1),
                 'actions_count', (select count(*) from public.audit_events e
                                    where e.company_id = p_company_id and e.actor_user_id = m.user_id)
               ) as item,
               coalesce((roles.list -> 0 ->> 'island')::int, 99) as island,
               p.last_name, p.first_name, p.username
          from public.company_members m
          join public.profiles p on p.id = m.user_id
          cross join lateral (select private.member_roles_of(m.id) as list) roles
         where m.company_id = p_company_id
      ) x
  ), '[]');
end;
$$;

-- Cursos: los administra la escuela; el docente los consulta para crear la empresa de su curso.
create function public.courses_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  if private.current_app_role() <> 'DOCENTE' and not private.is_school_admin() then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo la administración de la escuela puede ver esto.');
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(c) order by c.academic_year desc, private.sort_key(c.name) collate "C")
      from public.courses c
  ), '[]');
end;
$$;

create function public.teachers_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  if not private.is_school_admin() then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo la administración de la escuela puede ver esto.');
  end if;
  return coalesce((
    select jsonb_agg(private.public_profile_json(p.id)
                     order by private.sort_key(p.last_name) collate "C", private.sort_key(p.first_name) collate "C",
                              p.username collate "C")
      from public.profiles p where p.app_role = 'DOCENTE'
  ), '[]');
end;
$$;

-- ------------------------------------------------------------------ Permisos de ejecución
do $$
declare
  f text;
begin
  foreach f in array array[
    'documents_list(uuid, text)', 'document_detail(uuid, text, text)', 'document_detail_by_id(uuid)',
    'requisition_lines_pending(uuid)', 'orders_receivable(uuid)', 'customers_list(uuid)', 'suppliers_list(uuid)',
    'products_list(uuid)', 'product_detail(uuid, text)', 'stock_list(uuid)', 'tasks_list(uuid, text, boolean)',
    'notifications_list(uuid, int)', 'audit_list(uuid)', 'export_rows(uuid, text)', 'dashboard(uuid)',
    'members_list(uuid)', 'courses_list()', 'teachers_list()'
  ] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
