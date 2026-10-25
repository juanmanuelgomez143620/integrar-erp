-- 46. Fase 6a (docs/FASE_6_RRHH_Y_SUELDOS.md §2): las categorías del personal
-- (un convenio simplificado, con su sueldo básico mensual) y los legajos de los
-- empleados ficticios de la empresa, con su sector y, en el taller, su centro de
-- trabajo. Traducción de la sección "Categorías y legajos del personal" de
-- src/lib/mock/engine.ts y de sus lecturas en queries.ts. La empresa nueva de un
-- curso copia el personal de la plantilla.
--
-- El módulo y los permisos están en la migración de catálogos siguiente; el
-- personal de la demo, en la de la plantilla.

-- ------------------------------------------------------------------ Tablas

-- Categoría del personal: su sueldo básico mensual y si es del taller (mano de obra directa).
create table public.job_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  name text not null check (length(name) between 2 and 60),
  basic_salary numeric(14, 2) not null check (basic_salary > 0),
  is_direct_labor boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id)
);

-- Legajo de un empleado de la empresa simulada: un personaje, sin documento ni datos reales.
create table public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  file_number int not null check (file_number > 0),
  first_name text not null check (length(first_name) between 2 and 60),
  last_name text not null check (length(last_name) between 2 and 60),
  hire_date date not null,
  category_id uuid not null,
  sector_id uuid not null,
  work_center_id uuid,                                              -- sólo el personal del taller
  status text not null default 'ACTIVO' check (status in ('ACTIVO', 'BAJA')),
  termination_date date,
  termination_reason text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, file_number),
  unique (company_id, id),
  check ((status = 'BAJA') = (termination_date is not null)),
  foreign key (company_id, category_id) references public.job_categories (company_id, id),
  foreign key (company_id, sector_id) references public.sectors (company_id, id),
  foreign key (company_id, work_center_id) references public.work_centers (company_id, id)
);
create index employees_category_idx on public.employees (category_id);

create trigger job_categories_audit before insert or update on public.job_categories
  for each row execute function private.set_audit_fields();
create trigger employees_audit before insert or update on public.employees
  for each row execute function private.set_audit_fields();

do $$
declare
  t text;
begin
  foreach t in array array['job_categories', 'employees'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.prevent_company_change()',
      t || '_same_company', t
    );
  end loop;
end;
$$;

create policy job_categories_select on public.job_categories for select to authenticated
  using (company_id in (select private.companies_with_permission('employee.read')));
create policy employees_select on public.employees for select to authenticated
  using (company_id in (select private.companies_with_permission('employee.read')));

-- ------------------------------------------------------------------ Auxiliares

-- "OFICIAL Oficial carpintero" (jobCategoryLabel).
create function private.job_category_label(p_category public.job_categories)
returns text
language sql
immutable
set search_path = ''
as $$ select p_category.code || ' ' || p_category.name $$;

-- "Ortiz, Ramón (legajo 2)" (employeeLabel).
create function private.employee_label(p_employee public.employees)
returns text
language sql
immutable
set search_path = ''
as $$ select p_employee.last_name || ', ' || p_employee.first_name || ' (legajo ' || p_employee.file_number || ')' $$;

-- ------------------------------------------------------------------ Categorías: comandos

-- Crea o modifica una categoría del personal, con su sueldo básico mensual (cmdSaveJobCategory).
-- p_input: {id ('' si es nueva), code, name, basic_salary, is_direct_labor}
create function public.job_category_save(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'employee.update');
  v_id text := coalesce(p_input ->> 'id', '');
  v_existing public.job_categories;
  v_code text := upper(trim(coalesce(p_input ->> 'code', '')));
  v_name text := trim(coalesce(p_input ->> 'name', ''));
  v_salary numeric := (p_input ->> 'basic_salary')::numeric;
  v_direct boolean;
  v_category public.job_categories;
  v_changes jsonb;
