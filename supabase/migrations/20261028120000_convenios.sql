-- 62. Fase 6d.1 (docs/FASE_6D_CONVENIOS.md): los convenios colectivos de la empresa, cada
-- uno con su forma de pago (por mes o por hora: el jornal del taller), sus adicionales
-- (antigüedad y presentismo) y lo del sindicato (el aporte que se retiene al empleado y la
-- contribución de la empresa); cada categoría es de un convenio y la liquidación copia el
-- de cada empleado. Lo del sindicato va a la cuenta Sindicatos a pagar y se paga con las
-- cargas sociales. Traducción de la sección "Convenios colectivos" de
-- src/lib/mock/engine.ts, de los cambios en la liquidación y de sus lecturas en queries.ts.
--
-- Las claves de imputación nuevas están en la migración de catálogos siguiente; la cuenta,
-- las reglas, los convenios y el chofer de la demo, en la de la plantilla; las empresas que
-- ya existían reciben todo en la última de esta fase.

-- ------------------------------------------------------------------ Tablas

-- Convenio colectivo: cómo paga (por mes o por hora) y sus porcentajes (a validar).
create table public.labor_agreements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  name text not null check (length(name) between 2 and 80),
  union_name text not null default '' check (length(union_name) <= 60),
  pay_basis text not null check (pay_basis in ('MONTHLY', 'HOURLY')),
  seniority_pct numeric(5, 2) not null default 0 check (seniority_pct between 0 and 100),
  attendance_pct numeric(5, 2) not null default 0 check (attendance_pct between 0 and 100),
  union_pct numeric(5, 2) not null default 0 check (union_pct between 0 and 100),                    -- aporte sindical
  union_employer_pct numeric(5, 2) not null default 0 check (union_employer_pct between 0 and 100),  -- contribución
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id)
);

create trigger labor_agreements_audit before insert or update on public.labor_agreements
  for each row execute function private.set_audit_fields();
alter table public.labor_agreements enable row level security;
revoke all on table public.labor_agreements from anon, authenticated;
grant select on table public.labor_agreements to authenticated;
create trigger labor_agreements_same_company before update on public.labor_agreements
  for each row execute function private.prevent_company_change();
create policy labor_agreements_select on public.labor_agreements for select to authenticated
  using (company_id in (select private.companies_with_permission('employee.read')));

-- Cada categoría es de un convenio; su básico es mensual o, en un convenio por hora, el
-- valor hora. Las categorías de antes reciben el suyo en la última migración de esta fase,
-- y ahí la columna pasa a ser obligatoria.
alter table public.job_categories
  add column agreement_id uuid,
  add foreign key (company_id, agreement_id) references public.labor_agreements (company_id, id);
create index job_categories_agreement_idx on public.job_categories (agreement_id);

-- Lo que la línea copia del convenio, las horas de quien cobra por hora y lo del sindicato.
-- Las líneas de antes quedan sin convenio, por mes y sin sindicato.
alter table public.payroll_lines
  add column agreement_id uuid,
  add column pay_basis text not null default 'MONTHLY' check (pay_basis in ('MONTHLY', 'HOURLY')),
  add column seniority_pct numeric(5, 2) not null default 0 check (seniority_pct between 0 and 100),
  add column attendance_pct numeric(5, 2) not null default 0 check (attendance_pct between 0 and 100),
  add column union_pct numeric(5, 2) not null default 0 check (union_pct between 0 and 100),
  add column union_employer_pct numeric(5, 2) not null default 0 check (union_employer_pct between 0 and 100),
  add column hours_worked numeric(6, 2) not null default 0 check (hours_worked between 0 and 300),
  add column union_dues numeric(14, 2) not null default 0,                -- aporte sindical retenido
  add column union_contribution numeric(14, 2) not null default 0,        -- contribución del convenio
  add foreign key (company_id, agreement_id) references public.labor_agreements (company_id, id);

-- ------------------------------------------------------------------ Auxiliares

-- "MADERA Industria de la madera" (laborAgreementLabel).
create function private.labor_agreement_label(p_agreement public.labor_agreements)
returns text
language sql
immutable
set search_path = ''
as $$ select p_agreement.code || ' ' || p_agreement.name $$;

-- ------------------------------------------------------------------ Convenios: comandos

-- RRHH crea o modifica un convenio: su forma de pago y sus porcentajes (cmdSaveLaborAgreement).
-- p_input: {id ('' si es nuevo), code, name, union_name, pay_basis, seniority_pct, attendance_pct,
-- union_pct, union_employer_pct}
create function public.labor_agreement_save(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'employee.update');
  v_id text := coalesce(p_input ->> 'id', '');
  v_existing public.labor_agreements;
  v_code text := upper(trim(coalesce(p_input ->> 'code', '')));
  v_name text := trim(coalesce(p_input ->> 'name', ''));
  v_union text := trim(coalesce(p_input ->> 'union_name', ''));
  v_basis text := coalesce(p_input ->> 'pay_basis', '');
  v_key text;
  v_value numeric;
  v_rates jsonb := '{}';
  v_agreement public.labor_agreements;
  v_changes jsonb;
