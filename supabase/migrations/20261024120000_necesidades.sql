-- 45. Fase 5c (docs/FASE_5_PRODUCCION_Y_COSTOS.md §5): las necesidades de
-- materiales de las órdenes planificadas (lo necesario contra lo disponible, lo
-- que está en camino y lo ya pedido a Compras) y la solicitud de compra de los
-- faltantes, vinculada a las órdenes. Traducción de la sección "Necesidades de
-- materiales" de src/lib/mock/engine.ts y de su lectura en queries.ts.
--
-- No cambia el catálogo: pedir los faltantes usa purchase_requisition.create y
-- la solicitud sigue el circuito de compras de siempre.

-- ------------------------------------------------------------------ Necesidades

-- Las necesidades de materiales de las órdenes planificadas (todas, o las de
-- p_docs): por material, lo necesario contra lo disponible en sus depósitos de
-- materiales, lo que está en camino (lo que falta recibir de las órdenes de compra
-- que cubren solicitudes y no terminaron) y lo ya pedido (lo que no está en una
-- orden de compra, de las solicitudes en curso); el faltante es lo que queda sin
-- cubrir (productionNeeds y su vista en queries.ts).
create function private.production_needs(p_company uuid, p_docs uuid[] default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with planned as (
    select d.id, d.number, d.display_number, o.materials_warehouse_id
      from public.documents d
      join public.production_orders o on o.document_id = d.id
     where d.company_id = p_company and d.doc_type = 'PRODUCTION_ORDER' and d.status = 'BORRADOR'
       and (p_docs is null or d.id = any (p_docs))
  ),
  needs as (
    select l.product_id,
           round(sum(l.quantity_planned), 3) as required,
           array_agg(distinct pl.materials_warehouse_id) as warehouses,
           jsonb_agg(jsonb_build_object('id', pl.id, 'display_number', pl.display_number,
                                        'path', private.doc_path(pl.id), 'quantity', l.quantity_planned)
                     order by pl.number) as orders
      from planned pl
      join public.production_order_lines l on l.document_id = pl.id
     group by l.product_id
  ),
  incoming as (
    -- Órdenes de compra: lo que falta recibir, en los depósitos de las órdenes.
    select n.product_id, d.id, d.doc_type, d.number, d.display_number,
           round(sum(pl.quantity - pl.qty_received), 3) as quantity
      from needs n
      join public.purchase_order_lines pl on pl.product_id = n.product_id
      join public.purchase_orders po on po.document_id = pl.document_id
      join public.documents d on d.id = pl.document_id
     where d.company_id = p_company
       and d.status in ('PENDIENTE_APROBACION', 'RECHAZADO', 'APROBADO', 'ENVIADO', 'RECIBIDO_PARCIAL')
       and po.warehouse_id = any (n.warehouses)
     group by n.product_id, d.id
    having round(sum(pl.quantity - pl.qty_received), 3) > 0
    union all
    -- Solicitudes de compra: lo que todavía no está en una orden de compra.
    select n.product_id, d.id, d.doc_type, d.number, d.display_number,
           round(sum(greatest(rl.quantity - rl.qty_ordered, 0)), 3) as quantity
      from needs n
      join public.purchase_requisition_lines rl on rl.product_id = n.product_id
      join public.documents d on d.id = rl.document_id
     where d.company_id = p_company and d.status in ('BORRADOR', 'SOLICITADO', 'ORDENADO_PARCIAL')
     group by n.product_id, d.id
    having round(sum(greatest(rl.quantity - rl.qty_ordered, 0)), 3) > 0
  ),
  rows as (
    select n.*, p.code, p.name, p.uom_code, p.product_type,
           x.on_hand, x.reserved, round(x.on_hand - x.reserved, 3) as available,
           coalesce((select round(sum(i.quantity), 3) from incoming i
                      where i.product_id = n.product_id and i.doc_type = 'PURCHASE_ORDER'), 0) as on_order,
           coalesce((select round(sum(i.quantity), 3) from incoming i
                      where i.product_id = n.product_id and i.doc_type = 'PURCHASE_REQUISITION'), 0) as requested,
           coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'doc_type', i.doc_type,
                                                         'display_number', i.display_number,
                                                         'path', private.doc_path(i.id), 'quantity', i.quantity)
                                      order by i.doc_type collate "C", i.number)
                       from incoming i where i.product_id = n.product_id), '[]') as covered_by
      from needs n
      join public.products p on p.id = n.product_id
      cross join lateral (
        select round(coalesce(sum(private.on_hand_quantity(n.product_id, w)), 0), 3) as on_hand,
               round(coalesce(sum(private.reserved_quantity(n.product_id, w)), 0), 3) as reserved
          from unnest(n.warehouses) as w
      ) as x
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product', jsonb_build_object('id', r.product_id, 'code', r.code, 'name', r.name,
                                         'uom_code', r.uom_code, 'product_type', r.product_type),
           'required', r.required,
           'on_hand', r.on_hand,
           'reserved', r.reserved,
           'available', r.available,
           'on_order', r.on_order,
           'requested', r.requested,
           'shortage', greatest(round(r.required - greatest(r.available, 0) - r.on_order - r.requested, 3), 0),
           'orders', r.orders,
           'covered_by', r.covered_by)
         order by r.code collate "C"), '[]')
    from rows r
