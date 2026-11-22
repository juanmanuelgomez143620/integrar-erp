-- 122. Fase 9c.1 (docs/FASE_9_LA_EMPRESA_CRECE.md): las zonas de reparto. Las mantiene Logística (los
-- permisos del transporte: carrier.create y carrier.update), con sus días de reparto; se desactivan, no
-- se borran. Cada cliente puede estar en una, que Ventas elige en su ficha; los remitos para repartir
-- dicen la zona de su cliente y la empresa nueva copia las zonas de la plantilla. Traducción de "Zonas de
-- reparto" de src/lib/mock/engine.ts y de sus lecturas en queries.ts.
--
-- Las zonas de la demo están en la migración de la plantilla siguiente; la plantilla que ya existía las
-- recibe en la última de esta fase.

-- ------------------------------------------------------------------ Tablas

-- Zona de reparto: los días en que sale el reparto, de lunes (1) a sábado (6), en orden y sin repetirse.
create table public.delivery_zones (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  name text not null check (length(name) between 2 and 60),
  delivery_days smallint[] not null
    check (cardinality(delivery_days) between 1 and 6 and delivery_days <@ array[1, 2, 3, 4, 5, 6]::smallint[]),
  notes text not null default '' check (length(notes) <= 200),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id)
);

create trigger delivery_zones_audit before insert or update on public.delivery_zones
  for each row execute function private.set_audit_fields();
alter table public.delivery_zones enable row level security;
revoke all on table public.delivery_zones from anon, authenticated;
grant select on table public.delivery_zones to authenticated;
create trigger delivery_zones_same_company before update on public.delivery_zones
  for each row execute function private.prevent_company_change();
-- Las ve quien ve el transporte (Logística) o los clientes (Ventas, que elige la de cada uno).
create policy delivery_zones_select on public.delivery_zones for select to authenticated
  using (company_id in (select private.companies_with_permission('carrier.read'))
         or company_id in (select private.companies_with_permission('customer.read')));

-- La zona de reparto del cliente: de su misma empresa.
alter table public.customers add column zone_id uuid;
alter table public.customers add constraint customers_zone_fkey
  foreign key (company_id, zone_id) references public.delivery_zones (company_id, id);

-- ------------------------------------------------------------------ Auxiliares

-- "Z-ELD Eldorado y Alto Paraná" (deliveryZoneLabel).
create function private.delivery_zone_label(p_zone public.delivery_zones)
returns text
language sql
immutable
set search_path = ''
as $$ select p_zone.code || ' ' || p_zone.name $$;

-- "lunes, miércoles y viernes": los días de reparto (weekdaysLabel).
create function private.weekdays_label(p_days smallint[])
returns text
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(cardinality(x.l), 0) = 0 then ''
              when cardinality(x.l) = 1 then x.l[1]
              else array_to_string(x.l[1:cardinality(x.l) - 1], ', ') || ' y ' || x.l[cardinality(x.l)] end
    from (select array_agg(n.label order by n.day) as l
            from (values (1, 'lunes'), (2, 'martes'), (3, 'miércoles'), (4, 'jueves'), (5, 'viernes'), (6, 'sábado'))
                 as n (day, label)
           where n.day = any (p_days)) as x
$$;

-- ------------------------------------------------------------------ Comandos

