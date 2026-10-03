-- 11. RPC de documentos (DATABASE.md §13): una por comando del motor simulado,
-- con los mismos códigos de error y mensajes. Prefijos: pr_ (solicitud),
-- po_ (orden), gr_ (recepción), sa_ (ajuste).

-- ------------------------------------------------------------------ Utilidades comunes

create function private.product_for(p_company uuid, p_product uuid)
returns public.products
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p public.products;
begin
  select * into v_p from public.products p where p.company_id = p_company and p.id = p_product;
  if not found then
    perform private.raise_business_error('PRODUCTO_INEXISTENTE', 'El producto no existe en esta empresa.');
  end if;
  return v_p;
end;
$$;

-- Lo modifica quien lo creó o alguien de su mismo sector (o el docente).
create function private.assert_same_sector_or_creator(p_doc public.documents)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.is_supervisor(p_doc.company_id) or p_doc.created_by = (select auth.uid()) then
    return;
  end if;
  if p_doc.sector_id is null or not exists (
    select 1 from public.company_members m
      join public.member_roles mr on mr.company_id = m.company_id and mr.member_id = m.id
     where m.company_id = p_doc.company_id and m.user_id = (select auth.uid()) and m.is_active
       and mr.sector_id = p_doc.sector_id
  ) then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo quien creó el documento o su mismo sector pueden modificarlo.');
  end if;
end;
$$;