begin
  if v_id <> '' then
    select * into v_existing from public.labor_agreements a where a.id::text = v_id and a.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'El convenio no existe.');
    end if;
  end if;
  if v_code !~ '^[A-Z0-9-]{1,12}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El código del convenio tiene de 1 a 12 letras, números o guiones.');
  end if;
  if exists (select 1 from public.labor_agreements a
              where a.company_id = p_company_id and a.code = v_code and a.id is distinct from v_existing.id) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe un convenio con el código %s.', v_code));
  end if;
  if length(v_name) < 2 or length(v_name) > 80 then
    perform private.raise_business_error('DATO_INVALIDO', 'El nombre del convenio tiene de 2 a 80 caracteres.');
  end if;
  if length(v_union) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'El nombre del sindicato tiene hasta 60 caracteres.');
  end if;
  if v_basis not in ('MONTHLY', 'HOURLY') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí si el convenio paga por mes o por hora.');
  end if;
  foreach v_key in array array['seniority_pct', 'attendance_pct', 'union_pct', 'union_employer_pct'] loop
    v_value := case when jsonb_typeof(p_input -> v_key) = 'number' then (p_input ->> v_key)::numeric end;
    if v_value is null or v_value < 0 or v_value > 100 or round(v_value, 2) <> v_value then
      perform private.raise_business_error('DATO_INVALIDO', 'Los porcentajes del convenio van de 0 a 100, con hasta 2 decimales.');
    end if;
    v_rates := v_rates || jsonb_build_object(v_key, v_value);
  end loop;
  if v_existing.id is not null then
    if v_existing.pay_basis <> v_basis
       and exists (select 1 from public.job_categories c where c.agreement_id = v_existing.id) then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s tiene categorías: no se cambia su forma de pago.', private.labor_agreement_label(v_existing)),
        'Sus categorías guardan un básico mensual o un valor hora según el convenio: creá otro convenio.');
    end if;
    v_changes := private.diff(to_jsonb(v_existing),
      to_jsonb(v_existing) || jsonb_build_object('code', v_code, 'name', v_name, 'union_name', v_union,
                                                 'pay_basis', v_basis) || v_rates,
      array['code', 'name', 'union_name', 'pay_basis', 'seniority_pct', 'attendance_pct', 'union_pct',
            'union_employer_pct']);
    if v_changes = '{}'::jsonb then
      return jsonb_build_object('id', v_existing.id);
    end if;
    update public.labor_agreements
       set code = v_code, name = v_name, union_name = v_union, pay_basis = v_basis,
           seniority_pct = (v_rates ->> 'seniority_pct')::numeric, attendance_pct = (v_rates ->> 'attendance_pct')::numeric,
           union_pct = (v_rates ->> 'union_pct')::numeric, union_employer_pct = (v_rates ->> 'union_employer_pct')::numeric
     where id = v_existing.id
    returning * into v_agreement;
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'labor_agreement', v_agreement.id,
      private.labor_agreement_label(v_agreement), format('Modificó el convenio %s', private.labor_agreement_label(v_agreement)),
      null, null, null, v_changes);
    return jsonb_build_object('id', v_agreement.id);
  end if;
  insert into public.labor_agreements (company_id, code, name, union_name, pay_basis, seniority_pct, attendance_pct,
                                       union_pct, union_employer_pct)
  values (p_company_id, v_code, v_name, v_union, v_basis, (v_rates ->> 'seniority_pct')::numeric,
          (v_rates ->> 'attendance_pct')::numeric, (v_rates ->> 'union_pct')::numeric,
          (v_rates ->> 'union_employer_pct')::numeric)
  returning * into v_agreement;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'labor_agreement', v_agreement.id,
    private.labor_agreement_label(v_agreement),
    format('Creó el convenio %s (%s)', private.labor_agreement_label(v_agreement),
           case when v_basis = 'HOURLY' then 'por hora' else 'por mes' end));
  return jsonb_build_object('id', v_agreement.id);
end;
$$;

-- Un convenio desactivado no se asigna a categorías nuevas; las que ya lo tienen lo
-- conservan (cmdSetLaborAgreementActive).
create function public.labor_agreement_set_active(p_company_id uuid, p_agreement_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'employee.update');
  v_agreement public.labor_agreements;
begin
  select * into v_agreement from public.labor_agreements a where a.id = p_agreement_id and a.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'El convenio no existe.');
  end if;
  if p_active is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si el convenio está activo.');
  end if;
  if v_agreement.is_active = p_active then
    return;
  end if;
  update public.labor_agreements set is_active = p_active where id = v_agreement.id;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end,
    'labor_agreement', v_agreement.id, private.labor_agreement_label(v_agreement),
    format('%s el convenio %s', case when p_active then 'Activó' else 'Desactivó' end,
           private.labor_agreement_label(v_agreement)));
end;
$$;

