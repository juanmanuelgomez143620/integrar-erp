-- 72. Fase 7c.1 (docs/FASE_7_IMPUESTOS_LOGISTICA_Y_CONTROL.md §4): los transportistas (los
-- fletes contratados) y los vehículos propios con que sale el reparto. Los mantiene Logística;
-- se desactivan, no se borran (una hoja de ruta nueva ya no los usa). Traducción de la sección
-- "Transporte" de src/lib/mock/engine.ts y de sus lecturas en queries.ts.
--
-- El módulo de logística y sus permisos están en la migración de catálogos siguiente; los
-- transportistas y el camión de la demo, en la de la plantilla; las empresas que ya existían
-- los reciben en la última de esta fase.

-- ------------------------------------------------------------------ Tablas

-- Transportista: un flete contratado, con su CUIT simulado. Lo que cobra se registra con su
-- factura de proveedor, como hasta ahora.
create table public.carriers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  legal_name text not null check (length(legal_name) between 2 and 80),
  tax_id text not null check (tax_id ~ '^[0-9]{2}-[0-9]{8}-[0-9]$'),
  phone text not null default '' check (length(phone) <= 40),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id)
);

create trigger carriers_audit before insert or update on public.carriers
  for each row execute function private.set_audit_fields();
alter table public.carriers enable row level security;
revoke all on table public.carriers from anon, authenticated;
grant select on table public.carriers to authenticated;
create trigger carriers_same_company before update on public.carriers
  for each row execute function private.prevent_company_change();
create policy carriers_select on public.carriers for select to authenticated
  using (company_id in (select private.companies_with_permission('carrier.read')));

-- Vehículo propio: un código interno y su dominio (ficticio). Lo maneja un chofer del legajo.
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  plate text not null check (plate ~ '^[A-Z0-9 ]{6,9}$'),
  description text not null check (length(description) between 2 and 80),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, plate),
  unique (company_id, id)
);

create trigger vehicles_audit before insert or update on public.vehicles
  for each row execute function private.set_audit_fields();
alter table public.vehicles enable row level security;
revoke all on table public.vehicles from anon, authenticated;
grant select on table public.vehicles to authenticated;
create trigger vehicles_same_company before update on public.vehicles
  for each row execute function private.prevent_company_change();
create policy vehicles_select on public.vehicles for select to authenticated
  using (company_id in (select private.companies_with_permission('carrier.read')));

-- ------------------------------------------------------------------ Auxiliares

-- "TR-001 Transportes Ruta 12 SRL" (carrierLabel).
create function private.carrier_label(p_carrier public.carriers)
returns text
language sql
immutable
set search_path = ''
as $$ select p_carrier.code || ' ' || p_carrier.legal_name $$;

-- "CAM-01 (AF 512 MS)" (vehicleLabel).
create function private.vehicle_label(p_vehicle public.vehicles)
returns text
language sql
immutable
set search_path = ''
as $$ select p_vehicle.code || ' (' || p_vehicle.plate || ')' $$;

-- ------------------------------------------------------------------ Transportistas: comandos

