-- 12. Empresas a partir de la plantilla (DATABASE.md §12; MVP.md, H-20).
-- Equivale a cmdCreateCompanyFromTemplate: copia la estructura (islas,
-- sectores, depósitos, reglas de aprobación, módulos y control interno) y los
-- maestros (proveedores, clientes, productos), no copia personas ni
-- operaciones (la numeración empieza en 1), vuelve a cargar el inventario
-- inicial de la plantilla con su documento y sus alertas, y deja como
-- supervisor al docente que la crea.

-- "Forestal del Norte 5.º A 2027" → "forestal-del-norte-5-a-2027". Primero se
-- quitan los acentos (en mayúsculas y minúsculas): lower() sólo convierte ASCII
-- si la base usa la intercalación "C".
create function private.slugify(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(both '-' from regexp_replace(
    lower(translate(p_text, 'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇáàäâãéèëêíìïîóòöôõúùüûñç',
                            'AAAAAEEEEIIIIOOOOOUUUUNCaaaaaeeeeiiiiooooouuuunc')),
    '[^a-z0-9]+', '-', 'g'))
$$;

create function private.unique_slug(p_base text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_n int := 2;
begin
  if not exists (select 1 from public.companies c where c.slug = p_base) then
    return p_base;
  end if;
  while exists (select 1 from public.companies c where c.slug = p_base || '-' || v_n) loop
    v_n := v_n + 1;
  end loop;
  return p_base || '-' || v_n;
end;
$$;

create function private.clone_company(p_template uuid, p_course uuid, p_slug text, p_owner uuid)
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

  if p_owner is not null then
    insert into public.company_members (company_id, user_id, job_title)
    values (v_id, p_owner, 'Docente a cargo') returning id into v_member;
    insert into public.member_roles (company_id, member_id, role_code) values (v_id, v_member, 'DOCENTE');
  end if;
  return v_id;
end;
$$;

-- Inventario inicial: los mismos ajustes de "Inventario inicial" que tuvo la
-- plantilla, cargados por el sistema con su documento, y las alertas de arranque.
create function private.copy_initial_stock(p_template uuid, p_company uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_adjustment record;
begin
  for v_adjustment in
    select d.id, w.code as warehouse_code
      from public.documents d
      join public.stock_adjustments sa on sa.document_id = d.id
      join public.warehouses w on w.id = sa.warehouse_id
     where d.company_id = p_template and d.doc_type = 'STOCK_ADJUSTMENT' and d.status = 'CONFIRMADO'
       and sa.reason_code = 'INVENTARIO_INICIAL'
     order by d.number
  loop
    perform private.post_initial_stock(
      p_company,
      (select w.id from public.warehouses w where w.company_id = p_company and w.code = v_adjustment.warehouse_code),
      (select coalesce(jsonb_agg(jsonb_build_object('product_id', np.id, 'quantity_delta', l.quantity_delta, 'unit_cost', l.unit_cost)
                                 order by l.line_no), '[]'::jsonb)
         from public.stock_adjustment_lines l
         join public.products op on op.id = l.product_id
         join public.products np on np.company_id = p_company and np.code = op.code
        where l.document_id = v_adjustment.id and l.quantity_delta > 0)
    );
  end loop;
  perform private.scan_stock_alerts(p_company);
end;
$$;

-- El docente crea la empresa de su curso (sólo DOCENTE o SUPERADMIN: ni
-- estudiantes ni la administración escolar, que no opera dentro de las empresas).
create function public.company_create_from_template(p_course_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
  v_template public.companies;
  v_course public.courses;
  v_id uuid;
  v_slug text;
begin
  if private.current_app_role() not in ('DOCENTE', 'SUPERADMIN') then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo un docente puede crear la empresa simulada de su curso.');
  end if;
  select * into v_template from public.companies c where c.is_template and c.status = 'ACTIVA' order by c.created_at limit 1;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'No hay una empresa plantilla disponible.');
  end if;
  select * into v_course from public.courses c where c.id = p_course_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el curso para el que se crea la empresa.');
  end if;
  v_slug := private.unique_slug(private.slugify(format('%s %s %s', v_template.trade_name, v_course.name, v_course.academic_year)));
  v_id := private.clone_company(v_template.id, v_course.id, v_slug, v_uid);
  perform private.log_audit(v_id, private.actor_for(v_id), 'CREATE', 'company', v_id, v_template.legal_name,
    format('Creó la empresa para %s %s a partir de la plantilla %s', v_course.name, v_course.academic_year, v_template.legal_name));
  perform private.copy_initial_stock(v_template.id, v_id);
  return jsonb_build_object('id', v_id, 'slug', v_slug);
end;
$$;
grant execute on function public.company_create_from_template(uuid) to authenticated;