begin
  if v_id <> '' then
    select * into v_existing from public.job_categories c where c.id::text = v_id and c.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'La categoría no existe.');
    end if;
  end if;
  if v_code !~ '^[A-Z0-9-]{1,12}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El código de la categoría tiene de 1 a 12 letras, números o guiones.');
  end if;
  if exists (select 1 from public.job_categories c
              where c.company_id = p_company_id and c.code = v_code and c.id is distinct from v_existing.id) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe una categoría con el código %s.', v_code));
  end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'El nombre de la categoría tiene de 2 a 60 caracteres.');
  end if;
  if v_salary is null or v_salary <= 0 or round(v_salary, 2) <> v_salary or v_salary >= 1000000000 then
    perform private.raise_business_error('DATO_INVALIDO',
      'El sueldo básico debe ser un importe mayor que cero, con hasta 2 decimales.');
  end if;
  if jsonb_typeof(p_input -> 'is_direct_labor') is distinct from 'boolean' then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si la categoría es del taller.');
  end if;
  v_direct := (p_input ->> 'is_direct_labor')::boolean;
  if v_existing.id is not null then
    if v_existing.is_direct_labor <> v_direct
       and exists (select 1 from public.employees e where e.category_id = v_existing.id and e.status = 'ACTIVO') then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s tiene personal activo: no se puede cambiar si es del taller.', private.job_category_label(v_existing)),
        'Pasá antes a ese personal a otra categoría.');
    end if;
    v_changes := private.diff(to_jsonb(v_existing),
      to_jsonb(v_existing) || jsonb_build_object('code', v_code, 'name', v_name, 'basic_salary', v_salary,
                                                 'is_direct_labor', v_direct),
      array['code', 'name', 'basic_salary', 'is_direct_labor']);
    if v_changes = '{}'::jsonb then
      return jsonb_build_object('id', v_existing.id);
    end if;
    update public.job_categories
       set code = v_code, name = v_name, basic_salary = v_salary, is_direct_labor = v_direct
     where id = v_existing.id
    returning * into v_category;
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'job_category', v_category.id,
      private.job_category_label(v_category), format('Modificó la categoría %s', private.job_category_label(v_category)),
      null, null, null, v_changes);
    return jsonb_build_object('id', v_category.id);
  end if;
  insert into public.job_categories (company_id, code, name, basic_salary, is_direct_labor)
  values (p_company_id, v_code, v_name, v_salary, v_direct)
  returning * into v_category;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'job_category', v_category.id,
    private.job_category_label(v_category),
    format('Creó la categoría %s: sueldo básico de %s%s', private.job_category_label(v_category),
           private.format_money(v_salary), case when v_direct then ', del taller' else '' end));
  return jsonb_build_object('id', v_category.id);
end;
$$;

-- Una categoría desactivada no se asigna a nadie más; quien ya la tiene la conserva (cmdSetJobCategoryActive).
create function public.job_category_set_active(p_company_id uuid, p_job_category_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'employee.update');
  v_category public.job_categories;
begin
  select * into v_category from public.job_categories c where c.id = p_job_category_id and c.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La categoría no existe.');
  end if;
  if p_active is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si la categoría está activa.');
  end if;
  if v_category.is_active = p_active then
    return;
  end if;
  update public.job_categories set is_active = p_active where id = v_category.id;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, 'job_category',
    v_category.id, private.job_category_label(v_category),
    format('%s la categoría %s', case when p_active then 'Activó' else 'Desactivó' end, private.job_category_label(v_category)));
end;
$$;

-- ------------------------------------------------------------------ Legajos: comandos