-- Logística da de alta o modifica un transportista (cmdSaveCarrier).
-- p_input: {id ('' si es nuevo), code, legal_name, tax_id, phone}
create function public.carrier_save(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := coalesce(p_input ->> 'id', '');
  v_actor private.actor := private.require_permission(p_company_id,
                             case when v_id <> '' then 'carrier.update' else 'carrier.create' end);
  v_existing public.carriers;
  v_code text := upper(trim(coalesce(p_input ->> 'code', '')));
  v_legal_name text := trim(coalesce(p_input ->> 'legal_name', ''));
  v_tax_id text := trim(coalesce(p_input ->> 'tax_id', ''));
  v_phone text := trim(coalesce(p_input ->> 'phone', ''));
  v_carrier public.carriers;
  v_changes jsonb;
begin
  if v_id <> '' then
    select * into v_existing from public.carriers c where c.id::text = v_id and c.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'El transportista no existe.');
    end if;
  end if;
  if v_code !~ '^[A-Z0-9-]{1,12}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El código del transportista tiene de 1 a 12 letras, números o guiones.');
  end if;
  if exists (select 1 from public.carriers c
              where c.company_id = p_company_id and c.code = v_code and c.id is distinct from v_existing.id) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe un transportista con el código %s.', v_code));
  end if;
  if length(v_legal_name) < 2 or length(v_legal_name) > 80 then
    perform private.raise_business_error('DATO_INVALIDO', 'La razón social tiene de 2 a 80 caracteres.');
  end if;
  if v_tax_id !~ '^[0-9]{2}-[0-9]{8}-[0-9]$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El CUIT debe tener el formato 30-12345678-9.');
  end if;
  if length(v_phone) > 40 then
    perform private.raise_business_error('DATO_INVALIDO', 'El teléfono tiene hasta 40 caracteres.');
  end if;
  if v_existing.id is not null then
    v_changes := private.diff(to_jsonb(v_existing),
      to_jsonb(v_existing) || jsonb_build_object('code', v_code, 'legal_name', v_legal_name, 'tax_id', v_tax_id,
                                                 'phone', v_phone),
      array['code', 'legal_name', 'tax_id', 'phone']);
    if v_changes = '{}'::jsonb then
      return jsonb_build_object('id', v_existing.id);
    end if;
    update public.carriers
       set code = v_code, legal_name = v_legal_name, tax_id = v_tax_id, phone = v_phone
     where id = v_existing.id
    returning * into v_carrier;
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'carrier', v_carrier.id, private.carrier_label(v_carrier),
      format('Modificó el transportista %s', private.carrier_label(v_carrier)), null, null, null, v_changes);
    return jsonb_build_object('id', v_carrier.id);
  end if;
  insert into public.carriers (company_id, code, legal_name, tax_id, phone)
  values (p_company_id, v_code, v_legal_name, v_tax_id, v_phone)
  returning * into v_carrier;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'carrier', v_carrier.id, private.carrier_label(v_carrier),
    format('Dio de alta el transportista %s', private.carrier_label(v_carrier)));
  return jsonb_build_object('id', v_carrier.id);
end;
$$;

-- Un transportista desactivado no se elige en las hojas de ruta nuevas (cmdSetCarrierActive).
create function public.carrier_set_active(p_company_id uuid, p_carrier_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'carrier.update');
  v_carrier public.carriers;
begin
  select * into v_carrier from public.carriers c where c.id = p_carrier_id and c.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'El transportista no existe.');
  end if;
  if p_active is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si el transportista está activo.');
  end if;
  if v_carrier.is_active = p_active then
    return;
  end if;
  update public.carriers set is_active = p_active where id = v_carrier.id;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end,
    'carrier', v_carrier.id, private.carrier_label(v_carrier),
    format('%s el transportista %s', case when p_active then 'Activó' else 'Desactivó' end,
           private.carrier_label(v_carrier)));
end;
$$;