-- Logística da de alta o modifica una zona de reparto, con sus días (cmdSaveDeliveryZone).
-- p_input: {id ('' si es nueva), code, name, delivery_days: [1..6], notes}
create function public.delivery_zone_save(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := coalesce(p_input ->> 'id', '');
  v_actor private.actor := private.require_permission(p_company_id,
                             case when v_id <> '' then 'carrier.update' else 'carrier.create' end);
  v_existing public.delivery_zones;
  v_code text := upper(trim(coalesce(p_input ->> 'code', '')));
  v_name text := trim(coalesce(p_input ->> 'name', ''));
  v_raw jsonb := p_input -> 'delivery_days';
  v_days smallint[];
  v_notes text := trim(coalesce(p_input ->> 'notes', ''));
  v_zone public.delivery_zones;
  v_changes jsonb;
begin
  if v_id <> '' then
    select * into v_existing from public.delivery_zones z where z.id::text = v_id and z.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'La zona de reparto no existe.');
    end if;
  end if;
  if v_code !~ '^[A-Z0-9-]{1,12}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El código de la zona tiene de 1 a 12 letras, números o guiones.');
  end if;
  if exists (select 1 from public.delivery_zones z
              where z.company_id = p_company_id and z.code = v_code and z.id is distinct from v_existing.id) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe una zona de reparto con el código %s.', v_code));
  end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'El nombre de la zona tiene de 2 a 60 caracteres.');
  end if;
  if v_raw is null or jsonb_typeof(v_raw) <> 'array' or jsonb_array_length(v_raw) = 0
     or exists (select 1 from jsonb_array_elements(v_raw) as e (d)
                 where jsonb_typeof(e.d) <> 'number' or (e.d #>> '{}')::numeric <> trunc((e.d #>> '{}')::numeric)
                    or (e.d #>> '{}')::numeric not between 1 and 6) then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí al menos un día de reparto, de lunes a sábado.');
  end if;
  v_days := array(select distinct (e.d #>> '{}')::smallint from jsonb_array_elements(v_raw) as e (d) order by 1);
  if length(v_notes) > 200 then
    perform private.raise_business_error('DATO_INVALIDO', 'La nota de la zona tiene hasta 200 caracteres.');
  end if;
  if v_existing.id is not null then
    v_changes := private.diff(to_jsonb(v_existing),
      to_jsonb(v_existing) || jsonb_build_object('code', v_code, 'name', v_name, 'delivery_days', to_jsonb(v_days),
                                                 'notes', v_notes),
      array['code', 'name', 'delivery_days', 'notes']);
    if v_changes = '{}'::jsonb then
      return jsonb_build_object('id', v_existing.id);
    end if;
    update public.delivery_zones
       set code = v_code, name = v_name, delivery_days = v_days, notes = v_notes
     where id = v_existing.id
    returning * into v_zone;
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'delivery_zone', v_zone.id,
      private.delivery_zone_label(v_zone),
      format('Modificó la zona de reparto %s', private.delivery_zone_label(v_zone)), null, null, null, v_changes);
    return jsonb_build_object('id', v_zone.id);
  end if;
  insert into public.delivery_zones (company_id, code, name, delivery_days, notes)
  values (p_company_id, v_code, v_name, v_days, v_notes)
  returning * into v_zone;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'delivery_zone', v_zone.id, private.delivery_zone_label(v_zone),
    format('Dio de alta la zona de reparto %s: %s', private.delivery_zone_label(v_zone), private.weekdays_label(v_days)));
  return jsonb_build_object('id', v_zone.id);
end;
$$;

-- Una zona desactivada no se asigna a clientes nuevos; los que la tienen la conservan
-- (cmdSetDeliveryZoneActive).
create function public.delivery_zone_set_active(p_company_id uuid, p_zone_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'carrier.update');
  v_zone public.delivery_zones;
begin
  select * into v_zone from public.delivery_zones z where z.id = p_zone_id and z.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La zona de reparto no existe.');
  end if;
  if p_active is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si la zona está activa.');
  end if;
  if v_zone.is_active = p_active then
    return;
  end if;
  update public.delivery_zones set is_active = p_active where id = v_zone.id;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end,
    'delivery_zone', v_zone.id, private.delivery_zone_label(v_zone),
    format('%s la zona de reparto %s', case when p_active then 'Activó' else 'Desactivó' end,
           private.delivery_zone_label(v_zone)));
end;
$$;

grant execute on function public.delivery_zone_save(uuid, jsonb) to authenticated;
grant execute on function public.delivery_zone_set_active(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- Las zonas de reparto, por código, con cuántos clientes activos tiene cada una (listDeliveryZones):
-- las ve quien ve el transporte o los clientes.
create function public.delivery_zones_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id,
    case when private.has_permission(p_company_id, 'carrier.read') then 'carrier.read' else 'customer.read' end);
  return coalesce((
    select jsonb_agg(to_jsonb(z) || jsonb_build_object(
             'customers', (select count(*) from public.customers c where c.zone_id = z.id and c.is_active))
           order by z.code collate "C")
      from public.delivery_zones z where z.company_id = p_company_id
  ), '[]');
end;
$$;

grant execute on function public.delivery_zones_list(uuid) to authenticated;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, y además la zona de reparto del cliente (masterData, Fase 9c.1).
create or replace function public.master_save(p_kind text, p_company_id uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_data ->> 'id', '')::uuid;
  v_code text := upper(trim(coalesce(p_data ->> 'code', '')));
  v_table text;
  v_label text;
  v_name_field text;
  v_keys text[];
  v_actor private.actor;
  v_data jsonb;
  v_exists boolean;
  v_before jsonb;
  v_after jsonb;
  v_columns text;
  v_entity text;
begin
  case p_kind
    when 'customer' then
      v_table := 'customers'; v_label := 'cliente'; v_name_field := 'legal_name';
      v_keys := array['legal_name', 'trade_name', 'tax_id', 'vat_condition', 'address_line', 'city', 'province',
                      'phone', 'email', 'contact_name', 'payment_terms_days', 'credit_limit', 'price_list_id', 'zone_id',
                      'notes'];
    when 'supplier' then
      v_table := 'suppliers'; v_label := 'proveedor'; v_name_field := 'legal_name';
      v_keys := array['legal_name', 'trade_name', 'tax_id', 'vat_condition', 'address_line', 'city', 'province',
                      'phone', 'email', 'contact_name', 'payment_terms_days', 'lead_time_days', 'category', 'notes'];
    when 'product' then
      v_table := 'products'; v_label := 'producto'; v_name_field := 'name';
      v_keys := array['name', 'description', 'category', 'product_type', 'uom_code', 'standard_cost', 'sale_price',
                      'vat_rate', 'min_stock', 'reorder_qty', 'default_supplier_id', 'default_warehouse_id', 'location'];
    else
      perform private.raise_business_error('DATO_INVALIDO', 'Tipo de maestro desconocido.');
  end case;

  v_actor := private.require_permission(p_company_id, p_kind || '.' || case when v_id is null then 'create' else 'update' end);

  if v_code = '' then
    perform private.raise_business_error('DATO_INVALIDO', 'Ingresá el código.');
  end if;
  execute format('select exists (select 1 from public.%I where company_id = $1 and code = $2 and id is distinct from $3)', v_table)
     into v_exists using p_company_id, v_code, v_id;
  if v_exists then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe un %s con el código %s.', v_label, v_code));
  end if;
  if length(trim(coalesce(p_data ->> v_name_field, ''))) < 2 then
    perform private.raise_business_error('DATO_INVALIDO',
      case when p_kind = 'product' then 'Ingresá la descripción del producto.' else 'Ingresá la razón social.' end);
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_data
    from jsonb_each(p_data) where key = any (v_keys);
  v_data := v_data || jsonb_build_object('code', v_code);

  if p_kind = 'product' then
    if v_id is null and coalesce(v_data ->> 'product_type', '') = '' then
      perform private.raise_business_error('DATO_INVALIDO', 'Elegí el tipo de producto.');
    end if;
    if v_data ? 'product_type' then
      v_data := v_data || jsonb_build_object('is_stockable', v_data ->> 'product_type' <> 'SERVICIO');
    end if;
    if nullif(v_data ->> 'default_supplier_id', '') is not null and not exists (
      select 1 from public.suppliers s where s.company_id = p_company_id and s.id = (v_data ->> 'default_supplier_id')::uuid
    ) then
      perform private.raise_business_error('DATO_INVALIDO', 'El proveedor habitual no existe en esta empresa.');
    end if;
    if nullif(v_data ->> 'default_warehouse_id', '') is not null and not exists (
      select 1 from public.warehouses w where w.company_id = p_company_id and w.id = (v_data ->> 'default_warehouse_id')::uuid
    ) then
      perform private.raise_business_error('DATO_INVALIDO', 'El depósito habitual no existe en esta empresa.');
    end if;
    -- "" en un id opcional significa "sin proveedor/depósito".
    v_data := v_data
      || case when v_data ? 'default_supplier_id' and v_data ->> 'default_supplier_id' = '' then '{"default_supplier_id": null}'::jsonb else '{}' end
      || case when v_data ? 'default_warehouse_id' and v_data ->> 'default_warehouse_id' = '' then '{"default_warehouse_id": null}'::jsonb else '{}' end;
  end if;

  if p_kind = 'customer' then
    -- "" en la lista de precios es "sin lista"; una desactivada no se asigna (salvo que el cliente ya la tuviera).
    if nullif(v_data ->> 'price_list_id', '') is not null and not exists (
      select 1 from public.price_lists l
       where l.company_id = p_company_id and l.id::text = v_data ->> 'price_list_id'
         and (l.is_active or l.id is not distinct from (select c.price_list_id from public.customers c where c.id = v_id))
    ) then
      perform private.raise_business_error('DATO_INVALIDO', 'La lista de precios debe estar activa y pertenecer a esta empresa.');
    end if;
    v_data := v_data
      || case when v_data ? 'price_list_id' and coalesce(v_data ->> 'price_list_id', '') = '' then '{"price_list_id": null}'::jsonb else '{}' end;
    -- Lo mismo con la zona de reparto (Fase 9c.1): "" es "sin zona".
    if nullif(v_data ->> 'zone_id', '') is not null and not exists (
      select 1 from public.delivery_zones z
       where z.company_id = p_company_id and z.id::text = v_data ->> 'zone_id'
         and (z.is_active or z.id is not distinct from (select c.zone_id from public.customers c where c.id = v_id))
    ) then
      perform private.raise_business_error('DATO_INVALIDO', 'La zona de reparto debe estar activa y pertenecer a esta empresa.');
    end if;
    v_data := v_data
      || case when v_data ? 'zone_id' and coalesce(v_data ->> 'zone_id', '') = '' then '{"zone_id": null}'::jsonb else '{}' end;
  end if;

  select string_agg(quote_ident(k), ', ') into v_columns from jsonb_object_keys(v_data) as k;

  if v_id is null then
    execute format(
      'insert into public.%1$I (company_id, %2$s) select $1, %2$s from jsonb_populate_record(null::public.%1$I, $2) returning id, to_jsonb(%1$I)',
      v_table, v_columns
    ) into v_id, v_after using p_company_id, v_data;
    v_entity := (v_after ->> 'code') || ' ' || (v_after ->> v_name_field);
    perform private.log_audit(p_company_id, v_actor, 'CREATE', p_kind, v_id, v_entity,
      format('Dio de alta el %s %s', v_label, v_entity));
    return v_id;
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.company_id = $2 for update', v_table)
     into v_before using v_id, p_company_id;
  if v_before is null then
    perform private.raise_business_error('DATO_INVALIDO', format('El %s no existe.', v_label));
  end if;
  execute format(
    'update public.%1$I t set (%2$s) = (select %2$s from jsonb_populate_record(null::public.%1$I, $1)) where t.id = $2 returning to_jsonb(t)',
    v_table, v_columns
  ) into v_after using v_data, v_id;
  v_entity := (v_after ->> 'code') || ' ' || (v_after ->> v_name_field);
  if private.diff(v_before, v_after, array(select jsonb_object_keys(v_data))) <> '{}'::jsonb then
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', p_kind, v_id, v_entity,
      format('Modificó el %s %s', v_label, v_entity), null, null, null,
      private.diff(v_before, v_after, array(select jsonb_object_keys(v_data))));
  end if;
  return v_id;
end;
$$;

-- Igual que antes, y además la zona de reparto del cliente de cada remito (routeSheetCandidates).
create or replace function public.route_sheet_candidates(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'route_sheet.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'display_number', d.display_number, 'dispatched_at', x.dispatched_at,
             'sales_order', coalesce(o.display_number, ''),
             'customer', private.customer_stop(d.customer_id),
             'zone', (select jsonb_build_object('id', z.id, 'code', z.code, 'name', z.name,
                                                'delivery_days', to_jsonb(z.delivery_days))
                        from public.customers c join public.delivery_zones z on z.id = c.zone_id
                       where c.id = d.customer_id),
             'last_attempt', case when l.id is not null
               then jsonb_build_object('display_number', s.display_number, 'reason', l.reason) end)
           order by d.number)
      from public.documents d
      join public.delivery_notes x on x.document_id = d.id
      left join public.documents o on o.id = x.sales_order_id
      left join lateral (select (private.last_route_line(d.id)).*) as l on true
      left join public.documents s on s.id = l.document_id
     where d.company_id = p_company_id and d.doc_type = 'DELIVERY_NOTE' and d.status = 'CONFIRMADO'
       and private.delivery_status(d.id) = 'PENDIENTE'
  ), '[]');