grant execute on function public.labor_agreement_save(uuid, jsonb) to authenticated;
grant execute on function public.labor_agreement_set_active(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ Categorías: en un convenio

-- Igual que antes, y además el convenio de la categoría: su básico es mensual o, en un
-- convenio por hora, el valor hora (cmdSaveJobCategory).
-- p_input: {id ('' si es nueva), code, name, agreement_id, basic_salary, is_direct_labor}
create or replace function public.job_category_save(p_company_id uuid, p_input jsonb)
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
  v_agreement public.labor_agreements;
  v_hourly boolean;
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
  select * into v_agreement from public.labor_agreements a
   where a.id::text = coalesce(p_input ->> 'agreement_id', '') and a.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el convenio de la categoría.');
  end if;
  if not v_agreement.is_active and v_agreement.id is distinct from v_existing.agreement_id then
    perform private.raise_business_error('DATO_INVALIDO',
      format('El convenio %s está inactivo.', private.labor_agreement_label(v_agreement)));
  end if;
  v_hourly := v_agreement.pay_basis = 'HOURLY';
  if v_salary is null or v_salary <= 0 or round(v_salary, 2) <> v_salary or v_salary >= 1000000000 then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s debe ser un importe mayor que cero, con hasta 2 decimales.',
             case when v_hourly then 'El valor hora' else 'El sueldo básico' end));
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
      to_jsonb(v_existing) || jsonb_build_object('code', v_code, 'name', v_name, 'agreement_id', v_agreement.id,
                                                 'basic_salary', v_salary, 'is_direct_labor', v_direct),
      array['code', 'name', 'agreement_id', 'basic_salary', 'is_direct_labor']);
    if v_changes = '{}'::jsonb then
      return jsonb_build_object('id', v_existing.id);
    end if;
    update public.job_categories
       set code = v_code, name = v_name, agreement_id = v_agreement.id, basic_salary = v_salary, is_direct_labor = v_direct
     where id = v_existing.id
    returning * into v_category;
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'job_category', v_category.id,
      private.job_category_label(v_category), format('Modificó la categoría %s', private.job_category_label(v_category)),
      null, null, null, v_changes);
    return jsonb_build_object('id', v_category.id);
  end if;
  insert into public.job_categories (company_id, code, name, agreement_id, basic_salary, is_direct_labor)
  values (p_company_id, v_code, v_name, v_agreement.id, v_salary, v_direct)
  returning * into v_category;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'job_category', v_category.id,
    private.job_category_label(v_category),
    format('Creó la categoría %s (%s): %s de %s%s', private.job_category_label(v_category), v_agreement.code,
           case when v_hourly then 'valor hora' else 'sueldo básico' end, private.format_money(v_salary),
           case when v_direct then ', del taller' else '' end));
  return jsonb_build_object('id', v_category.id);
end;
$$;

-- ------------------------------------------------------------------ Lecturas del personal

-- Los convenios de la empresa, por código, con sus categorías y su personal activo (listLaborAgreements).
create function public.labor_agreements_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'employee.read');
  return coalesce((
    select jsonb_agg(to_jsonb(a) || jsonb_build_object(
             'categories', (select count(*) from public.job_categories c where c.agreement_id = a.id),
             'employees', (select count(*) from public.employees e join public.job_categories c on c.id = e.category_id
                            where c.agreement_id = a.id and e.status = 'ACTIVO'))
           order by a.code collate "C")
      from public.labor_agreements a where a.company_id = p_company_id
  ), '[]');
end;
$$;

grant execute on function public.labor_agreements_list(uuid) to authenticated;

-- Igual que antes, y además el convenio de cada categoría (listJobCategories).
create or replace function public.job_categories_list(p_company_id uuid)
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
             'id', c.id, 'code', c.code, 'name', c.name,
             'agreement', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'pay_basis', a.pay_basis),
             'basic_salary', c.basic_salary, 'is_direct_labor', c.is_direct_labor, 'is_active', c.is_active,
             'employees', (select count(*) from public.employees e where e.category_id = c.id and e.status = 'ACTIVO'))
           order by c.code collate "C")
      from public.job_categories c join public.labor_agreements a on a.id = c.agreement_id
     where c.company_id = p_company_id
  ), '[]');
end;
$$;

-- Igual que antes, y además el convenio de la categoría de cada legajo y cómo paga (listEmployees).
create or replace function public.employees_list(p_company_id uuid)
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
                                            'is_direct_labor', c.is_direct_labor, 'agreement_code', a.code,
                                            'pay_basis', a.pay_basis),
             'sector', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name),
             'work_center', case when w.id is null then null
                                 else jsonb_build_object('id', w.id, 'code', w.code, 'name', w.name) end)
           order by e.file_number)
      from public.employees e
      join public.job_categories c on c.id = e.category_id
      join public.labor_agreements a on a.id = c.agreement_id
      join public.sectors s on s.id = e.sector_id
      left join public.work_centers w on w.id = e.work_center_id
     where e.company_id = p_company_id
  ), '[]');
end;
$$;

-- ------------------------------------------------------------------ Empresas: la nueva copia los convenios

-- Igual que antes, y además los convenios de la plantilla: cada categoría queda en el
-- convenio del mismo código de la empresa nueva (cmdCreateCompanyFromTemplate).
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

-- ------------------------------------------------------------------ Liquidación: con el convenio de cada empleado

-- Los importes de un empleado, cada concepto redondeado a centavos (payrollAmounts): el
-- básico (por mes, proporcional a los días de un mes de 30; por hora, el valor hora por las
-- horas), la antigüedad y el presentismo del convenio (si no faltó sin aviso), las horas
-- extra (valor hora con la antigüedad: por mes, el básico más la antigüedad sobre 200), los
-- aportes legales y el sindical, las contribuciones patronales y la del convenio. p_rates:
-- los porcentajes legales de la liquidación con los del convenio de la línea.
drop function private.payroll_amounts(jsonb, numeric, int, int, int, numeric, numeric);
create function private.payroll_amounts(p_rates jsonb, p_basis text, p_basic numeric, p_years int, p_days int,
                                        p_hours numeric, p_absences int, p_overtime_50 numeric, p_overtime_100 numeric)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_monthly boolean := p_basis = 'MONTHLY';
  v_basic numeric := round(case when v_monthly then p_basic * p_days / 30 else p_basic * p_hours end, 2);
  v_seniority numeric := round(v_basic * (p_rates ->> 'seniority_pct')::numeric * p_years / 100, 2);
  v_attendance numeric := case when p_absences = 0
    then round((v_basic + v_seniority) * (p_rates ->> 'attendance_pct')::numeric / 100, 2) else 0 end;
  v_full numeric := p_basic + round(p_basic * (p_rates ->> 'seniority_pct')::numeric * p_years / 100, 2);
  v_hourly numeric := round(case when v_monthly then v_full / 200 else v_full end, 2);
  v_overtime numeric := round(round(v_hourly * 1.5 * p_overtime_50, 2) + round(v_hourly * 2 * p_overtime_100, 2), 2);
  v_gross numeric := round(v_basic + v_seniority + v_attendance + v_overtime, 2);
  v_retirement numeric := round(v_gross * (p_rates ->> 'retirement_pct')::numeric / 100, 2);
  v_pami numeric := round(v_gross * (p_rates ->> 'pami_pct')::numeric / 100, 2);
  v_health numeric := round(v_gross * (p_rates ->> 'health_pct')::numeric / 100, 2);
  v_union_dues numeric := round(v_gross * (p_rates ->> 'union_pct')::numeric / 100, 2);
  v_deductions numeric := round(v_retirement + v_pami + v_health + v_union_dues, 2);
