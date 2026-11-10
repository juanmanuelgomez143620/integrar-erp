-- 94. Fase 8d.1 (docs/FASE_8_BANCO_Y_FISCO.md §4): el padrón del fisco simulado. Cada empresa del aula
-- tiene el suyo: la empresa y sus proveedores y clientes con un CUIT válido. Lo opera Impuestos
-- (fisco.operate): da de alta, modifica y da de baja, sin borrar. La letra de la factura de venta
-- sale de la condición del cliente en el padrón; si su CUIT no está activo, de su ficha. De paso,
-- dos CUIT de la demo que tenían el dígito verificador mal calculado (daba 10) pasan al prefijo 33,
-- como el oficial. Traducción de la sección "Fisco simulado" de engine.ts (8d.1).
--
-- El módulo y los permisos están en la migración de catálogos siguiente; la plantilla, en la de la
-- plantilla; las empresas que ya existían reciben su padrón en la última de esta fase.

-- ------------------------------------------------------------------ Tablas

create table public.taxpayers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  cuit text not null check (cuit ~ '^[0-9]{2}-[0-9]{8}-[0-9]$'),
  legal_name text not null check (length(legal_name) between 2 and 80),
  vat_condition text not null check (vat_condition in ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL')),
  activity text not null default '' check (length(activity) <= 120),
  province text not null default '' check (length(province) <= 60),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  unique (company_id, cuit),
  unique (company_id, id)
);

create trigger taxpayers_audit before insert or update on public.taxpayers
  for each row execute function private.set_audit_fields();
create trigger taxpayers_same_company before update on public.taxpayers
  for each row execute function private.prevent_company_change();
alter table public.taxpayers enable row level security;
revoke all on table public.taxpayers from anon, authenticated;
grant select on table public.taxpayers to authenticated;
create policy taxpayers_select on public.taxpayers for select to authenticated
  using (company_id in (select private.companies_with_permission('fisco.read')));

-- Los dos CUIT de la demo con el dígito mal calculado, en todas las empresas (UPGRADES[27]).
update public.suppliers set tax_id = '33-00000102-9' where tax_id = '30-00000102-9';
update public.customers set tax_id = '33-00000200-9' where tax_id = '30-00000200-9';

-- ------------------------------------------------------------------ Auxiliares

-- Si el CUIT tiene el formato 30-12345678-9 y su dígito verificador coincide, como el oficial: los
-- pesos 5, 4, 3, 2, 7, 6, 5, 4, 3, 2; si da 11 vale 0 y si da 10 no es válido (cuitIsValid).
create function private.cuit_is_valid(p_cuit text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_cuit, '') ~ '^[0-9]{2}-[0-9]{8}-[0-9]$'
     and (select case when 11 - s % 11 = 11 then 0 else 11 - s % 11 end
            from (select sum(substr(d, i, 1)::int * (array[5, 4, 3, 2, 7, 6, 5, 4, 3, 2])[i]) as s
                    from (select replace(p_cuit, '-', '') as d) x, generate_series(1, 10) as i
                   group by d) y) = substr(p_cuit, 13, 1)::int
$$;