end;
$$;

-- Igual que antes, y además las zonas de reparto con la de cada cliente (cmdCreateCompanyFromTemplate).
create or replace function private.clone_company(p_template uuid, p_course uuid, p_slug text, p_owner uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_member uuid;
begin
  insert into public.companies (id, course_id, slug, legal_name, trade_name, tax_id, vat_condition, activity, address_line,
                                city, province, start_date, simulation_date, is_template, status, settings)
  select v_id, p_course, p_slug, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.activity, c.address_line,
         c.city, c.province, c.start_date, c.simulation_date, false, 'ACTIVA', c.settings
    from public.companies c where c.id = p_template;

  insert into public.islands (company_id, number, name)
  select v_id, i.number, i.name from public.islands i where i.company_id = p_template;
  insert into public.sectors (company_id, code, name, island_id)
  select v_id, s.code, s.name, ni.id
    from public.sectors s
    left join public.islands oi on oi.id = s.island_id
    left join public.islands ni on ni.company_id = v_id and ni.number = oi.number
   where s.company_id = p_template;
  insert into public.warehouses (company_id, code, name, is_active)
  select v_id, w.code, w.name, w.is_active from public.warehouses w where w.company_id = p_template;
  insert into public.company_modules (company_id, module_code, is_enabled)
  select v_id, m.module_code, m.is_enabled from public.company_modules m where m.company_id = p_template;
  insert into public.approval_rules (company_id, doc_type, level, min_amount, max_amount, approver_role,
                                     require_different_user, description, is_active)
  select v_id, r.doc_type, r.level, r.min_amount, r.max_amount, r.approver_role, r.require_different_user, r.description, r.is_active
    from public.approval_rules r where r.company_id = p_template;

  insert into public.suppliers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, lead_time_days, category, notes, is_active)
  select v_id, s.code, s.legal_name, s.trade_name, s.tax_id, s.vat_condition, s.address_line, s.city, s.province,
         s.phone, s.email, s.contact_name, s.payment_terms_days, s.lead_time_days, s.category, s.notes, s.is_active
    from public.suppliers s where s.company_id = p_template;
  -- Las zonas de reparto (Fase 9c.1), y cada cliente en la suya (mismo código).
  insert into public.delivery_zones (company_id, code, name, delivery_days, notes, is_active)
  select v_id, z.code, z.name, z.delivery_days, z.notes, z.is_active
    from public.delivery_zones z where z.company_id = p_template;
  insert into public.customers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, credit_limit, notes, is_active, zone_id)
  select v_id, c.code, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.address_line, c.city, c.province,
         c.phone, c.email, c.contact_name, c.payment_terms_days, c.credit_limit, c.notes, c.is_active, nz.id
    from public.customers c
    left join public.delivery_zones oz on oz.id = c.zone_id
    left join public.delivery_zones nz on nz.company_id = v_id and nz.code = oz.code
   where c.company_id = p_template;
  -- El proveedor y el depósito habituales apuntan a los de la empresa nueva (mismo código).
  insert into public.products (company_id, code, name, description, category, product_type, uom_code, is_stockable,
                               standard_cost, sale_price, vat_rate, min_stock, reorder_qty, default_supplier_id,
                               default_warehouse_id, location, is_active)
  select v_id, p.code, p.name, p.description, p.category, p.product_type, p.uom_code, p.is_stockable,
         p.standard_cost, p.sale_price, p.vat_rate, p.min_stock, p.reorder_qty, ns.id, nw.id, p.location, p.is_active
    from public.products p
    left join public.suppliers os on os.id = p.default_supplier_id
    left join public.suppliers ns on ns.company_id = v_id and ns.code = os.code
    left join public.warehouses ow on ow.id = p.default_warehouse_id
    left join public.warehouses nw on nw.company_id = v_id and nw.code = ow.code
   where p.company_id = p_template;
  -- Los centros de trabajo y las listas de materiales, con los productos y los centros de la empresa nueva.
  insert into public.work_centers (company_id, code, name, labor_rate, overhead_rate, is_active)
  select v_id, w.code, w.name, w.labor_rate, w.overhead_rate, w.is_active
    from public.work_centers w where w.company_id = p_template;
  insert into public.boms (company_id, product_id, notes, is_active)
  select v_id, np.id, b.notes, b.is_active
    from public.boms b
    join public.products op on op.id = b.product_id
    join public.products np on np.company_id = v_id and np.code = op.code
   where b.company_id = p_template;
  insert into public.bom_lines (company_id, bom_id, line_no, component_id, quantity)
  select v_id, nb.id, l.line_no, nc.id, l.quantity
    from public.bom_lines l
    join public.boms ob on ob.id = l.bom_id
    join public.products op on op.id = ob.product_id
    join public.products np on np.company_id = v_id and np.code = op.code
    join public.boms nb on nb.company_id = v_id and nb.product_id = np.id
    join public.products oc on oc.id = l.component_id
    join public.products nc on nc.company_id = v_id and nc.code = oc.code
   where l.company_id = p_template;
  insert into public.bom_operations (company_id, bom_id, line_no, work_center_id, hours)
  select v_id, nb.id, o.line_no, nw.id, o.hours
    from public.bom_operations o
    join public.boms ob on ob.id = o.bom_id
    join public.products op on op.id = ob.product_id
    join public.products np on np.company_id = v_id and np.code = op.code
    join public.boms nb on nb.company_id = v_id and nb.product_id = np.id
    join public.work_centers ow on ow.id = o.work_center_id
    join public.work_centers nw on nw.company_id = v_id and nw.code = ow.code
   where o.company_id = p_template;
  -- El personal: convenios, categorías y legajos, con los sectores y los centros de trabajo de la empresa nueva.
  insert into public.labor_agreements (company_id, code, name, union_name, pay_basis, seniority_pct, attendance_pct,
                                       union_pct, union_employer_pct, is_active)
  select v_id, a.code, a.name, a.union_name, a.pay_basis, a.seniority_pct, a.attendance_pct, a.union_pct,
         a.union_employer_pct, a.is_active
    from public.labor_agreements a where a.company_id = p_template;
  insert into public.job_categories (company_id, code, name, agreement_id, basic_salary, is_direct_labor, is_active)
  select v_id, c.code, c.name, na.id, c.basic_salary, c.is_direct_labor, c.is_active
    from public.job_categories c
    join public.labor_agreements oa on oa.id = c.agreement_id
    join public.labor_agreements na on na.company_id = v_id and na.code = oa.code
   where c.company_id = p_template;
  insert into public.employees (company_id, file_number, first_name, last_name, hire_date, category_id, sector_id,
                                work_center_id, status, termination_date, termination_reason)
  select v_id, e.file_number, e.first_name, e.last_name, e.hire_date, nc.id, ns.id, nw.id, e.status,
         e.termination_date, e.termination_reason
    from public.employees e
    join public.job_categories oc on oc.id = e.category_id
    join public.job_categories nc on nc.company_id = v_id and nc.code = oc.code
    join public.sectors os on os.id = e.sector_id
    join public.sectors ns on ns.company_id = v_id and ns.code = os.code
    left join public.work_centers ow on ow.id = e.work_center_id
    left join public.work_centers nw on nw.company_id = v_id and nw.code = ow.code
   where e.company_id = p_template;
  -- El transporte: los transportistas y los vehículos propios.
  insert into public.carriers (company_id, code, legal_name, tax_id, phone, is_active)
  select v_id, c.code, c.legal_name, c.tax_id, c.phone, c.is_active from public.carriers c where c.company_id = p_template;
  insert into public.vehicles (company_id, code, plate, description, is_active)
  select v_id, v.code, v.plate, v.description, v.is_active from public.vehicles v where v.company_id = p_template;
  insert into public.accounts (company_id, code, name, account_type, normal_side, level, is_imputable, description, is_active)
  select v_id, a.code, a.name, a.account_type, a.normal_side, a.level, a.is_imputable, a.description, a.is_active
    from public.accounts a where a.company_id = p_template;
  insert into public.posting_rules (company_id, event, key, account_id)
  select v_id, r.event, r.key, na.id
    from public.posting_rules r
    join public.accounts oa on oa.id = r.account_id
    join public.accounts na on na.company_id = v_id and na.code = oa.code
   where r.company_id = p_template;

  if p_owner is not null then
    insert into public.company_members (company_id, user_id, job_title)
    values (v_id, p_owner, 'Docente a cargo') returning id into v_member;
    insert into public.member_roles (company_id, member_id, role_code) values (v_id, v_member, 'DOCENTE');
  end if;
  return v_id;
end;
$$;