$$;

create function public.production_needs(p_company_id uuid, p_document_ids uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'production_order.read');
  return private.production_needs(p_company_id, p_document_ids);
end;
$$;

-- ------------------------------------------------------------------ Pedir los faltantes

-- Genera una solicitud de compra en borrador con los faltantes de las órdenes
-- planificadas elegidas, vinculada a cada una (cmdRequestProductionMaterials).
create function public.opr_request_materials(p_company_id uuid, p_document_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'purchase_requisition.create');
  v_doc public.documents;
  v_planned text;
  v_needs jsonb;
  v_lines jsonb;
  v_orders uuid[];
  v_numbers text;
  v_needed date;
  v_id uuid;
begin
  perform private.require_permission(p_company_id, 'production_order.read');
  if coalesce(cardinality(p_document_ids), 0) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí al menos una orden de producción.');
  end if;
  foreach v_id in array p_document_ids loop
    v_doc := private.get_document(v_id, 'PRODUCTION_ORDER');
    if v_doc.company_id <> p_company_id then
      perform private.raise_business_error('DOCUMENTO_INEXISTENTE', 'El documento no existe.');
    end if;
    if v_doc.status <> 'BORRADOR' then
      perform private.raise_business_error('TRANSICION_INVALIDA',
        format('%s no está planificada: sólo se piden los materiales de las órdenes que todavía no se liberaron.',
               v_doc.display_number));
    end if;
  end loop;
  v_needs := private.production_needs(p_company_id, p_document_ids);
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', n -> 'product' ->> 'id',
           'quantity', (n ->> 'shortage')::numeric,
           'notes', 'Para ' || (select string_agg(o.value ->> 'display_number', ', ' order by o.ord)
                                  from jsonb_array_elements(n -> 'orders') with ordinality as o (value, ord)))
         order by n -> 'product' ->> 'code' collate "C"), '[]')
    into v_lines
    from jsonb_array_elements(v_needs) as n
   where (n ->> 'shortage')::numeric > 0;
  if jsonb_array_length(v_lines) = 0 then
    select string_agg(d.display_number, ', ' order by d.number) into v_planned
      from public.documents d where d.id = any (p_document_ids);
    perform private.raise_business_error('DATO_INVALIDO',
      format('No falta nada que no esté pedido para %s: alcanza con lo disponible, lo que está en camino y lo ya pedido a Compras.', v_planned),
      'Cuando llegue lo pedido, la orden se puede liberar.');
  end if;
  -- Las órdenes que necesitan algún faltante.
  select array_agg(distinct (o ->> 'id')::uuid) into v_orders
    from jsonb_array_elements(v_needs) as n, jsonb_array_elements(n -> 'orders') as o
   where (n ->> 'shortage')::numeric > 0;
  select string_agg(d.display_number, ', ' order by d.number), min(o.due_date) filter (where o.due_date >= private.business_date(p_company_id))
    into v_numbers, v_needed
    from public.documents d join public.production_orders o on o.document_id = d.id
   where d.id = any (v_orders);
  v_doc := private.new_document(p_company_id, 'PURCHASE_REQUISITION', v_actor, null, '');
  perform private.write_requisition(v_doc, jsonb_build_object(
    'needed_by', v_needed, 'priority', 'ALTA',
    'reason', format('Materiales que faltan para las órdenes de producción %s.', v_numbers)), v_lines);
  foreach v_id in array v_orders loop
    perform private.link_documents(p_company_id, v_id, v_doc.id);
  end loop;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'purchase_requisition', v_doc.id, v_doc.display_number,
    format('Creó %s con los faltantes de %s (%s)', v_doc.display_number, v_numbers,
           private.items_label(jsonb_array_length(v_lines))), v_doc.id, null, 'BORRADOR');
  return private.created_result(v_doc.id);
end;
$$;

grant execute on function public.production_needs(uuid, uuid[]) to authenticated;
grant execute on function public.opr_request_materials(uuid, uuid[]) to authenticated;