grant execute on function public.carrier_save(uuid, jsonb) to authenticated;
grant execute on function public.carrier_set_active(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ Vehículos: comandos

-- Logística da de alta o modifica un vehículo propio: el dominio va en mayúsculas, con un
-- solo espacio entre las partes (cmdSaveVehicle).
-- p_input: {id ('' si es nuevo), code, plate, description}
create function public.vehicle_save(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := coalesce(p_input ->> 'id', '');
  v_actor private.actor := private.require_permission(p_company_id,
                             case when v_id <> '' then 'carrier.update' else 'carrier.create' end);
  v_existing public.vehicles;
  v_code text := upper(trim(coalesce(p_input ->> 'code', '')));
  v_plate text := trim(regexp_replace(upper(coalesce(p_input ->> 'plate', '')), '[[:space:]]+', ' ', 'g'));
  v_description text := trim(coalesce(p_input ->> 'description', ''));
  v_vehicle public.vehicles;
  v_changes jsonb;
begin
  if v_id <> '' then
    select * into v_existing from public.vehicles v where v.id::text = v_id and v.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'El vehículo no existe.');
    end if;
  end if;
  if v_code !~ '^[A-Z0-9-]{1,12}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El código del vehículo tiene de 1 a 12 letras, números o guiones.');
  end if;
  if exists (select 1 from public.vehicles v
              where v.company_id = p_company_id and v.code = v_code and v.id is distinct from v_existing.id) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe un vehículo con el código %s.', v_code));
  end if;
  if v_plate !~ '^[A-Z0-9 ]{6,9}$' then
    perform private.raise_business_error('DATO_INVALIDO',
      'El dominio tiene de 6 a 9 letras, números o espacios (por ejemplo, AB 123 CD).');
  end if;
  if exists (select 1 from public.vehicles v
              where v.company_id = p_company_id and v.plate = v_plate and v.id is distinct from v_existing.id) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe un vehículo con el dominio %s.', v_plate));
  end if;
  if length(v_description) < 2 or length(v_description) > 80 then
    perform private.raise_business_error('DATO_INVALIDO', 'La descripción del vehículo tiene de 2 a 80 caracteres.');
  end if;
  if v_existing.id is not null then
    v_changes := private.diff(to_jsonb(v_existing),
      to_jsonb(v_existing) || jsonb_build_object('code', v_code, 'plate', v_plate, 'description', v_description),
      array['code', 'plate', 'description']);
    if v_changes = '{}'::jsonb then
      return jsonb_build_object('id', v_existing.id);
    end if;
    update public.vehicles
       set code = v_code, plate = v_plate, description = v_description
     where id = v_existing.id
    returning * into v_vehicle;
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'vehicle', v_vehicle.id, private.vehicle_label(v_vehicle),
      format('Modificó el vehículo %s', private.vehicle_label(v_vehicle)), null, null, null, v_changes);
    return jsonb_build_object('id', v_vehicle.id);
  end if;
  insert into public.vehicles (company_id, code, plate, description)
  values (p_company_id, v_code, v_plate, v_description)
  returning * into v_vehicle;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'vehicle', v_vehicle.id, private.vehicle_label(v_vehicle),
    format('Dio de alta el vehículo %s: %s', private.vehicle_label(v_vehicle), v_description));
  return jsonb_build_object('id', v_vehicle.id);
end;
$$;

-- Un vehículo desactivado (en el taller, vendido) no se elige en las hojas de ruta nuevas
-- (cmdSetVehicleActive).
create function public.vehicle_set_active(p_company_id uuid, p_vehicle_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'carrier.update');
  v_vehicle public.vehicles;
begin
  select * into v_vehicle from public.vehicles v where v.id = p_vehicle_id and v.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'El vehículo no existe.');
  end if;
  if p_active is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si el vehículo está activo.');
  end if;
  if v_vehicle.is_active = p_active then
    return;
  end if;
  update public.vehicles set is_active = p_active where id = v_vehicle.id;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end,
    'vehicle', v_vehicle.id, private.vehicle_label(v_vehicle),
    format('%s el vehículo %s', case when p_active then 'Activó' else 'Desactivó' end,
           private.vehicle_label(v_vehicle)));
end;
$$;

grant execute on function public.vehicle_save(uuid, jsonb) to authenticated;
grant execute on function public.vehicle_set_active(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- Los transportistas de la empresa, por código (listCarriers).
create function public.carriers_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'carrier.read');
  return coalesce((
    select jsonb_agg(to_jsonb(c) order by c.code collate "C")
      from public.carriers c where c.company_id = p_company_id
  ), '[]');
end;
$$;

-- Los vehículos propios de la empresa, por código (listVehicles).
create function public.vehicles_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'carrier.read');
  return coalesce((
    select jsonb_agg(to_jsonb(v) order by v.code collate "C")
      from public.vehicles v where v.company_id = p_company_id
  ), '[]');
end;
$$;

grant execute on function public.carriers_list(uuid) to authenticated;
grant execute on function public.vehicles_list(uuid) to authenticated;

-- ------------------------------------------------------------------ Empresas: la nueva copia el transporte

-- Igual que antes, y además los transportistas y los vehículos propios de la plantilla
-- (cmdCreateCompanyFromTemplate).
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
  insert into public.customers (company_id, code, legal_name, trade_name, tax_id, vat_condition, address_line, city, province,
                                phone, email, contact_name, payment_terms_days, credit_limit, notes, is_active)
  select v_id, c.code, c.legal_name, c.trade_name, c.tax_id, c.vat_condition, c.address_line, c.city, c.province,
         c.phone, c.email, c.contact_name, c.payment_terms_days, c.credit_limit, c.notes, c.is_active
    from public.customers c where c.company_id = p_template;
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