begin
  return jsonb_build_object(
    'basic', v_basic, 'seniority', v_seniority, 'attendance', v_attendance, 'overtime', v_overtime, 'gross', v_gross,
    'retirement', v_retirement, 'pami', v_pami, 'health', v_health, 'union_dues', v_union_dues,
    'deductions', v_deductions, 'net', round(v_gross - v_deductions, 2),
    'employer', round(v_gross * (p_rates ->> 'employer_pct')::numeric / 100, 2),
    'union_contribution', round(v_gross * (p_rates ->> 'union_employer_pct')::numeric / 100, 2));
end;
$$;

-- Los porcentajes de una línea ya creada: los legales de su liquidación y los del convenio
-- que copió (payrollLineRates).
create function private.payroll_line_rates(p_rates jsonb, p_line public.payroll_lines)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_rates || jsonb_build_object('seniority_pct', p_line.seniority_pct, 'attendance_pct', p_line.attendance_pct,
                                       'union_pct', p_line.union_pct, 'union_employer_pct', p_line.union_employer_pct)
$$;

-- Igual que antes, y además cada línea copia el convenio de la categoría: su forma de pago
-- y sus porcentajes. Quien cobra por hora empieza con las horas de un mes completo (o la
-- parte desde su ingreso) (cmdCreatePayroll). p_input: {period, payment_date, notes}
create or replace function public.payroll_create(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'payroll.create');
  v_company public.companies;
  v_period text := coalesce(p_input ->> 'period', '');
  v_payment date;
  v_notes text := trim(coalesce(p_input ->> 'notes', ''));
  v_other public.documents;
  v_end date;
  v_count int;
  v_rates jsonb;
  v_doc public.documents;
begin
  select * into v_company from public.companies c where c.id = p_company_id;
  if v_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  if v_period > to_char(private.business_date(p_company_id), 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO', 'Ese mes todavía no empezó: no se puede liquidar.');
  end if;
  if v_period < to_char(v_company.start_date, 'YYYY-MM') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La empresa empezó sus actividades el %s: no hay sueldos antes.', to_char(v_company.start_date, 'DD/MM/YYYY')));
  end if;
  select d.* into v_other
    from public.documents d join public.payrolls p on p.document_id = d.id
   where d.company_id = p_company_id and d.status <> 'ANULADA' and p.period = v_period
   order by d.number limit 1;
  if v_other.id is not null then
    perform private.raise_business_error('DATO_INVALIDO',
      format('Ya hay una liquidación de %s: %s.', private.period_label(v_period), v_other.display_number));
  end if;
  v_payment := private.parse_date(p_input ->> 'payment_date');
  if v_payment is null then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de pago no es válida.');
  end if;
  if v_payment < (v_period || '-01')::date then
    perform private.raise_business_error('DATO_INVALIDO', 'La fecha de pago no puede ser anterior al mes liquidado.');
  end if;
  if length(v_notes) > 500 then
    perform private.raise_business_error('DATO_INVALIDO', 'Las observaciones tienen hasta 500 caracteres.');
  end if;
  v_end := private.period_end(v_period);
  select count(*) into v_count
    from public.employees e where e.company_id = p_company_id and e.status = 'ACTIVO' and e.hire_date <= v_end;
  if v_count = 0 then
    perform private.raise_business_error('DATO_INVALIDO',
      format('No hay personal activo para liquidar %s.', private.period_label(v_period)));
  end if;
  v_rates := private.payroll_rates(p_company_id);
  v_doc := private.new_document(p_company_id, 'PAYROLL', v_actor, null, v_notes);
  insert into public.payrolls (document_id, company_id, period, payment_date, rates)
  values (v_doc.id, p_company_id, v_period, v_payment, v_rates);
  insert into public.payroll_lines (company_id, document_id, line_no, employee_id, category_id, basic_salary, seniority_years,
                                    is_direct_labor, work_center_id, agreement_id, pay_basis, seniority_pct, attendance_pct,
                                    union_pct, union_employer_pct, days_worked, hours_worked, absence_days, overtime_50,
                                    overtime_100, basic, seniority, attendance, overtime, gross, retirement, pami, health,
                                    union_dues, deductions, net, employer, union_contribution)
  select p_company_id, v_doc.id, x.line_no, x.employee_id, x.category_id, x.basic_salary, x.years, x.is_direct_labor,
         x.work_center_id, x.agreement_id, x.pay_basis, x.seniority_pct, x.attendance_pct, x.union_pct,
         x.union_employer_pct, x.days_worked, x.hours_worked, 0, 0, 0,
         (y.a ->> 'basic')::numeric, (y.a ->> 'seniority')::numeric, (y.a ->> 'attendance')::numeric,
         (y.a ->> 'overtime')::numeric, (y.a ->> 'gross')::numeric, (y.a ->> 'retirement')::numeric,
         (y.a ->> 'pami')::numeric, (y.a ->> 'health')::numeric, (y.a ->> 'union_dues')::numeric,
         (y.a ->> 'deductions')::numeric, (y.a ->> 'net')::numeric, (y.a ->> 'employer')::numeric,
         (y.a ->> 'union_contribution')::numeric
    from (
      select row_number() over (order by e.file_number)::int as line_no, e.id as employee_id, c.id as category_id,
             c.basic_salary, c.is_direct_labor, e.work_center_id, a.id as agreement_id, a.pay_basis, a.seniority_pct,
             a.attendance_pct, a.union_pct, a.union_employer_pct,
             extract(year from age(v_end, e.hire_date))::int as years,
             case when a.pay_basis = 'HOURLY' then 0 else m.days end as days_worked,
             case when a.pay_basis = 'HOURLY' then round(private.month_hours() * m.days / 30, 2) else 0 end as hours_worked
        from public.employees e
        join public.job_categories c on c.id = e.category_id
        join public.labor_agreements a on a.id = c.agreement_id
        -- Quien ingresó en el mes cobra desde su ingreso (mes comercial de 30 días); por hora,
        -- la parte de un mes completo de horas.
        cross join lateral (
          select case when to_char(e.hire_date, 'YYYY-MM') = v_period
                   then 31 - least(extract(day from e.hire_date)::int, 30) else 30 end as days
        ) as m
       where e.company_id = p_company_id and e.status = 'ACTIVO' and e.hire_date <= v_end
    ) as x
    cross join lateral (
      select private.payroll_amounts(
               v_rates || jsonb_build_object('seniority_pct', x.seniority_pct, 'attendance_pct', x.attendance_pct,
                                             'union_pct', x.union_pct, 'union_employer_pct', x.union_employer_pct),
               x.pay_basis, x.basic_salary, x.years, x.days_worked, x.hours_worked, 0, 0, 0) as a
    ) as y;
  perform private.payroll_set_totals(v_doc.id);
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'payroll', v_doc.id, v_doc.display_number,
    format('Creó %s: sueldos de %s (%s empleado%s)', v_doc.display_number, private.period_label(v_period), v_count,
           case when v_count > 1 then 's' else '' end),
    v_doc.id, null, 'BORRADOR');
  perform private.open_tasks_for_status(v_doc.id, v_actor);
  return private.created_result(v_doc.id);