-- Da de alta un legajo (con el número siguiente) o lo modifica; el personal del taller
-- trabaja en un centro de trabajo y el de las demás áreas, no (cmdSaveEmployee).
-- p_input: {id ('' si es nuevo), first_name, last_name, hire_date, category_id, sector_id, work_center_id}
create function public.employee_save(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := coalesce(p_input ->> 'id', '');
  v_actor private.actor := private.require_permission(p_company_id,
    case when coalesce(p_input ->> 'id', '') = '' then 'employee.create' else 'employee.update' end);
  v_company public.companies;
  v_existing public.employees;
  v_first text := trim(coalesce(p_input ->> 'first_name', ''));
  v_last text := trim(coalesce(p_input ->> 'last_name', ''));
  v_hire date := private.parse_date(p_input ->> 'hire_date');
  v_category public.job_categories;
  v_sector public.sectors;
  v_center public.work_centers;
  v_center_id uuid;
  v_employee public.employees;
  v_changes jsonb;
  v_number int;
begin
  select * into v_company from public.companies c where c.id = p_company_id;
  if v_id <> '' then
    select * into v_existing from public.employees e where e.id::text = v_id and e.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'El legajo no existe.');
    end if;
    if v_existing.status = 'BAJA' then
      perform private.raise_business_error('TRANSICION_INVALIDA',
        format('%s está dado de baja: el legajo ya no se modifica.', private.employee_label(v_existing)));
    end if;
  end if;
  if length(v_first) < 2 or length(v_first) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'El nombre tiene de 2 a 60 caracteres.');
  end if;
  if length(v_last) < 2 or length(v_last) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'El apellido tiene de 2 a 60 caracteres.');
  end if;
  if v_hire is null then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de ingreso no es válida.');
  end if;
  if v_hire > private.business_date(p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de ingreso no puede ser posterior a hoy.');
  end if;
  if v_hire < v_company.start_date then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La fecha de ingreso no puede ser anterior al inicio de actividades de la empresa (%s).',
             to_char(v_company.start_date, 'DD/MM/YYYY')));
  end if;
  select * into v_category from public.job_categories c
   where c.id::text = coalesce(p_input ->> 'category_id', '') and c.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí la categoría.');
  end if;
  if not v_category.is_active and v_category.id is distinct from v_existing.category_id then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La categoría %s está inactiva.', private.job_category_label(v_category)));
  end if;
  select * into v_sector from public.sectors s
   where s.id::text = coalesce(p_input ->> 'sector_id', '') and s.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el sector.');
  end if;
  if v_category.is_direct_labor then
    select * into v_center from public.work_centers w
     where w.id::text = coalesce(p_input ->> 'work_center_id', '') and w.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'El personal del taller trabaja en un centro de trabajo: elegilo.');
    end if;
    if not v_center.is_active and v_center.id is distinct from v_existing.work_center_id then
      perform private.raise_business_error('DATO_INVALIDO',
        format('El centro de trabajo %s está inactivo.', private.work_center_label(v_center)));
    end if;
    v_center_id := v_center.id;
  elsif coalesce(p_input ->> 'work_center_id', '') <> '' then
    perform private.raise_business_error('DATO_INVALIDO', 'Sólo el personal del taller tiene centro de trabajo.');
  end if;
  if v_existing.id is not null then
    v_changes := private.diff(to_jsonb(v_existing),
      to_jsonb(v_existing) || jsonb_build_object('first_name', v_first, 'last_name', v_last, 'hire_date', v_hire,
                                                 'category_id', v_category.id, 'sector_id', v_sector.id,
                                                 'work_center_id', v_center_id),
      array['first_name', 'last_name', 'hire_date', 'category_id', 'sector_id', 'work_center_id']);
    if v_changes = '{}'::jsonb then
      return jsonb_build_object('id', v_existing.id);
    end if;
    update public.employees
       set first_name = v_first, last_name = v_last, hire_date = v_hire, category_id = v_category.id,
           sector_id = v_sector.id, work_center_id = v_center_id
     where id = v_existing.id
    returning * into v_employee;
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'employee', v_employee.id, private.employee_label(v_employee),
      format('Modificó el legajo %s (%s, %s)', v_employee.file_number, v_employee.last_name, v_employee.first_name),
      null, null, null, v_changes);
    return jsonb_build_object('id', v_employee.id);
  end if;
  select coalesce(max(e.file_number), 0) + 1 into v_number from public.employees e where e.company_id = p_company_id;
  insert into public.employees (company_id, file_number, first_name, last_name, hire_date, category_id, sector_id,
                                work_center_id)
  values (p_company_id, v_number, v_first, v_last, v_hire, v_category.id, v_sector.id, v_center_id)
  returning * into v_employee;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'employee', v_employee.id, private.employee_label(v_employee),
    format('Dio de alta el legajo %s: %s, %s (%s)', v_number, v_last, v_first, v_category.name));
  return jsonb_build_object('id', v_employee.id);
end;
$$;