-- El padrón de la empresa: la empresa y sus proveedores y clientes con un CUIT válido, sin repetir
-- CUIT (el primero: la empresa, después los proveedores y los clientes por código). Idempotente
-- (insertPadron).
create function private.insert_padron(p_company uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.taxpayers (company_id, cuit, legal_name, vat_condition, activity, province)
  select p_company, r.cuit, r.legal_name, r.vat_condition, r.activity, r.province
    from (
      select distinct on (x.cuit) x.*
        from (
          select 0 as ord, ''::text as code, c.tax_id as cuit, c.legal_name, c.vat_condition, c.activity, c.province
            from public.companies c where c.id = p_company
          union all
          select 1, s.code, s.tax_id, s.legal_name, s.vat_condition, s.category, s.province
            from public.suppliers s where s.company_id = p_company
          union all
          select 2, cu.code, cu.tax_id, cu.legal_name, cu.vat_condition, '', cu.province
            from public.customers cu where cu.company_id = p_company
        ) x
       where private.cuit_is_valid(x.cuit)
       order by x.cuit, x.ord, x.code collate "C"
    ) r
   where not exists (select 1 from public.taxpayers t where t.company_id = p_company and t.cuit = r.cuit)
$$;

-- La condición frente al IVA de un CUIT en el padrón, si está activo; null si no está (padronCondition).
create function private.padron_condition(p_company uuid, p_cuit text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select t.vat_condition from public.taxpayers t
   where t.company_id = p_company and t.cuit = p_cuit and t.is_active and coalesce(p_cuit, '') <> ''
$$;

-- "Carpintería del Litoral SRL (CUIT 30-00000900-1)" (taxpayerLabel).
create function private.taxpayer_label(p_t public.taxpayers)
returns text
language sql
immutable
set search_path = ''
as $$ select p_t.legal_name || ' (CUIT ' || p_t.cuit || ')' $$;

-- ------------------------------------------------------------------ Comandos

-- Quien opera el fisco (Impuestos) da de alta o modifica un contribuyente: el CUIT con dígito
-- verificador válido y sin repetir, que no cambia después del alta (cmdSaveTaxpayer).
create function public.taxpayer_save(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'fisco.operate');
  v_id text := coalesce(p_input ->> 'id', '');
  v_existing public.taxpayers;
  v_cuit text;
  v_legal_name text := btrim(coalesce(p_input ->> 'legal_name', ''));
  v_condition text := coalesce(p_input ->> 'vat_condition', '');
  v_activity text := btrim(coalesce(p_input ->> 'activity', ''));
  v_province text := btrim(coalesce(p_input ->> 'province', ''));
  v_row public.taxpayers;
  v_changes jsonb;
begin
  if v_id <> '' then
    select * into v_existing from public.taxpayers t where t.id::text = v_id and t.company_id = p_company_id;
    if not found then
      perform private.raise_business_error('DATO_INVALIDO', 'El contribuyente no está en el padrón.');
    end if;
    v_cuit := v_existing.cuit;
  else
    v_cuit := btrim(coalesce(p_input ->> 'cuit', ''));
    if not private.cuit_is_valid(v_cuit) then
      perform private.raise_business_error('DATO_INVALIDO',
        'El CUIT no es válido: tiene el formato 30-12345678-9 y el último número es el dígito verificador.');
    end if;
    if exists (select 1 from public.taxpayers t where t.company_id = p_company_id and t.cuit = v_cuit) then
      perform private.raise_business_error('DATO_INVALIDO', format('El CUIT %s ya está en el padrón.', v_cuit));
    end if;
  end if;
  if length(v_legal_name) < 2 or length(v_legal_name) > 80 then
    perform private.raise_business_error('DATO_INVALIDO', 'La razón social tiene de 2 a 80 caracteres.');
  end if;
  if v_condition not in ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí una condición frente al IVA válida.');
  end if;
  if length(v_activity) > 120 then
    perform private.raise_business_error('DATO_INVALIDO', 'La actividad tiene hasta 120 caracteres.');
  end if;
  if length(v_province) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'La provincia tiene hasta 60 caracteres.');
  end if;
  if v_existing.id is not null then
    v_changes := private.diff(to_jsonb(v_existing),
      to_jsonb(v_existing) || jsonb_build_object('legal_name', v_legal_name, 'vat_condition', v_condition,
                                                 'activity', v_activity, 'province', v_province),
      array['legal_name', 'vat_condition', 'activity', 'province']);
    if v_changes = '{}'::jsonb then
      return jsonb_build_object('id', v_existing.id);
    end if;
    update public.taxpayers
       set legal_name = v_legal_name, vat_condition = v_condition, activity = v_activity, province = v_province
     where id = v_existing.id
    returning * into v_row;
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'taxpayer', v_row.id, private.taxpayer_label(v_row),
      'Modificó en el padrón a ' || private.taxpayer_label(v_row), null, null, null, v_changes);
    return jsonb_build_object('id', v_row.id);
  end if;
  insert into public.taxpayers (company_id, cuit, legal_name, vat_condition, activity, province)
  values (p_company_id, v_cuit, v_legal_name, v_condition, v_activity, v_province)
  returning * into v_row;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'taxpayer', v_row.id, private.taxpayer_label(v_row),
    format('Dio de alta en el padrón a %s: %s', private.taxpayer_label(v_row),
           case v_condition when 'RESPONSABLE_INSCRIPTO' then 'responsable inscripto' when 'MONOTRIBUTO' then 'monotributo'
                            when 'EXENTO' then 'exento' else 'consumidor final' end));
  return jsonb_build_object('id', v_row.id);
