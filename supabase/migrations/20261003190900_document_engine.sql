-- 10. Motor de documentos (esquema private): numeración, transiciones con
-- tareas, notificaciones y auditoría, stock con PPP y recálculos derivados.
-- Traducción directa de src/lib/mock/engine.ts: transition, openTasksForStatus,
-- postMovement, raiseStockAlert, recomputeRequisition, recomputePurchaseOrder.

-- ------------------------------------------------------------------ Formatos es-AR
-- Para los textos que leen los estudiantes: $ 1.234,56 · 1.234,5 UN. Igual que
-- money() de src/lib/format.ts (Intl es-AR): espacio duro después del signo.
create function private.format_money(p numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when round(coalesce(p, 0), 2) < 0 then '-' else '' end || '$' || chr(160)
         || translate(to_char(abs(round(coalesce(p, 0), 2)), 'FM999,999,999,990.00'), ',.', '.,')
$$;

create function private.format_qty(p numeric, p_uom text default null)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(rtrim(to_char(round(coalesce(p, 0), 3), 'FM999,999,999,990.999'), '.'), ',.', '.,')
         || coalesce(' ' || p_uom, '')
$$;

-- Fecha de negocio: la simulada de la empresa o hoy en la zona horaria de la escuela.
create function private.business_date(p_company uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    c.simulation_date,
    (now() at time zone coalesce((select s.timezone from public.school_settings s where s.id = 1), 'America/Argentina/Buenos_Aires'))::date
  )
    from public.companies c where c.id = p_company
$$;

-- ------------------------------------------------------------------ Documentos

-- Numeración sin huecos: la fila de la secuencia queda bloqueada hasta el final de la transacción.
create function private.next_document_number(p_company uuid, p_doc_type text, out number int, out display_number text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.document_sequences (company_id, doc_type) values (p_company, p_doc_type) on conflict do nothing;
  update public.document_sequences s set next_number = s.next_number + 1
   where s.company_id = p_company and s.doc_type = p_doc_type
  returning s.next_number - 1 into number;
  select dt.prefix || '-' || lpad(number::text, 5, '0') into display_number
    from public.document_types dt where dt.code = p_doc_type;
end;
$$;

create function private.new_document(
  p_company uuid,
  p_doc_type text,
  p_actor private.actor,
  p_supplier uuid default null,
  p_notes text default ''
)
returns public.documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number record;
  v_doc public.documents;
begin
  select * into v_number from private.next_document_number(p_company, p_doc_type);
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, supplier_id, notes, created_by)
  values (p_company, p_doc_type, v_number.number, v_number.display_number, 'BORRADOR', private.business_date(p_company),
          (p_actor).sector_id, p_supplier, coalesce(p_notes, ''), (p_actor).user_id)
  returning * into v_doc;
  return v_doc;
end;
$$;

-- Documento de un tipo dado, bloqueado para el resto de la transacción.
create function private.get_document(p_document uuid, p_doc_type text)
returns public.documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  select * into v_doc from public.documents d where d.id = p_document and d.doc_type = p_doc_type for update;
  if not found then
    perform private.raise_business_error('DOCUMENTO_INEXISTENTE', 'El documento no existe.');
  end if;
  return v_doc;
end;
$$;

-- Ruta de la interfaz al documento: /e/<empresa>/compras/ordenes/OC-00023
create function private.doc_path(p_document uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select '/e/' || c.slug || '/' || dt.path || '/' || d.display_number
    from public.documents d
    join public.companies c on c.id = d.company_id
    join public.document_types dt on dt.code = d.doc_type
   where d.id = p_document
$$;

create function private.status_label(p_doc_type text, p_status text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.label from public.document_statuses s where s.doc_type = p_doc_type and s.code = p_status), p_status)
$$;

create function private.link_documents(p_company uuid, p_from uuid, p_to uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.document_links (company_id, from_document_id, to_document_id)
  values (p_company, p_from, p_to)
  on conflict do nothing
$$;

-- ------------------------------------------------------------------ Notificaciones y tareas

create function private.users_with_role(p_company uuid, p_role text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.user_id
    from public.company_members m
    join public.member_roles mr on mr.company_id = m.company_id and mr.member_id = m.id
    join public.profiles p on p.id = m.user_id and p.is_active
   where m.company_id = p_company and m.is_active and mr.role_code = p_role
$$;

create function private.notify_users(
  p_company uuid,
  p_users uuid[],
  p_type text,
  p_title text,
  p_body text,
  p_link text,
  p_document uuid default null,
  p_task uuid default null,
  p_exclude uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (company_id, recipient_user_id, type, title, body, link_path, document_id, task_id)
  select p_company, u, p_type, p_title, coalesce(p_body, ''), coalesce(p_link, ''), p_document, p_task
    from (select distinct unnest(p_users) as u) as recipients
   where u is not null and u is distinct from p_exclude
$$;

create function private.notify_roles(
  p_company uuid,
  p_roles text[],
  p_type text,
  p_title text,
  p_body text,
  p_link text,
  p_document uuid default null,
  p_task uuid default null,
  p_exclude uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.notify_users(
    p_company,
    array(select u from unnest(p_roles) as r, lateral private.users_with_role(p_company, r) as u),
    p_type, p_title, p_body, p_link, p_document, p_task, p_exclude
  )
$$;

-- Al entrar en un estado se abren las tareas de su regla (catálogo task_rules).
create function private.open_tasks_for_status(p_document uuid, p_actor private.actor)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_rule public.task_rules;
  v_role text;
  v_user uuid;
  v_title text;
  v_task uuid;
  v_priority text;
begin
  select * into v_doc from public.documents d where d.id = p_document;
  select coalesce((select pr.priority from public.purchase_requisitions pr where pr.document_id = v_doc.id), 'NORMAL')
    into v_priority;
  for v_rule in
    select * from public.task_rules tr where tr.doc_type = v_doc.doc_type and tr.status = v_doc.status order by tr.task_type
  loop
    v_role := null;
    v_user := null;
    if v_rule.assignee_kind = 'ROLE' then
      v_role := v_rule.role_code;
    elsif v_rule.assignee_kind = 'APPROVER' then
      v_role := coalesce(
        (select ar.approver_role from public.approval_requests ar where ar.document_id = v_doc.id and ar.status = 'PENDIENTE'),
        'GERENCIA'
      );
    else
      v_user := v_doc.created_by;
    end if;
    v_title := replace(replace(v_rule.title_template, '{number}', v_doc.display_number), '{total}', private.format_money(v_doc.total));
    insert into public.tasks (company_id, document_id, task_type, title, description, origin_status, assigned_role,
                              assigned_user_id, priority, created_by)
    values (v_doc.company_id, v_doc.id, v_rule.task_type, v_title, v_rule.description, v_doc.status, v_role,
            v_user, v_priority, (p_actor).user_id)
    returning id into v_task;
    perform private.notify_users(
      v_doc.company_id,
      case
        when v_user is not null then array[v_user]
        when v_role is not null then array(select private.users_with_role(v_doc.company_id, v_role))
        else '{}'::uuid[]
      end,
      'NUEVA_TAREA', 'Nueva tarea: ' || v_title, v_rule.description, private.doc_path(v_doc.id), v_doc.id, v_task,
      (p_actor).user_id
    );
  end loop;
end;
$$;

create function private.close_tasks_for_status(p_document uuid, p_origin_status text, p_by uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.tasks t set status = 'RESUELTA', completed_by = p_by, completed_at = now()
   where t.document_id = p_document and t.origin_status = p_origin_status and t.status in ('PENDIENTE', 'EN_CURSO')
$$;

-- ------------------------------------------------------------------ Transición (única puerta)
-- Valida contra el catálogo, exige el permiso de la transición (salvo SYSTEM),
-- cambia el estado, cierra y abre tareas y deja la auditoría con usuario, rol,
-- sector y estados (DATABASE.md §11.3, ARCHITECTURE.md §7.3).
create function private.transition_document(
  p_document uuid,
  p_action text,
  p_comment text default null,
  p_to text default null,
  p_actor private.actor default null,
  p_summary text default null
)
returns private.actor
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_tr public.document_transitions;
  v_actor private.actor;
  v_comment text := trim(coalesce(p_comment, ''));
  v_summary text;
begin
  select * into v_doc from public.documents d where d.id = p_document for update;
  if not found then
    perform private.raise_business_error('DOCUMENTO_INEXISTENTE', 'El documento no existe.');
  end if;
  select * into v_tr from public.document_transitions t
   where t.doc_type = v_doc.doc_type and t.from_status = v_doc.status and t.action = p_action
     and (p_to is null or t.to_status = p_to)
   limit 1;
  if not found then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s está en estado "%s" y no admite esta acción.', v_doc.display_number, private.status_label(v_doc.doc_type, v_doc.status)));
  end if;
  if v_tr.requires_comment and length(v_comment) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo: queda registrado en el historial del documento.');
  end if;
  if (p_actor).name is not null then
    v_actor := p_actor;
  elsif v_tr.permission_code is not null then
    v_actor := private.require_permission(v_doc.company_id, v_tr.permission_code);
  else
    v_actor := row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor;
  end if;

  update public.documents d
     set status = v_tr.to_status,
         status_reason = case when v_comment <> '' and p_action in ('REJECT', 'CANCEL', 'CLOSE') then v_comment else d.status_reason end
   where d.id = v_doc.id;
  perform private.close_tasks_for_status(v_doc.id, v_doc.status, (v_actor).user_id);
  perform private.open_tasks_for_status(v_doc.id, v_actor);

  v_summary := coalesce(p_summary, case
    when p_action = 'SYSTEM' then format('%s pasó a "%s"', v_doc.display_number, private.status_label(v_doc.doc_type, v_tr.to_status))
    else format('%s %s%s', (select a.verb from public.audit_actions a where a.code = p_action), v_doc.display_number,
                case when v_comment <> '' then ' — ' || v_comment else '' end)
  end);
  perform private.log_audit(
    v_doc.company_id, v_actor, p_action, (select dt.resource from public.document_types dt where dt.code = v_doc.doc_type),
    v_doc.id, v_doc.display_number, v_summary, v_doc.id, v_doc.status, v_tr.to_status
  );
  return v_actor;
end;
$$;

-- ------------------------------------------------------------------ Stock

create function private.total_stock(p_product uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$ select coalesce(sum(b.qty_on_hand), 0) from public.stock_balances b where b.product_id = p_product $$;

create function private.resolve_stock_tasks(p_product uuid, p_by uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.tasks t set status = 'RESUELTA', completed_by = p_by, completed_at = now()
   where t.task_type = 'REPONER_STOCK' and t.context ->> 'product_id' = p_product::text and t.status in ('PENDIENTE', 'EN_CURSO')
$$;

-- Alerta de stock mínimo: una tarea abierta por producto, aviso a Depósito y Compras.
create function private.raise_stock_alert(p_product uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.products;
  v_stock numeric;
  v_task uuid;
  v_label text;
begin
  select * into v_p from public.products p where p.id = p_product;
  if exists (
    select 1 from public.tasks t
     where t.task_type = 'REPONER_STOCK' and t.context ->> 'product_id' = p_product::text and t.status in ('PENDIENTE', 'EN_CURSO')
  ) then
    return;
  end if;
  v_stock := private.total_stock(p_product);
  v_label := v_p.code || ' ' || v_p.name;
  insert into public.tasks (company_id, task_type, title, description, context, assigned_role, priority)
  values (
    v_p.company_id, 'REPONER_STOCK', 'Evaluar reposición de ' || v_label,
    format('Stock %s, por debajo del mínimo (%s). Evaluá crear una solicitud de compra.',
           private.format_qty(v_stock, v_p.uom_code), private.format_qty(v_p.min_stock, v_p.uom_code)),
    jsonb_build_object('product_id', p_product), 'DEPOSITO', 'ALTA'
  )
  returning id into v_task;
  perform private.notify_roles(
    v_p.company_id, array['DEPOSITO', 'COMPRAS'], 'STOCK_MINIMO', 'Stock mínimo alcanzado: ' || v_p.code,
    format('%s: %s (mínimo %s).', v_p.name, private.format_qty(v_stock, v_p.uom_code), private.format_qty(v_p.min_stock, v_p.uom_code)),
    '/e/' || (select c.slug from public.companies c where c.id = v_p.company_id) || '/stock', null, v_task
  );
  perform private.log_audit(
    v_p.company_id, row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor, 'ALERT', 'product', v_p.id, v_label,
    format('Alerta de stock mínimo: %s (%s)', v_label, private.format_qty(v_stock, v_p.uom_code))
  );
end;
$$;

-- Genera alertas para todo producto que ya esté bajo el mínimo (datos iniciales).
create function private.scan_stock_alerts(p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product uuid;
begin
  for v_product in
    select p.id from public.products p
     where p.company_id = p_company and p.is_stockable and p.min_stock > 0 and private.total_stock(p.id) < p.min_stock
     order by p.code
  loop
    perform private.raise_stock_alert(v_product);
  end loop;
end;
$$;

-- Kardex: cada movimiento actualiza el saldo y el costo promedio ponderado.
-- Entradas: nuevo PPP = (saldo × PPP + cantidad × costo) / (saldo + cantidad).
-- Salidas: se valúan al PPP vigente. Sin stock negativo, salvo que la empresa lo habilite.
create function private.post_stock_movement(
  p_company uuid,
  p_product uuid,
  p_warehouse uuid,
  p_type text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_document uuid,
  p_line uuid,
  p_date date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.products;
  v_bal public.stock_balances;
  v_before numeric;
  v_after numeric;
  v_new numeric;
  v_cost numeric;
  v_avg numeric;
begin
  select * into v_p from public.products p where p.company_id = p_company and p.id = p_product;
  if not found then
    perform private.raise_business_error('PRODUCTO_INEXISTENTE', 'El producto no existe en esta empresa.');
  end if;
  if not v_p.is_stockable then
    return;
  end if;
  insert into public.stock_balances (company_id, product_id, warehouse_id)
  values (p_company, p_product, p_warehouse)
  on conflict (product_id, warehouse_id) do nothing;
  select * into v_bal from public.stock_balances b where b.product_id = p_product and b.warehouse_id = p_warehouse for update;
  v_before := private.total_stock(p_product);
  v_new := round(v_bal.qty_on_hand + p_quantity, 3);
  if v_new < 0 and not coalesce((select (c.settings ->> 'allow_negative_stock')::boolean from public.companies c where c.id = p_company), false) then
    perform private.raise_business_error(
      'STOCK_INSUFICIENTE',
      format('Stock insuficiente de %s %s: hay %s en %s.', v_p.code, v_p.name, private.format_qty(v_bal.qty_on_hand, v_p.uom_code),
             coalesce((select w.name from public.warehouses w where w.id = p_warehouse), 'el depósito')),
      'El sistema no permite stock negativo: no se puede sacar lo que no está.'
    );
  end if;
  if p_quantity > 0 then
    v_cost := coalesce(p_unit_cost, nullif(v_bal.avg_unit_cost, 0), v_p.standard_cost);
    v_avg := case when v_new > 0 then round((v_bal.qty_on_hand * v_bal.avg_unit_cost + p_quantity * v_cost) / v_new, 4) else v_cost end;
  else
    v_cost := coalesce(nullif(v_bal.avg_unit_cost, 0), v_p.standard_cost);
    v_avg := v_bal.avg_unit_cost;
  end if;
  update public.stock_balances b set qty_on_hand = v_new, avg_unit_cost = v_avg, last_movement_at = now()
   where b.product_id = p_product and b.warehouse_id = p_warehouse;
  insert into public.stock_movements (company_id, product_id, warehouse_id, movement_type, quantity, unit_cost, total_cost,
                                      balance_qty, balance_avg_cost, document_id, document_line_id, movement_date, created_by)
  values (p_company, p_product, p_warehouse, p_type, p_quantity, round(v_cost, 4), round(p_quantity * v_cost, 2),
          v_new, v_avg, p_document, p_line, p_date, (select auth.uid()));
  v_after := private.total_stock(p_product);
  if v_p.min_stock > 0 then
    if v_after < v_p.min_stock and v_before >= v_p.min_stock then
      perform private.raise_stock_alert(p_product);
    end if;
    if v_after >= v_p.min_stock then
      perform private.resolve_stock_tasks(p_product, (select auth.uid()));
    end if;
  end if;
end;
$$;

-- ------------------------------------------------------------------ Recálculos derivados

create function private.requisitions_of_order(p_order uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct rl.document_id
    from public.purchase_order_lines pl
    join public.purchase_requisition_lines rl on rl.id = pl.requisition_line_id
   where pl.document_id = p_order
$$;

-- Una OC en borrador todavía no compromete a la empresa: no cuenta como "ya ordenado".
create function private.recompute_requisition(p_requisition uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_full boolean;
  v_some boolean;
  v_target text;
begin
  update public.purchase_requisition_lines rl
     set qty_ordered = coalesce((
       select sum(pl.quantity)
         from public.purchase_order_lines pl
         join public.documents d on d.id = pl.document_id
        where pl.requisition_line_id = rl.id and d.status not in ('ANULADO', 'BORRADOR')
     ), 0)
   where rl.document_id = p_requisition;
  select d.status into v_status from public.documents d where d.id = p_requisition;
  if v_status not in ('SOLICITADO', 'ORDENADO_PARCIAL', 'ORDENADO') then
    return;
  end if;
  select bool_and(rl.qty_ordered >= rl.quantity), bool_or(rl.qty_ordered > 0) into v_full, v_some
    from public.purchase_requisition_lines rl where rl.document_id = p_requisition;
  v_target := case when v_full then 'ORDENADO' when v_some then 'ORDENADO_PARCIAL' else 'SOLICITADO' end;
  if v_target <> v_status then
    perform private.transition_document(p_requisition, 'SYSTEM', null, v_target);
  end if;
end;
$$;

create function private.recompute_purchase_order(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_full boolean;
  v_some boolean;
  v_target text;
begin
  select d.status into v_status from public.documents d where d.id = p_order;
  if v_status not in ('ENVIADO', 'RECIBIDO_PARCIAL', 'RECIBIDO') then
    return;
  end if;
  select bool_and(pl.qty_received >= pl.quantity), bool_or(pl.qty_received > 0) into v_full, v_some
    from public.purchase_order_lines pl where pl.document_id = p_order;
  v_target := case when v_full then 'RECIBIDO' when v_some then 'RECIBIDO_PARCIAL' else 'ENVIADO' end;
  if v_target <> v_status then
    perform private.transition_document(p_order, 'SYSTEM', null, v_target);
  end if;
end;
$$;

-- Vínculos SC → OC según las líneas actuales, y recálculo de las solicitudes afectadas.
create function private.sync_order_links(p_order uuid, p_previous uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company uuid;
  v_current uuid[] := array(select private.requisitions_of_order(p_order));
  v_requisition uuid;
begin
  select d.company_id into v_company from public.documents d where d.id = p_order;
  delete from public.document_links l where l.to_document_id = p_order and not (l.from_document_id = any (v_current));
  foreach v_requisition in array v_current loop
    perform private.link_documents(v_company, v_requisition, p_order);
  end loop;
  for v_requisition in select distinct x from unnest(coalesce(p_previous, '{}') || v_current) as x loop
    perform private.recompute_requisition(v_requisition);
  end loop;
end;
$$;