end;
$$;

-- Igual que antes; quien cobra por hora informa las horas trabajadas (los días no cuentan)
-- y las ausencias sin aviso, que le hacen perder el presentismo (cmdUpdatePayrollLines).
-- p_lines: [{line_id, days_worked, hours_worked, absence_days, overtime_50, overtime_100}]
create or replace function public.payroll_update_lines(p_document_id uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_rates jsonb;
  v_line jsonb;
  v_l public.payroll_lines;
  v_seen uuid[] := '{}';
  v_who text;
  v_days numeric;
  v_hours numeric;
  v_absences numeric;
  v_overtime_50 numeric;
  v_overtime_100 numeric;
  v_hourly boolean;
  v_a jsonb;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  v_actor := private.require_permission(v_doc.company_id, 'payroll.create');
  if v_doc.status <> 'BORRADOR' then
    perform private.raise_business_error('TRANSICION_INVALIDA', 'Sólo se cambian las novedades de una liquidación en borrador.');
  end if;
  select p.rates into v_rates from public.payrolls p where p.document_id = v_doc.id;
  -- Primero se controla todo; después se recalcula.
  for v_line in select l from jsonb_array_elements(coalesce(p_lines, '[]')) as l loop
    select * into v_l from public.payroll_lines x where x.id::text = v_line ->> 'line_id' and x.document_id = v_doc.id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'Uno de los empleados no es de la liquidación.');
    end if;
    if v_l.id = any (v_seen) then
      perform private.raise_business_error('DATO_INVALIDO', 'Un empleado está dos veces: indicá sus novedades una sola vez.');
    end if;
    v_seen := v_seen || v_l.id;
    select e.last_name || ', ' || e.first_name into v_who from public.employees e where e.id = v_l.employee_id;
    v_absences := (v_line ->> 'absence_days')::numeric;
    if v_l.pay_basis = 'HOURLY' then
      v_hours := (v_line ->> 'hours_worked')::numeric;
      if v_hours is null or v_hours < 0 or v_hours > 300 or round(v_hours, 2) <> v_hours then
        perform private.raise_business_error('DATO_INVALIDO',
          format('Las horas trabajadas de %s van de 0 a 300, con hasta 2 decimales.', v_who));
      end if;
      if v_absences is null or v_absences <> trunc(v_absences) or v_absences < 0 or v_absences > 30 then
        perform private.raise_business_error('DATO_INVALIDO',
          format('Las ausencias sin aviso de %s son un entero de 0 a 30.', v_who));
      end if;
    else
      v_days := (v_line ->> 'days_worked')::numeric;
      if v_days is null or v_absences is null or v_days <> trunc(v_days) or v_absences <> trunc(v_absences)
         or v_days < 0 or v_days > 30 or v_absences < 0 or v_absences > 30 or v_days + v_absences > 30 then
        perform private.raise_business_error('DATO_INVALIDO',
          format('Los días trabajados y las ausencias de %s son enteros que juntos no pasan de 30.', v_who));
      end if;
    end if;
    v_overtime_50 := (v_line ->> 'overtime_50')::numeric;
    v_overtime_100 := (v_line ->> 'overtime_100')::numeric;
    if v_overtime_50 is null or v_overtime_100 is null or v_overtime_50 < 0 or v_overtime_50 > 200
       or v_overtime_100 < 0 or v_overtime_100 > 200 or round(v_overtime_50, 2) <> v_overtime_50
       or round(v_overtime_100, 2) <> v_overtime_100 then
      perform private.raise_business_error('DATO_INVALIDO',
        format('Las horas extra de %s van de 0 a 200, con hasta 2 decimales.', v_who));
    end if;
  end loop;
  for v_line in select l from jsonb_array_elements(coalesce(p_lines, '[]')) as l loop
    select * into v_l from public.payroll_lines x where x.id::text = v_line ->> 'line_id';
    v_hourly := v_l.pay_basis = 'HOURLY';
    v_days := case when v_hourly then 0 else (v_line ->> 'days_worked')::int end;
    v_hours := case when v_hourly then (v_line ->> 'hours_worked')::numeric else 0 end;
    v_a := private.payroll_amounts(private.payroll_line_rates(v_rates, v_l), v_l.pay_basis, v_l.basic_salary,
                                   v_l.seniority_years, v_days::int, v_hours, (v_line ->> 'absence_days')::int,
                                   (v_line ->> 'overtime_50')::numeric, (v_line ->> 'overtime_100')::numeric);
    update public.payroll_lines
       set days_worked = v_days::int, hours_worked = v_hours, absence_days = (v_line ->> 'absence_days')::int,
           overtime_50 = (v_line ->> 'overtime_50')::numeric, overtime_100 = (v_line ->> 'overtime_100')::numeric,
           basic = (v_a ->> 'basic')::numeric, seniority = (v_a ->> 'seniority')::numeric,
           attendance = (v_a ->> 'attendance')::numeric, overtime = (v_a ->> 'overtime')::numeric,
           gross = (v_a ->> 'gross')::numeric, retirement = (v_a ->> 'retirement')::numeric,
           pami = (v_a ->> 'pami')::numeric, health = (v_a ->> 'health')::numeric,
           union_dues = (v_a ->> 'union_dues')::numeric, deductions = (v_a ->> 'deductions')::numeric,
           net = (v_a ->> 'net')::numeric, employer = (v_a ->> 'employer')::numeric,
           union_contribution = (v_a ->> 'union_contribution')::numeric
     where id = v_l.id;
  end loop;
  perform private.payroll_set_totals(v_doc.id);
  perform private.log_audit(v_doc.company_id, v_actor, 'UPDATE', 'payroll', v_doc.id, v_doc.display_number,
    format('Cambió las novedades de %s', v_doc.display_number), v_doc.id);