-- La baja de un legajo, con su fecha y su motivo: no se borra ni se vuelve a modificar (cmdTerminateEmployee).
create function public.employee_terminate(p_company_id uuid, p_employee_id uuid, p_date text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'employee.update');
  v_employee public.employees;
  v_date date := private.parse_date(p_date);
  v_reason text := trim(coalesce(p_reason, ''));
begin
  select * into v_employee from public.employees e where e.id = p_employee_id and e.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'El legajo no existe.');
  end if;
  if v_employee.status = 'BAJA' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s ya está dado de baja.', private.employee_label(v_employee)));
  end if;
  if v_date is null then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de baja no es válida.');
  end if;
  if v_date < v_employee.hire_date then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La baja no puede ser anterior al ingreso (%s).', to_char(v_employee.hire_date, 'DD/MM/YYYY')));
  end if;
  if v_date > private.business_date(p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de baja no puede ser posterior a hoy.');
  end if;
  if length(v_reason) < 3 then
    perform private.raise_business_error('MOTIVO_REQUERIDO', 'Indicá el motivo de la baja: queda en el legajo.');
  end if;
  update public.employees
     set status = 'BAJA', termination_date = v_date, termination_reason = v_reason
   where id = v_employee.id
  returning * into v_employee;
  perform private.log_audit(p_company_id, v_actor, 'DEACTIVATE', 'employee', v_employee.id, private.employee_label(v_employee),
    format('Dio de baja el legajo %s (%s, %s) el %s — %s', v_employee.file_number, v_employee.last_name,
           v_employee.first_name, to_char(v_date, 'DD/MM/YYYY'), v_reason));
end;
$$;

grant execute on function public.job_category_save(uuid, jsonb) to authenticated;
grant execute on function public.job_category_set_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.employee_save(uuid, jsonb) to authenticated;
grant execute on function public.employee_terminate(uuid, uuid, text, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- Las categorías del personal, por código, con cuánta gente activa tiene cada una (listJobCategories).
create function public.job_categories_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'employee.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'code', c.code, 'name', c.name, 'basic_salary', c.basic_salary,
             'is_direct_labor', c.is_direct_labor, 'is_active', c.is_active,
             'employees', (select count(*) from public.employees e where e.category_id = c.id and e.status = 'ACTIVO'))
           order by c.code collate "C")
      from public.job_categories c where c.company_id = p_company_id
  ), '[]');
end;
$$;

-- Los legajos del personal, por número, con la antigüedad en años cumplidos (hasta
-- la baja, si la tuvo) (listEmployees).
create function public.employees_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  perform private.require_read(p_company_id, 'employee.read');
  v_today := private.business_date(p_company_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'file_number', e.file_number, 'first_name', e.first_name, 'last_name', e.last_name,
             'hire_date', e.hire_date,
             'seniority_years', extract(year from age(coalesce(e.termination_date, v_today), e.hire_date))::int,
             'status', e.status, 'termination_date', e.termination_date, 'termination_reason', e.termination_reason,
             'category', jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name, 'basic_salary', c.basic_salary,
                                            'is_direct_labor', c.is_direct_labor),
             'sector', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name),
             'work_center', case when w.id is null then null
                                 else jsonb_build_object('id', w.id, 'code', w.code, 'name', w.name) end)
           order by e.file_number)
      from public.employees e
      join public.job_categories c on c.id = e.category_id
      join public.sectors s on s.id = e.sector_id
      left join public.work_centers w on w.id = e.work_center_id
     where e.company_id = p_company_id
  ), '[]');
end;
$$;

grant execute on function public.job_categories_list(uuid) to authenticated;
grant execute on function public.employees_list(uuid) to authenticated;

-- ------------------------------------------------------------------ Empresas: la nueva copia el personal

-- Igual que antes, y además las categorías y los legajos de la plantilla, con los
-- sectores y los centros de trabajo de la empresa nueva (cmdCreateCompanyFromTemplate).
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
  -- El personal: categorías y legajos, con los sectores y los centros de trabajo de la empresa nueva.
  insert into public.job_categories (company_id, code, name, basic_salary, is_direct_labor, is_active)
  select v_id, c.code, c.name, c.basic_salary, c.is_direct_labor, c.is_active
    from public.job_categories c where c.company_id = p_template;
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