end;
$$;

-- El fisco da de baja (o vuelve a dar de alta) a un contribuyente: dado de baja, no cuenta para la
-- letra (cmdSetTaxpayerActive).
create function public.taxpayer_set_active(p_company_id uuid, p_taxpayer_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'fisco.operate');
  v_row public.taxpayers;
begin
  select * into v_row from public.taxpayers t where t.id = p_taxpayer_id and t.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'El contribuyente no está en el padrón.');
  end if;
  if p_active is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si el contribuyente está activo.');
  end if;
  if v_row.is_active = p_active then
    return;
  end if;
  update public.taxpayers set is_active = p_active where id = v_row.id returning * into v_row;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, 'taxpayer',
    v_row.id, private.taxpayer_label(v_row),
    case when p_active then 'Volvió a dar de alta en el padrón a ' else 'Dio de baja del padrón a ' end
      || private.taxpayer_label(v_row));
end;
$$;

-- ------------------------------------------------------------------ Lecturas

-- El padrón del fisco de la empresa, por CUIT (padron).
create function public.padron(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tax_id text;
begin
  perform private.require_read(p_company_id, 'fisco.read');
  select c.tax_id into v_tax_id from public.companies c where c.id = p_company_id;
  return coalesce((
    select jsonb_agg(to_jsonb(t) || jsonb_build_object('is_company', t.cuit = v_tax_id) order by t.cuit collate "C")
      from public.taxpayers t where t.company_id = p_company_id), '[]'::jsonb);
end;
$$;

grant execute on function public.taxpayer_save(uuid, jsonb) to authenticated;
grant execute on function public.taxpayer_set_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.padron(uuid) to authenticated;

-- ------------------------------------------------------------------ Versiones nuevas

-- Igual que antes, salvo que la condición del cliente sale del padrón si su CUIT está activo
-- (salesLetter).
create or replace function private.sales_letter(p_company uuid, p_customer uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when co.vat_condition <> 'RESPONSABLE_INSCRIPTO' then 'C'
           when coalesce(private.padron_condition(co.id, cu.tax_id), cu.vat_condition)
                in ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO') then 'A'
           else 'B'
         end
    from public.companies co, public.customers cu
   where co.id = p_company and cu.id = p_customer
$$;

-- Igual que antes, y además de dónde sale la condición del cliente y su CUIT (invoiceableSalesOrders).
create or replace function public.sales_orders_invoiceable(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'sales_invoice.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object('order', private.document_item(d),
                                        'letter', private.sales_letter(p_company_id, d.customer_id),
                                        'letter_source', case when private.padron_condition(p_company_id, cu.tax_id) is not null
                                                              then 'PADRON' else 'FICHA' end,
                                        'customer_cuit', cu.tax_id, 'lines', o.lines)
                     order by d.number)
      from public.documents d
      join public.customers cu on cu.id = d.customer_id
      cross join lateral (
        select jsonb_agg(jsonb_build_object('line', to_jsonb(sl), 'product', to_jsonb(p), 'invoiced', x.invoiced,
                                            'pending', round(sl.qty_delivered - x.invoiced, 3))
                         order by sl.line_no) as lines
          from public.sales_order_lines sl
          join public.products p on p.id = sl.product_id
          cross join lateral (select private.sales_invoiced_quantity(sl.id) as invoiced) as x
         where sl.document_id = d.id and round(sl.qty_delivered - x.invoiced, 3) > 0.000000001
      ) as o
     where d.company_id = p_company_id and d.doc_type = 'SALES_ORDER'
       and d.status in ('ENTREGADO_PARCIAL', 'ENTREGADO', 'CERRADO') and o.lines is not null
  ), '[]');
end;
$$;

-- Igual que antes, y además la empresa nueva recibe su padrón (cmdCreateCompanyFromTemplate).
create or replace function public.company_create_from_template(p_course_id uuid)
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
  perform private.start_accounting(v_id);
  perform private.bank_open_account(v_id);
  perform private.insert_padron(v_id);
  return jsonb_build_object('id', v_id, 'slug', v_slug);
end;
$$;