end;
$$;

-- Igual que antes, y además lo del sindicato: las contribuciones de los convenios se suman
-- a las de la empresa y lo retenido y lo contribuido al sindicato va a Sindicatos a pagar
-- (cmdConfirmPayroll).
create or replace function public.payroll_confirm(p_document_id uuid)
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
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  perform private.require_transition(v_doc, 'CONFIRM');
  perform private.require_permission(v_doc.company_id, 'payroll.create');
  select * into v_p from public.payrolls p where p.document_id = v_doc.id;
  select count(*) as n,
         coalesce(round(sum(l.gross), 2), 0) as gross,
         coalesce(round(sum(l.net), 2), 0) as net,
         coalesce(round(sum(l.deductions - l.union_dues + l.employer), 2), 0) as charges,
         coalesce(round(sum(l.union_dues + l.union_contribution), 2), 0) as unions,
         coalesce(round(sum(l.gross) filter (where not l.is_direct_labor), 2), 0) as others_gross,
         coalesce(round(sum(l.employer + l.union_contribution) filter (where not l.is_direct_labor), 2), 0)
           as others_employer,
         coalesce(round(sum(l.gross + l.employer + l.union_contribution) filter (where l.is_direct_labor), 2), 0) as direct
    into v_t
    from public.payroll_lines l where l.document_id = v_doc.id;
  if v_t.gross <= 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'La liquidación no tiene importes: revisá los días trabajados.');
  end if;
  v_actor := private.transition_document(v_doc.id, 'CONFIRM',
    p_summary => format('Confirmó %s: sueldos de %s, %s netos a pagar', v_doc.display_number,
                        private.period_label(v_p.period), private.format_money(v_doc.total)));
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