create function private.created_result(p_doc_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$ select jsonb_build_object('id', d.id, 'display_number', d.display_number) from public.documents d where d.id = p_doc_id $$;

create function private.items_label(p_count int)
returns text
language sql
immutable
set search_path = ''
as $$ select p_count || ' ítem' || case when p_count > 1 then 's' else '' end $$;

-- ------------------------------------------------------------------ Solicitud de compra

-- Valida el pedido y devuelve sus líneas útiles: [{product_id, quantity, notes}].
create function private.validate_requisition(p_company uuid, p_input jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lines jsonb;
  v_line jsonb;
  v_p public.products;
begin
  if length(trim(coalesce(p_input ->> 'reason', ''))) < 5 then
    perform private.raise_business_error('DATO_INVALIDO', 'Explicá el motivo de la solicitud (mínimo 5 caracteres).',
      'Toda compra empieza con una necesidad justificada.');
  end if;
  if coalesce(p_input ->> 'priority', 'NORMAL') not in ('BAJA', 'NORMAL', 'ALTA', 'URGENTE') then
    perform private.raise_business_error('DATO_INVALIDO', 'La prioridad no es válida.');
  end if;
  select coalesce(jsonb_agg(l), '[]'::jsonb) into v_lines
    from jsonb_array_elements(coalesce(p_input -> 'lines', '[]'::jsonb)) as l
   where nullif(l ->> 'product_id', '') is not null;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Agregá al menos un producto.');
  end if;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_p := private.product_for(p_company, (v_line ->> 'product_id')::uuid);
    if not v_p.is_active then
      perform private.raise_business_error('DATO_INVALIDO', format('%s %s está inactivo.', v_p.code, v_p.name));
    end if;
    if coalesce((v_line ->> 'quantity')::numeric, 0) <= 0 then
      perform private.raise_business_error('DATO_INVALIDO', format('La cantidad de %s debe ser mayor que cero.', v_p.code));
    end if;
  end loop;
  if nullif(p_input ->> 'needed_by', '') is not null and (p_input ->> 'needed_by')::date < private.business_date(p_company) then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha necesaria no puede ser anterior a hoy.');
  end if;
  return v_lines;
end;
$$;

create function private.write_requisition(p_doc public.documents, p_input jsonb, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.purchase_requisitions (document_id, company_id, needed_by, priority, reason)
  values (p_doc.id, p_doc.company_id, nullif(p_input ->> 'needed_by', '')::date,
          coalesce(p_input ->> 'priority', 'NORMAL'), trim(p_input ->> 'reason'))
  on conflict (document_id) do update
    set needed_by = excluded.needed_by, priority = excluded.priority, reason = excluded.reason;
  delete from public.purchase_requisition_lines where document_id = p_doc.id;
  insert into public.purchase_requisition_lines (company_id, document_id, line_no, product_id, quantity, notes)
  select p_doc.company_id, p_doc.id, ord::int, (l ->> 'product_id')::uuid, round((l ->> 'quantity')::numeric, 3),
         coalesce(l ->> 'notes', '')
    from jsonb_array_elements(p_lines) with ordinality as x (l, ord);
end;
$$;

create function private.submit_requisition(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_same_sector_or_creator(p_doc);
  perform private.transition_document(p_doc.id, 'SUBMIT', p_summary => format('Envió %s a Compras', p_doc.display_number));
  -- La solicitud atiende las alertas de stock mínimo de sus productos.
  update public.tasks t set status = 'RESUELTA', completed_by = (select auth.uid()), completed_at = now()
   where t.company_id = p_doc.company_id and t.task_type = 'REPONER_STOCK' and t.status in ('PENDIENTE', 'EN_CURSO')
     and t.context ->> 'product_id' in (
       select rl.product_id::text from public.purchase_requisition_lines rl where rl.document_id = p_doc.id
     );
end;
$$;

create function public.pr_create(p_company_id uuid, p_input jsonb, p_submit boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'purchase_requisition.create');
  v_lines jsonb := private.validate_requisition(p_company_id, p_input);
  v_doc public.documents;
begin
  v_doc := private.new_document(p_company_id, 'PURCHASE_REQUISITION', v_actor, null, p_input ->> 'notes');
  perform private.write_requisition(v_doc, p_input, v_lines);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'purchase_requisition', v_doc.id, v_doc.display_number,
    format('Creó %s (%s)', v_doc.display_number, private.items_label(jsonb_array_length(v_lines))), v_doc.id, null, 'BORRADOR');
  if p_submit then
    perform private.submit_requisition(v_doc);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.pr_update(p_document_id uuid, p_input jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_REQUISITION');
  v_actor private.actor := private.require_permission(v_doc.company_id, 'purchase_requisition.update');
  v_lines jsonb;
begin
  if v_doc.status <> 'BORRADOR' then
    perform private.raise_business_error('TRANSICION_INVALIDA', 'Sólo se puede modificar una solicitud en borrador.');
  end if;
  perform private.assert_same_sector_or_creator(v_doc);
  v_lines := private.validate_requisition(v_doc.company_id, p_input);
  update public.documents set notes = coalesce(p_input ->> 'notes', '') where id = v_doc.id;
  perform private.write_requisition(v_doc, p_input, v_lines);
  perform private.log_audit(v_doc.company_id, v_actor, 'UPDATE', 'purchase_requisition', v_doc.id, v_doc.display_number,
    format('Modificó %s', v_doc.display_number), v_doc.id);
end;
$$;

create function public.pr_submit(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.submit_requisition(private.get_document(p_document_id, 'PURCHASE_REQUISITION'));
end;
$$;

create function public.pr_reject(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_REQUISITION');
begin
  perform private.require_active_user();
  perform private.transition_document(v_doc.id, 'REJECT', p_reason);
  perform private.notify_users(v_doc.company_id, array[v_doc.created_by], 'SC_RECHAZADA',
    format('%s fue rechazada por Compras', v_doc.display_number), p_reason, private.doc_path(v_doc.id), v_doc.id, null,
    (select auth.uid()));
end;
$$;

create function public.pr_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_REQUISITION');
begin
  perform private.require_active_user();
  perform private.assert_same_sector_or_creator(v_doc);
  perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
end;
$$;

create function public.pr_close(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.transition_document((private.get_document(p_document_id, 'PURCHASE_REQUISITION')).id, 'CLOSE', p_reason);
end;
$$;

-- ------------------------------------------------------------------ Orden de compra

-- Valida proveedor, depósito y líneas; con vínculo a una SC, que no supere lo pendiente.
create function private.validate_purchase_order(p_company uuid, p_input jsonb, p_current uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_supplier public.suppliers;
  v_lines jsonb;
  v_line jsonb;
  v_p public.products;
  v_rl public.purchase_requisition_lines;
  v_req public.documents;
  v_used jsonb := '{}'::jsonb;
  v_elsewhere numeric;
  v_pending numeric;
  v_total_used numeric;
begin
  select * into v_supplier from public.suppliers s
   where s.company_id = p_company and s.id = nullif(p_input ->> 'supplier_id', '')::uuid;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí un proveedor.');
  end if;
  if not v_supplier.is_active then
    perform private.raise_business_error('DATO_INVALIDO', format('El proveedor %s está inactivo.', v_supplier.legal_name));
  end if;
  if not exists (
    select 1 from public.warehouses w where w.company_id = p_company and w.id = nullif(p_input ->> 'warehouse_id', '')::uuid
  ) then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el depósito de destino.');
  end if;
  select coalesce(jsonb_agg(l), '[]'::jsonb) into v_lines
    from jsonb_array_elements(coalesce(p_input -> 'lines', '[]'::jsonb)) as l
   where nullif(l ->> 'product_id', '') is not null;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Agregá al menos un ítem.');
  end if;
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_p := private.product_for(p_company, (v_line ->> 'product_id')::uuid);
    if not v_p.is_active then
      perform private.raise_business_error('DATO_INVALIDO', format('%s %s está inactivo.', v_p.code, v_p.name));
    end if;
    if coalesce((v_line ->> 'quantity')::numeric, 0) <= 0 then
      perform private.raise_business_error('DATO_INVALIDO', format('La cantidad de %s debe ser mayor que cero.', v_p.code));
    end if;
    if (v_line ->> 'unit_price') is null or (v_line ->> 'unit_price')::numeric < 0 then
      perform private.raise_business_error('DATO_INVALIDO', format('Indicá el precio unitario de %s.', v_p.code));
    end if;
    if coalesce((v_line ->> 'vat_rate')::numeric, -1) not in (0, 10.5, 21, 27) then
      perform private.raise_business_error('DATO_INVALIDO', format('La alícuota de IVA de %s no es válida.', v_p.code));
    end if;
    if nullif(v_line ->> 'requisition_line_id', '') is not null then
      select * into v_rl from public.purchase_requisition_lines rl
       where rl.company_id = p_company and rl.id = (v_line ->> 'requisition_line_id')::uuid;
      if not found then
        perform private.raise_business_error('DATO_INVALIDO', 'La línea de solicitud vinculada no existe.');
      end if;
      select * into v_req from public.documents d where d.id = v_rl.document_id;
      if v_req.status not in ('SOLICITADO', 'ORDENADO_PARCIAL', 'ORDENADO') then
        perform private.raise_business_error('TRANSICION_INVALIDA', format('%s no está pendiente de atención.', v_req.display_number));
      end if;
      if v_rl.product_id <> v_p.id then
        perform private.raise_business_error('DATO_INVALIDO', format('El producto no coincide con el de %s.', v_req.display_number));
      end if;
      select coalesce(sum(pl.quantity), 0) into v_elsewhere
        from public.purchase_order_lines pl join public.documents d on d.id = pl.document_id
       where pl.requisition_line_id = v_rl.id and pl.document_id is distinct from p_current and d.status <> 'ANULADO';
      v_total_used := coalesce((v_used ->> v_rl.id::text)::numeric, 0) + (v_line ->> 'quantity')::numeric;
      v_used := v_used || jsonb_build_object(v_rl.id::text, v_total_used);
      v_pending := round(v_rl.quantity - v_elsewhere, 3);
      if v_total_used > v_pending then
        perform private.raise_business_error('CANTIDAD_EXCEDE_PENDIENTE',
          format('%s: la cantidad supera lo pendiente de %s (%s).', v_p.code, v_req.display_number, private.format_qty(v_pending, v_p.uom_code)),
          'Si hace falta comprar más, agregá una línea sin vínculo a la solicitud.');
      end if;
    end if;
  end loop;
  return v_lines;
end;
$$;

create function private.write_purchase_order(p_doc public.documents, p_input jsonb, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.purchase_orders (document_id, company_id, expected_date, warehouse_id, payment_terms_days, delivery_terms)
  values (p_doc.id, p_doc.company_id, nullif(p_input ->> 'expected_date', '')::date, (p_input ->> 'warehouse_id')::uuid,
          coalesce((p_input ->> 'payment_terms_days')::int, 0), coalesce(p_input ->> 'delivery_terms', ''))
  on conflict (document_id) do update
    set expected_date = excluded.expected_date, warehouse_id = excluded.warehouse_id,
        payment_terms_days = excluded.payment_terms_days, delivery_terms = excluded.delivery_terms;
  delete from public.purchase_order_lines where document_id = p_doc.id;
  insert into public.purchase_order_lines (company_id, document_id, line_no, product_id, requisition_line_id, quantity,
                                           unit_price, vat_rate, line_subtotal, line_tax, line_total)
  select p_doc.company_id, p_doc.id, ord::int, (l ->> 'product_id')::uuid, nullif(l ->> 'requisition_line_id', '')::uuid,
         round(q, 3), round(price, 4), rate, sub, tax, sub + tax
    from jsonb_array_elements(p_lines) with ordinality as x (l, ord),
         lateral (select (l ->> 'quantity')::numeric as q, (l ->> 'unit_price')::numeric as price,
                         (l ->> 'vat_rate')::numeric as rate) as v,
         lateral (select round(q * price, 2) as sub) as s,
         lateral (select round(sub * rate / 100, 2) as tax) as t;
  -- Los totales se recalculan en el servidor: nunca se confía en los del cliente.
  update public.documents d
     set subtotal = totals.sub, tax_total = totals.tax, total = totals.sub + totals.tax
    from (select coalesce(sum(pl.line_subtotal), 0) as sub, coalesce(sum(pl.line_tax), 0) as tax
            from public.purchase_order_lines pl where pl.document_id = p_doc.id) as totals
   where d.id = p_doc.id;
end;
$$;

create function public.po_create(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'purchase_order.create');
  v_lines jsonb := private.validate_purchase_order(p_company_id, p_input);
  v_doc public.documents;
begin
  v_doc := private.new_document(p_company_id, 'PURCHASE_ORDER', v_actor, (p_input ->> 'supplier_id')::uuid, p_input ->> 'notes');
  perform private.write_purchase_order(v_doc, p_input, v_lines);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'purchase_order', v_doc.id, v_doc.display_number,
    format('Creó %s a %s por %s', v_doc.display_number,
           (select s.legal_name from public.suppliers s where s.id = v_doc.supplier_id),
           private.format_money((select d.total from public.documents d where d.id = v_doc.id))),
    v_doc.id, null, 'BORRADOR');
  perform private.sync_order_links(v_doc.id, '{}');
  return private.created_result(v_doc.id);
end;
$$;

create function public.po_update(p_document_id uuid, p_input jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_ORDER');
  v_actor private.actor := private.require_permission(v_doc.company_id, 'purchase_order.update');
  v_previous uuid[];
  v_lines jsonb;
begin
  if v_doc.status <> 'BORRADOR' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      'Sólo se puede modificar una orden en borrador. Si fue rechazada, primero reabrila.');
  end if;
  v_previous := array(select private.requisitions_of_order(v_doc.id));
  v_lines := private.validate_purchase_order(v_doc.company_id, p_input, v_doc.id);
  update public.documents set supplier_id = (p_input ->> 'supplier_id')::uuid, notes = coalesce(p_input ->> 'notes', '')
   where id = v_doc.id;
  perform private.write_purchase_order(v_doc, p_input, v_lines);
  perform private.log_audit(v_doc.company_id, v_actor, 'UPDATE', 'purchase_order', v_doc.id, v_doc.display_number,
    format('Modificó %s (total %s)', v_doc.display_number,
           private.format_money((select d.total from public.documents d where d.id = v_doc.id))), v_doc.id);
  perform private.sync_order_links(v_doc.id, v_previous);
end;
$$;

create function private.find_approval_rule(p_company uuid, p_doc_type text, p_amount numeric)
returns public.approval_rules
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from public.approval_rules r
   where r.company_id = p_company and r.doc_type = p_doc_type and r.is_active
     and p_amount >= r.min_amount and (r.max_amount is null or p_amount <= r.max_amount)
   order by r.level, r.min_amount
   limit 1
$$;

create function public.po_submit(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_ORDER');
  v_rule public.approval_rules;
  v_requisition uuid;
begin
  perform private.require_permission(v_doc.company_id, 'purchase_order.create');
  if v_doc.status <> 'BORRADOR' then
    perform private.raise_business_error('TRANSICION_INVALIDA', format('%s no está en borrador.', v_doc.display_number));
  end if;
  v_rule := private.find_approval_rule(v_doc.company_id, 'PURCHASE_ORDER', v_doc.total);
  if v_rule.id is null then
    perform private.raise_business_error('SIN_REGLA_APROBACION', 'No hay una regla de aprobación para este monto. Avisá al docente.');
  end if;
  insert into public.approval_requests (company_id, document_id, rule_id, level, approver_role, amount, requested_by)
  values (v_doc.company_id, v_doc.id, v_rule.id, v_rule.level, v_rule.approver_role, v_doc.total, (select auth.uid()));
  perform private.transition_document(v_doc.id, 'SUBMIT', p_summary => format('Envió %s a aprobación (%s: aprueba %s)',
    v_doc.display_number, private.format_money(v_doc.total), (select r.name from public.roles r where r.code = v_rule.approver_role)));
  -- Recién ahora deja de ser un borrador: las solicitudes que cubre pasan a "Ordenada".
  for v_requisition in select private.requisitions_of_order(v_doc.id) loop
    perform private.recompute_requisition(v_requisition);
  end loop;
end;
$$;

create function private.pending_approval(p_document uuid)
returns public.approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.approval_requests;
begin
  select * into v_req from public.approval_requests ar where ar.document_id = p_document and ar.status = 'PENDIENTE' for update;
  if not found then
    perform private.raise_business_error('TRANSICION_INVALIDA', 'La orden ya no está pendiente de aprobación.');
  end if;
  return v_req;
end;
$$;

-- Rol aprobador según el monto y separación de funciones: quien compra no autoriza su propia compra.
create function private.approver_actor(p_doc public.documents, p_req public.approval_requests)
returns private.actor
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_supervisor boolean;
begin
  perform private.require_permission(p_doc.company_id, 'purchase_order.approve');
  v_supervisor := private.is_supervisor(p_doc.company_id);
  if not v_supervisor and not exists (
    select 1 from private.my_role_codes(p_doc.company_id) as rc (code) where rc.code = p_req.approver_role
  ) then
    perform private.raise_business_error('APROBADOR_INCORRECTO',
      format('Esta orden debe aprobarla %s: el total (%s) corresponde a ese nivel de autorización.',
             (select r.name from public.roles r where r.code = p_req.approver_role), private.format_money(p_req.amount)),
      'Los niveles de autorización dependen del monto de la operación.');
  end if;
  if not v_supervisor
     and coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = p_doc.company_id), true)
     and coalesce((select r.require_different_user from public.approval_rules r where r.id = p_req.rule_id), true)
     and p_doc.created_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES', 'No podés aprobar una orden de compra que creaste vos.',
      'Separación de funciones: quien compra no autoriza su propia compra. Pedile a otro integrante del sector aprobador que la revise.');
  end if;
  return case when v_supervisor then private.actor_for(p_doc.company_id)
              else private.actor_for(p_doc.company_id, null, p_req.approver_role) end;
end;
$$;

create function public.po_approve(p_document_id uuid, p_comment text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_ORDER');
  v_req public.approval_requests := private.pending_approval(v_doc.id);
  v_actor private.actor := private.approver_actor(v_doc, v_req);
  v_comment text := trim(coalesce(p_comment, ''));
begin
  update public.approval_requests
     set status = 'APROBADO', decided_by = (select auth.uid()), decided_at = now(), comment = v_comment
   where id = v_req.id;
  update public.purchase_orders set approved_at = now() where document_id = v_doc.id;
  perform private.transition_document(v_doc.id, 'APPROVE', v_comment, null, v_actor,
    format('Aprobó %s por %s%s', v_doc.display_number, private.format_money(v_doc.total),
           case when v_comment <> '' then ' — ' || v_comment else '' end));
  perform private.notify_users(v_doc.company_id, array[v_doc.created_by], 'OC_APROBADA',
    format('%s fue aprobada', v_doc.display_number), format('Aprobó: %s (%s).', (v_actor).name, (v_actor).sector_name),
    private.doc_path(v_doc.id), v_doc.id, null, (select auth.uid()));
end;
$$;

create function public.po_reject(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_ORDER');
  v_req public.approval_requests := private.pending_approval(v_doc.id);
  v_actor private.actor := private.approver_actor(v_doc, v_req);
begin
  if length(trim(coalesce(p_reason, ''))) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo del rechazo.');
  end if;
  update public.approval_requests
     set status = 'RECHAZADO', decided_by = (select auth.uid()), decided_at = now(), comment = trim(p_reason)
   where id = v_req.id;
  perform private.transition_document(v_doc.id, 'REJECT', p_reason, null, v_actor);
end;
$$;

create function public.po_withdraw(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_ORDER');
  v_req public.approval_requests;
  v_requisition uuid;
begin
  perform private.require_active_user();
  if not private.is_supervisor(v_doc.company_id) and v_doc.created_by is distinct from (select auth.uid()) then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo quien creó la orden puede retirarla de aprobación.');
  end if;
  v_req := private.pending_approval(v_doc.id);
  update public.approval_requests set status = 'CANCELADO', decided_at = now() where id = v_req.id;
  perform private.transition_document(v_doc.id, 'WITHDRAW');
  -- Vuelve a ser un borrador: las solicitudes que cubría dejan de contarla como "ya ordenado".
  for v_requisition in select private.requisitions_of_order(v_doc.id) loop
    perform private.recompute_requisition(v_requisition);
  end loop;
end;
$$;

create function public.po_reopen(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.transition_document((private.get_document(p_document_id, 'PURCHASE_ORDER')).id, 'REOPEN');
end;
$$;

create function public.po_send(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_ORDER');
begin
  perform private.require_active_user();
  perform private.transition_document(v_doc.id, 'SEND', p_summary => format('Envió %s al proveedor %s', v_doc.display_number,
    coalesce((select s.legal_name from public.suppliers s where s.id = v_doc.supplier_id), '')));
  update public.purchase_orders set sent_at = now() where document_id = v_doc.id;
end;
$$;

create function public.po_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'PURCHASE_ORDER');
  v_requisitions uuid[];
  v_requisition uuid;
begin
  perform private.require_active_user();
  if exists (select 1 from public.purchase_order_lines pl where pl.document_id = v_doc.id and pl.qty_received > 0) then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      'La orden tiene recepciones confirmadas: no se puede anular. Usá "Cerrar saldo".');
  end if;
  v_requisitions := array(select private.requisitions_of_order(v_doc.id));
  perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
  foreach v_requisition in array v_requisitions loop
    perform private.recompute_requisition(v_requisition);
  end loop;
end;
$$;

create function public.po_close(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.transition_document((private.get_document(p_document_id, 'PURCHASE_ORDER')).id, 'CLOSE', p_reason);
end;
$$;

-- ------------------------------------------------------------------ Recepción

create function private.confirm_receipt(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gr public.goods_receipts;
  v_po public.documents;
  v_actor private.actor;
  v_line public.goods_receipt_lines;
  v_pl public.purchase_order_lines;
  v_p public.products;
  v_full boolean;
begin
  select * into v_gr from public.goods_receipts g where g.document_id = p_doc.id;
  v_po := private.get_document(v_gr.purchase_order_id, 'PURCHASE_ORDER');
  if v_po.status not in ('ENVIADO', 'RECIBIDO_PARCIAL') then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s ya no admite recepciones (estado "%s").', v_po.display_number, private.status_label('PURCHASE_ORDER', v_po.status)));
  end if;
  v_actor := private.transition_document(p_doc.id, 'CONFIRM', p_summary => format(
    'Confirmó %s: ingresó mercadería de %s (remito %s)', p_doc.display_number, v_po.display_number, v_gr.supplier_delivery_note));
  for v_line in select * from public.goods_receipt_lines l where l.document_id = p_doc.id order by l.line_no loop
    select * into v_pl from public.purchase_order_lines pl where pl.id = v_line.po_line_id for update;
    if v_line.quantity > v_pl.quantity - v_pl.qty_received then
      v_p := private.product_for(p_doc.company_id, v_line.product_id);
      perform private.raise_business_error('CANTIDAD_EXCEDE_PENDIENTE',
        format('%s: la cantidad supera lo pendiente de la orden (%s).', v_p.code,
               private.format_qty(v_pl.quantity - v_pl.qty_received, v_p.uom_code)));
    end if;
    update public.purchase_order_lines set qty_received = round(qty_received + v_line.quantity, 3) where id = v_pl.id;
    perform private.post_stock_movement(p_doc.company_id, v_line.product_id, v_gr.warehouse_id, 'RECEPCION_COMPRA',
      v_line.quantity, v_line.unit_cost, p_doc.id, v_line.id, p_doc.document_date);
  end loop;
  update public.goods_receipts set received_at = now() where document_id = p_doc.id;
  perform private.recompute_purchase_order(v_po.id);
  select d.status = 'RECIBIDO' into v_full from public.documents d where d.id = v_po.id;
  perform private.notify_roles(p_doc.company_id, array['COMPRAS'], 'OC_RECIBIDA',
    format('%s %s', v_po.display_number, case when v_full then 'recibida' else 'recibida parcialmente' end),
    format('Depósito registró %s (remito %s).', p_doc.display_number, v_gr.supplier_delivery_note),
    private.doc_path(v_po.id), v_po.id, null, (v_actor).user_id);
  perform private.notify_users(
    p_doc.company_id,
    array(select d.created_by from public.documents d where d.id in (select private.requisitions_of_order(v_po.id))),
    'MATERIAL_DISPONIBLE',
    'Material disponible: ' || (
      select string_agg(code, ', ' order by code) from (
        select distinct p.code from public.goods_receipt_lines l join public.products p on p.id = l.product_id
         where l.document_id = p_doc.id
      ) as codes
    ),
    format('Ingresó al stock con %s.', p_doc.display_number), private.doc_path(p_doc.id), p_doc.id, null, (v_actor).user_id
  );
end;
$$;

create function public.gr_create(p_company_id uuid, p_input jsonb, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'goods_receipt.create');
  v_po public.documents;
  v_note text := trim(coalesce(p_input ->> 'supplier_delivery_note', ''));
  v_duplicate text;
  v_lines jsonb;
  v_line jsonb;
  v_pl public.purchase_order_lines;
  v_p public.products;
  v_doc public.documents;
  v_no int := 0;
  v_total numeric := 0;
begin
  -- La OC queda bloqueada: dos recepciones simultáneas contra la misma orden se ordenan una detrás de otra.
  v_po := private.get_document(nullif(p_input ->> 'purchase_order_id', '')::uuid, 'PURCHASE_ORDER');
  if v_po.company_id <> p_company_id then
    perform private.raise_business_error('DATO_INVALIDO', 'La orden no pertenece a esta empresa.');
  end if;
  if v_po.status not in ('ENVIADO', 'RECIBIDO_PARCIAL') then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está "%s": sólo se reciben órdenes enviadas al proveedor.', v_po.display_number,
             private.status_label('PURCHASE_ORDER', v_po.status)));
  end if;
  if length(v_note) < 3 then
    perform private.raise_business_error('DATO_INVALIDO', 'Ingresá el número de remito del proveedor.',
      'El remito es el comprobante que acompaña la mercadería: se controla contra la OC.');
  end if;
  select d.display_number into v_duplicate
    from public.goods_receipts g join public.documents d on d.id = g.document_id
   where g.purchase_order_id = v_po.id and d.status <> 'ANULADO' and upper(trim(g.supplier_delivery_note)) = upper(v_note)
   limit 1;
  if v_duplicate is not null then
    perform private.raise_business_error('REMITO_DUPLICADO',
      format('Ya existe %s con el remito %s contra %s.', v_duplicate, v_note, v_po.display_number),
      'Revisá si esta entrega ya se registró antes de cargarla de nuevo. Si fue un error, anulá la recepción anterior primero.');
  end if;
  if not exists (
    select 1 from public.warehouses w where w.company_id = p_company_id and w.id = nullif(p_input ->> 'warehouse_id', '')::uuid
  ) then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el depósito.');
  end if;
  select coalesce(jsonb_agg(l), '[]'::jsonb) into v_lines
    from jsonb_array_elements(coalesce(p_input -> 'lines', '[]'::jsonb)) as l
   where coalesce((l ->> 'quantity')::numeric, 0) > 0;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá la cantidad recibida de al menos un ítem.');
  end if;

  v_doc := private.new_document(p_company_id, 'GOODS_RECEIPT', v_actor, v_po.supplier_id, p_input ->> 'notes');
  insert into public.goods_receipts (document_id, company_id, purchase_order_id, warehouse_id, supplier_delivery_note, carrier_name)
  values (v_doc.id, p_company_id, v_po.id, (p_input ->> 'warehouse_id')::uuid, v_note, trim(coalesce(p_input ->> 'carrier_name', '')));
  for v_line in select * from jsonb_array_elements(v_lines) loop
    select * into v_pl from public.purchase_order_lines pl
     where pl.id = nullif(v_line ->> 'po_line_id', '')::uuid and pl.document_id = v_po.id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Una línea no corresponde a la orden de compra.');
    end if;
    v_p := private.product_for(p_company_id, v_pl.product_id);
    if (v_line ->> 'quantity')::numeric > v_pl.quantity - v_pl.qty_received then
      perform private.raise_business_error('CANTIDAD_EXCEDE_PENDIENTE',
        format('%s: se reciben %s pero sólo quedan %s pendientes.', v_p.code, private.format_qty((v_line ->> 'quantity')::numeric),
               private.format_qty(v_pl.quantity - v_pl.qty_received, v_p.uom_code)),
        'No se puede recibir más de lo ordenado. Si llegó de más, se devuelve o se gestiona una nueva OC.');
    end if;
    v_no := v_no + 1;
    v_total := v_total + (v_line ->> 'quantity')::numeric * v_pl.unit_price;
    insert into public.goods_receipt_lines (company_id, document_id, line_no, po_line_id, product_id, quantity, unit_cost, notes)
    values (p_company_id, v_doc.id, v_no, v_pl.id, v_pl.product_id, round((v_line ->> 'quantity')::numeric, 3), v_pl.unit_price,
            coalesce(v_line ->> 'notes', ''));
  end loop;
  update public.documents set subtotal = round(v_total, 2), total = round(v_total, 2) where id = v_doc.id;
  perform private.link_documents(p_company_id, v_po.id, v_doc.id);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'goods_receipt', v_doc.id, v_doc.display_number,
    format('Creó %s contra %s (remito %s)', v_doc.display_number, v_po.display_number, v_note), v_doc.id, null, 'BORRADOR');
  if p_confirm then
    perform private.confirm_receipt(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.gr_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.confirm_receipt(private.get_document(p_document_id, 'GOODS_RECEIPT'));
end;
$$;

-- Una recepción confirmada se anula con contramovimiento, y no la puede anular quien la registró.
create function public.gr_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents := private.get_document(p_document_id, 'GOODS_RECEIPT');
  v_gr public.goods_receipts;
  v_po public.documents;
  v_line public.goods_receipt_lines;
begin
  perform private.require_active_user();
  if v_doc.status <> 'CONFIRMADO' then
    perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
    return;
  end if;
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and not private.is_supervisor(v_doc.company_id)
     and not exists (select 1 from private.my_role_codes(v_doc.company_id) as rc (code) where rc.code = 'GERENCIA')
     and v_doc.created_by = (select auth.uid()) then
    perform private.raise_business_error('SEPARACION_FUNCIONES', 'No podés anular una recepción que registraste vos.',
      'Otro integrante de Depósito o Gerencia debe revisar y anular.');
  end if;
  select * into v_gr from public.goods_receipts g where g.document_id = v_doc.id;
  v_po := private.get_document(v_gr.purchase_order_id, 'PURCHASE_ORDER');
  if v_po.status = 'CERRADO' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está cerrada: la recepción ya no puede anularse.', v_po.display_number));
  end if;
  perform private.transition_document(v_doc.id, 'CANCEL', p_reason,
    p_summary => format('Anuló %s con contramovimiento — %s', v_doc.display_number, trim(coalesce(p_reason, ''))));
  for v_line in select * from public.goods_receipt_lines l where l.document_id = v_doc.id order by l.line_no loop
    update public.purchase_order_lines set qty_received = round(qty_received - v_line.quantity, 3) where id = v_line.po_line_id;
    perform private.post_stock_movement(v_doc.company_id, v_line.product_id, v_gr.warehouse_id, 'ANULACION_RECEPCION',
      -v_line.quantity, null, v_doc.id, v_line.id, private.business_date(v_doc.company_id));
  end loop;
  perform private.recompute_purchase_order(v_po.id);
end;
$$;

-- ------------------------------------------------------------------ Ajuste de stock

create function private.confirm_adjustment(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sa public.stock_adjustments;
  v_line public.stock_adjustment_lines;
begin
  perform private.transition_document(p_doc.id, 'CONFIRM');
  select * into v_sa from public.stock_adjustments s where s.document_id = p_doc.id;
  for v_line in select * from public.stock_adjustment_lines l where l.document_id = p_doc.id order by l.line_no loop
    perform private.post_stock_movement(
      p_doc.company_id, v_line.product_id, v_sa.warehouse_id,
      case
        when v_sa.reason_code = 'INVENTARIO_INICIAL' and v_line.quantity_delta > 0 then 'STOCK_INICIAL'
        when v_line.quantity_delta > 0 then 'AJUSTE_POSITIVO'
        else 'AJUSTE_NEGATIVO'
      end,
      v_line.quantity_delta, v_line.unit_cost, p_doc.id, v_line.id, p_doc.document_date
    );
  end loop;
end;
$$;

create function public.sa_create(p_company_id uuid, p_input jsonb, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'stock_adjustment.create');
  v_reason text := coalesce(p_input ->> 'reason_code', '');
  v_warehouse uuid := nullif(p_input ->> 'warehouse_id', '')::uuid;
  v_lines jsonb;
  v_line jsonb;
  v_p public.products;
  v_doc public.documents;
  v_cost numeric;
  v_no int := 0;
  v_total numeric := 0;
begin
  if not exists (select 1 from public.warehouses w where w.company_id = p_company_id and w.id = v_warehouse) then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el depósito.');
  end if;
  if v_reason not in ('INVENTARIO_INICIAL', 'CONTEO_FISICO', 'ROTURA', 'CONSUMO_INTERNO', 'OTRO') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el motivo del ajuste.');
  end if;
  if v_reason = 'OTRO' and length(trim(coalesce(p_input ->> 'notes', ''))) < 3 then
    perform private.raise_business_error('DATO_INVALIDO', 'Explicá el motivo del ajuste.');
  end if;
  select coalesce(jsonb_agg(l), '[]'::jsonb) into v_lines
    from jsonb_array_elements(coalesce(p_input -> 'lines', '[]'::jsonb)) as l
   where nullif(l ->> 'product_id', '') is not null and coalesce((l ->> 'quantity_delta')::numeric, 0) <> 0;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Agregá al menos un producto con una cantidad distinta de cero.');
  end if;
  v_doc := private.new_document(p_company_id, 'STOCK_ADJUSTMENT', v_actor, null, p_input ->> 'notes');
  insert into public.stock_adjustments (document_id, company_id, warehouse_id, reason_code)
  values (v_doc.id, p_company_id, v_warehouse, v_reason);
  for v_line in select * from jsonb_array_elements(v_lines) loop
    v_p := private.product_for(p_company_id, (v_line ->> 'product_id')::uuid);
    if not v_p.is_stockable then
      perform private.raise_business_error('DATO_INVALIDO', format('%s es un servicio: no lleva stock.', v_p.code));
    end if;
    v_cost := case
      when coalesce((v_line ->> 'unit_cost')::numeric, 0) > 0 then (v_line ->> 'unit_cost')::numeric
      else coalesce(
        nullif((select b.avg_unit_cost from public.stock_balances b where b.product_id = v_p.id and b.warehouse_id = v_warehouse), 0),
        v_p.standard_cost)
    end;
    v_no := v_no + 1;
    v_total := v_total + (v_line ->> 'quantity_delta')::numeric * v_cost;
    insert into public.stock_adjustment_lines (company_id, document_id, line_no, product_id, quantity_delta, unit_cost, notes)
    values (p_company_id, v_doc.id, v_no, v_p.id, round((v_line ->> 'quantity_delta')::numeric, 3), round(v_cost, 4),
            coalesce(v_line ->> 'notes', ''));
  end loop;
  update public.documents set subtotal = round(v_total, 2), total = round(v_total, 2) where id = v_doc.id;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'stock_adjustment', v_doc.id, v_doc.display_number,
    format('Creó %s (%s)', v_doc.display_number, private.items_label(v_no)), v_doc.id, null, 'BORRADOR');
  if p_confirm then
    perform private.confirm_adjustment(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.sa_confirm(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.confirm_adjustment(private.get_document(p_document_id, 'STOCK_ADJUSTMENT'));
end;
$$;

create function public.sa_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  perform private.transition_document((private.get_document(p_document_id, 'STOCK_ADJUSTMENT')).id, 'CANCEL', p_reason);
end;
$$;

-- ------------------------------------------------------------------ Tareas y notificaciones

create function public.task_claim(p_task_id uuid, p_claim boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
  v_task public.tasks;
begin
  select * into v_task from public.tasks t
   where t.id = p_task_id and t.company_id in (select private.my_companies())
   for update;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La tarea no existe.');
  end if;
  if v_task.status not in ('PENDIENTE', 'EN_CURSO') then
    perform private.raise_business_error('TRANSICION_INVALIDA', 'La tarea ya está resuelta.');
  end if;
  if p_claim then
    if v_task.claimed_by is not null and v_task.claimed_by <> v_uid then
      perform private.raise_business_error('TAREA_TOMADA', format('La tarea ya la tomó %s.', private.full_name(v_task.claimed_by)));
    end if;
    update public.tasks set claimed_by = v_uid, claimed_at = now(), status = 'EN_CURSO' where id = p_task_id;
  else
    if v_task.claimed_by is distinct from v_uid and not private.is_supervisor(v_task.company_id) then
      perform private.raise_business_error('SIN_PERMISO', 'Sólo quien tomó la tarea (o el docente) puede liberarla.');
    end if;
    update public.tasks set claimed_by = null, claimed_at = null, status = 'PENDIENTE' where id = p_task_id;
  end if;
end;
$$;

-- p_ids null = todas las de la empresa.
create function public.notifications_mark_read(p_company_id uuid, p_ids uuid[] default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
begin
  update public.notifications n set read_at = now()
   where n.recipient_user_id = v_uid and n.company_id = p_company_id and n.read_at is null
     and (p_ids is null or n.id = any (p_ids));
end;
$$;

-- ------------------------------------------------------------------ Permisos de ejecución
do $$
declare
  f text;
begin
  foreach f in array array[
    'pr_create(uuid, jsonb, boolean)', 'pr_update(uuid, jsonb)', 'pr_submit(uuid)', 'pr_reject(uuid, text)',
    'pr_cancel(uuid, text)', 'pr_close(uuid, text)', 'po_create(uuid, jsonb)', 'po_update(uuid, jsonb)',
    'po_submit(uuid)', 'po_approve(uuid, text)', 'po_reject(uuid, text)', 'po_withdraw(uuid)', 'po_reopen(uuid)',
    'po_send(uuid)', 'po_cancel(uuid, text)', 'po_close(uuid, text)', 'gr_create(uuid, jsonb, boolean)',
    'gr_confirm(uuid)', 'gr_cancel(uuid, text)', 'sa_create(uuid, jsonb, boolean)', 'sa_confirm(uuid)',
    'sa_cancel(uuid, text)', 'task_claim(uuid, boolean)', 'notifications_mark_read(uuid, uuid[])'
  ] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