-- Las cargas sociales de una liquidación: los aportes retenidos más las contribuciones, con
-- lo de los sindicatos (payrollCharges).
create or replace function private.payroll_charges(p_doc uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(round(sum(l.deductions + l.employer + l.union_contribution), 2), 0)
    from public.payroll_lines l where l.document_id = p_doc
$$;

-- Igual que antes; las cargas sociales incluyen lo de los sindicatos, que se paga con ellas:
-- el asiento cancela Cargas sociales a pagar y Sindicatos a pagar (payPayroll).
create or replace function private.payroll_pay(p_document_id uuid, p_account_id uuid, p_salaries boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_actor private.actor;
  v_p public.payrolls;
  v_account public.accounts;
  v_amount numeric;
  v_balance numeric;
  v_period text;
  v_count int;
  v_legal numeric;
  v_unions numeric;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'PAYROLL');
  perform private.require_transition(v_doc, 'PAY');
  v_actor := private.require_permission(v_doc.company_id, 'payroll.pay');
  if p_salaries and v_doc.status <> 'CONFIRMADA' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('Los sueldos de %s ya están pagados: faltan las cargas sociales.', v_doc.display_number));
  end if;
  if not p_salaries and v_doc.status <> 'SUELDOS_PAGADOS' then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('Primero se pagan los sueldos de %s; después, sus cargas sociales.', v_doc.display_number));
  end if;
  if coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = v_doc.company_id), true)
     and not private.is_supervisor(v_doc.company_id)
     and (select auth.uid()) = any (private.payroll_liquidators(v_doc)) then
    perform private.raise_business_error('SEPARACION_FUNCIONES',
      format('No podés pagar %s: la liquidaste vos.', v_doc.display_number),
      'Separación de funciones: quien liquida los sueldos no los paga. Tiene que pagarlos otro integrante de Tesorería.');
  end if;
  v_account := private.treasury_account(v_doc.company_id, p_account_id::text);
  v_amount := case when p_salaries then v_doc.total else private.payroll_charges(v_doc.id) end;
  v_balance := private.account_balance(v_account.id);
  select * into v_p from public.payrolls p where p.document_id = v_doc.id;
  v_period := private.period_label(v_p.period);
  if v_amount > v_balance + 0.000000001 then
    perform private.raise_business_error('SALDO_INSUFICIENTE',
      format('No alcanza el saldo de %s %s: hay %s y %s de %s son %s.', v_account.code, v_account.name,
             private.format_money(v_balance), case when p_salaries then 'los sueldos netos' else 'las cargas sociales' end,
             v_period, private.format_money(v_amount)),
      'Antes de pagar hay que controlar que haya fondos: el flujo de fondos proyectado lo anticipa.');
  end if;
  perform private.transition_document(v_doc.id, 'PAY', p_actor => v_actor,
    p_summary => format('Pagó %s de %s (%s): %s%s desde %s %s',
                        case when p_salaries then 'los sueldos' else 'las cargas sociales' end, v_period,
                        v_doc.display_number, private.format_money(v_amount),
                        case when p_salaries then ' netos' else '' end, v_account.code, v_account.name));
  if p_salaries then
    update public.payrolls
       set salaries_paid_on = private.business_date(v_doc.company_id), salaries_account_id = v_account.id
     where document_id = v_doc.id;
  else
    update public.payrolls
       set charges_paid_on = private.business_date(v_doc.company_id), charges_account_id = v_account.id
     where document_id = v_doc.id;
  end if;
  select * into v_doc from public.documents d where d.id = v_doc.id;
  select count(*) into v_count from public.payroll_lines l where l.document_id = v_doc.id;
  select coalesce(round(sum(l.deductions - l.union_dues + l.employer), 2), 0),
         coalesce(round(sum(l.union_dues + l.union_contribution), 2), 0)
    into v_legal, v_unions
    from public.payroll_lines l where l.document_id = v_doc.id;
  if v_amount > 0 then
    perform private.post_event(v_actor, v_doc, case when p_salaries then 'PAGO_SUELDOS' else 'PAGO_CARGAS_SOCIALES' end,
      case when p_salaries
        then format('Pago de los sueldos de %s (%s): %s empleado%s.', v_period, v_doc.display_number, v_count,
                    case when v_count > 1 then 's' else '' end)
        else format('Pago de las cargas sociales de %s (%s): aportes retenidos y contribuciones.', v_period,
                    v_doc.display_number)
      end,
      case when p_salaries
        then jsonb_build_array(
          jsonb_build_object('key', 'SUELDOS_A_PAGAR', 'debit', v_amount, 'credit', 0),
          jsonb_build_object('account_id', v_account.id, 'debit', 0, 'credit', v_amount))
        else jsonb_build_array(
          jsonb_build_object('key', 'CARGAS_SOCIALES_A_PAGAR', 'debit', v_legal, 'credit', 0),
          jsonb_build_object('key', 'SINDICATOS_A_PAGAR', 'debit', v_unions, 'credit', 0),
          jsonb_build_object('account_id', v_account.id, 'debit', 0, 'credit', v_amount))
      end);
  end if;
end;
$$;

-- ------------------------------------------------------------------ Lecturas de la liquidación

-- Igual que antes, y además lo del sindicato (en los totales, en el costo y en las cargas)
-- y, en cada línea, el convenio que copió, sus porcentajes y las horas (payrollView).
create or replace function private.payroll_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'period', p.period, 'payment_date', p.payment_date, 'confirmed_at', p.confirmed_at, 'rates', p.rates,
    'gross', t.gross, 'deductions', t.deductions, 'net', t.net, 'employer', t.employer,
    'union_dues', t.union_dues, 'union_contribution', t.union_contribution, 'cost', t.cost,
    'direct_labor', t.direct_labor,
    'charges', t.charges, 'charges_due', private.payroll_charges_due(p.period),
    'salaries_paid_on', p.salaries_paid_on,
    'salaries_account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name)
                           from public.accounts a where a.id = p.salaries_account_id),
    'charges_paid_on', p.charges_paid_on,
    'charges_account', (select jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name)
                          from public.accounts a where a.id = p.charges_account_id),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no,
               'employee', jsonb_build_object('id', e.id, 'file_number', e.file_number, 'first_name', e.first_name,
                                              'last_name', e.last_name, 'hire_date', e.hire_date),
               'category', jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name),
               'sector', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name),
               'work_center', case when w.id is null then null
                                   else jsonb_build_object('id', w.id, 'code', w.code, 'name', w.name) end,
               'agreement', case when g.id is null then null
                                 else jsonb_build_object('id', g.id, 'code', g.code, 'name', g.name,
                                                         'union_name', g.union_name) end,
               'pay_basis', l.pay_basis, 'seniority_pct', l.seniority_pct, 'attendance_pct', l.attendance_pct,
               'union_pct', l.union_pct, 'union_employer_pct', l.union_employer_pct,
               'basic_salary', l.basic_salary, 'seniority_years', l.seniority_years, 'is_direct_labor', l.is_direct_labor,
               'days_worked', l.days_worked, 'hours_worked', l.hours_worked, 'absence_days', l.absence_days,
               'overtime_50', l.overtime_50, 'overtime_100', l.overtime_100, 'basic', l.basic, 'seniority', l.seniority,
               'attendance', l.attendance, 'overtime', l.overtime, 'gross', l.gross, 'retirement', l.retirement,
               'pami', l.pami, 'health', l.health, 'union_dues', l.union_dues, 'deductions', l.deductions, 'net', l.net,
               'employer', l.employer, 'union_contribution', l.union_contribution)
             order by l.line_no)
        from public.payroll_lines l
        join public.employees e on e.id = l.employee_id
        join public.job_categories c on c.id = l.category_id
        join public.sectors s on s.id = e.sector_id
        left join public.work_centers w on w.id = l.work_center_id
        left join public.labor_agreements g on g.id = l.agreement_id
       where l.document_id = p.document_id), '[]'))
    from public.payrolls p
    cross join lateral (
      select coalesce(round(sum(x.gross), 2), 0) as gross,
             coalesce(round(sum(x.deductions), 2), 0) as deductions,
             coalesce(round(sum(x.net), 2), 0) as net,
             coalesce(round(sum(x.employer), 2), 0) as employer,
             coalesce(round(sum(x.union_dues), 2), 0) as union_dues,
             coalesce(round(sum(x.union_contribution), 2), 0) as union_contribution,
             coalesce(round(sum(x.gross + x.employer + x.union_contribution), 2), 0) as cost,
             coalesce(round(sum(x.gross + x.employer + x.union_contribution) filter (where x.is_direct_labor), 2), 0)
               as direct_labor,
             coalesce(round(sum(x.deductions + x.employer + x.union_contribution), 2), 0) as charges
        from public.payroll_lines x where x.document_id = p.document_id
    ) as t
   where p.document_id = p_doc.id
$$;

-- Igual que antes; la mano de obra real incluye la contribución de los convenios (laborVariance).
create or replace function public.labor_variance(p_company_id uuid, p_period text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payroll public.documents;
begin
  perform private.require_read(p_company_id, 'payroll.read');
  if coalesce(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El período es un mes: aaaa-mm.');
  end if;
  select d.* into v_payroll
    from public.documents d join public.payrolls p on p.document_id = d.id
   where d.company_id = p_company_id and d.status <> 'ANULADA' and p.period = p_period
   order by d.number
   limit 1;
  return (
    with staff as (
      select l.work_center_id, l.gross + l.employer + l.union_contribution as cost
        from public.payroll_lines l
       where v_payroll.id is not null and v_payroll.status <> 'BORRADOR'
         and l.document_id = v_payroll.id and l.is_direct_labor
    ),
    orders as (
      select d.id, d.display_number, d.number
        from public.documents d
       where d.company_id = p_company_id and d.doc_type = 'PRODUCTION_ORDER' and d.status = 'TERMINADA'
         and to_char((select m.movement_date from public.stock_movements m
                       where m.document_id = d.id and m.movement_type = 'INGRESO_PRODUCCION'
                       order by m.id limit 1), 'YYYY-MM') = p_period
    ),
    ops as (
      select o.work_center_id, coalesce(o.hours_actual, o.hours_planned) as hours,
             round(coalesce(o.hours_actual, o.hours_planned) * o.labor_rate, 2) as applied
        from public.production_order_operations o join orders x on x.id = o.document_id
    ),
    centers as (
      select s.work_center_id from staff s
      union
      select o.work_center_id from ops o
    ),
    rows as (
      select c.work_center_id, w.code, w.name, w.labor_rate,
             coalesce((select round(sum(o.hours), 3) from ops o
                        where o.work_center_id is not distinct from c.work_center_id), 0) as hours,
             coalesce((select round(sum(o.applied), 2) from ops o
                        where o.work_center_id is not distinct from c.work_center_id), 0) as applied,
             coalesce((select round(sum(s.cost), 2) from staff s
                        where s.work_center_id is not distinct from c.work_center_id), 0) as real,
             (select count(*) from staff s where s.work_center_id is not distinct from c.work_center_id) as employees
        from centers c left join public.work_centers w on w.id = c.work_center_id
    )
    select jsonb_build_object(
      'period', p_period,
      'payroll', case when v_payroll.id is null then null else jsonb_build_object(
        'id', v_payroll.id, 'display_number', v_payroll.display_number, 'path', private.doc_path(v_payroll.id),
        'status_info', private.status_info(v_payroll.doc_type, v_payroll.status)) end,
      'orders', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'display_number', x.display_number, 'path', private.doc_path(x.id))
                         order by x.number)
          from orders x), '[]'),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'work_center', case when r.work_center_id is null then null else jsonb_build_object(
                   'id', r.work_center_id, 'code', r.code, 'name', r.name, 'labor_rate', r.labor_rate) end,
                 'hours', r.hours, 'applied', r.applied, 'real', r.real, 'employees', r.employees,
                 'difference', r.applied - r.real)
               order by r.code collate "C" nulls last)
          from rows r), '[]'),
      'hours', coalesce((select sum(r.hours) from rows r), 0),
      'applied', coalesce((select sum(r.applied) from rows r), 0),
      'real', coalesce((select sum(r.real) from rows r), 0),
      'difference', coalesce((select sum(r.applied) - sum(r.real) from rows r), 0))
  );
end;
$$;

-- ------------------------------------------------------------------ Lecturas comunes, con lo de los sindicatos

-- Igual que antes; quien cobra por hora informa las horas trabajadas y las cargas sociales a
-- pagar incluyen lo de los sindicatos (nextStep).
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
        'text', 'Cargar las novedades del mes de cada empleado (los días o las horas trabajadas, las ausencias sin aviso y las horas extra), revisar los recibos y confirmar la liquidación: se registra el asiento de sueldos.');
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
