-- 8. RPC del núcleo: contexto de sesión y de empresa, maestros, panel docente
-- y administración escolar. Cada función equivale a un comando o consulta del
-- motor simulado (ARCHITECTURE.md §7.9), con los mismos códigos de error.

-- ------------------------------------------------------------------ Lecturas de contexto

-- Lo único de la escuela que se muestra antes de ingresar.
create function public.public_school_info()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('official_name', s.official_name, 'short_name', s.short_name)
    from public.school_settings s where s.id = 1
$$;
grant execute on function public.public_school_info() to anon, authenticated;

create function private.school_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'official_name', s.official_name, 'short_name', s.short_name, 'city', s.city, 'province', s.province,
    'contact_email', s.contact_email, 'session_timeout_minutes', s.session_timeout_minutes, 'features', s.features
  )
    from public.school_settings s where s.id = 1
$$;

create function private.public_profile_json(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'username', p.username, 'first_name', p.first_name, 'last_name', p.last_name,
    'app_role', p.app_role, 'is_active', p.is_active, 'must_change_password', p.must_change_password,
    'created_at', p.created_at
  )
    from public.profiles p where p.id = p_user
$$;

-- Mis roles en una empresa, con sector e isla (para el contexto y el menú).
create function private.member_roles_json(p_company uuid, p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', mr.id,
    'role_code', mr.role_code,
    'role_name', r.name,
    'sector_id', mr.sector_id,
    'sector_name', coalesce(s.name, '—'),
    'island', i.number
  ) order by r.sort), '[]'::jsonb)
    from public.company_members m
    join public.member_roles mr on mr.company_id = m.company_id and mr.member_id = m.id
    join public.roles r on r.code = mr.role_code
    left join public.sectors s on s.company_id = mr.company_id and s.id = mr.sector_id
    left join public.islands i on i.company_id = s.company_id and i.id = s.island_id
   where m.company_id = p_company and m.user_id = p_user and m.is_active
$$;

-- Equivale a meContext: perfil, escuela y empresas donde participa.
create function public.my_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
begin
  return jsonb_build_object(
    'user', private.public_profile_json(v_uid),
    'school', private.school_json(),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'company', to_jsonb(c),
        'course', (select to_jsonb(co) from public.courses co where co.id = c.course_id),
        'roles', private.member_roles_json(c.id, v_uid)
      ) order by c.created_at)
        from public.companies c
       where private.is_superadmin()
          or exists (select 1 from public.company_members m
                      where m.company_id = c.id and m.user_id = v_uid and m.is_active)
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.my_context() to authenticated;

-- Permisos efectivos (sin supervisor; el supervisor tiene "all").
create function private.effective_permissions(p_company uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct rp.permission_code order by rp.permission_code), '{}')
    from private.my_role_codes(p_company) as rc (code)
    join public.role_permissions rp on rp.role_code = rc.code
    join public.permissions pe on pe.code = rp.permission_code
   where private.module_enabled(p_company, pe.module_code)
$$;

-- Equivale a companyContext: null si la empresa no existe o no participa en ella.
create function public.company_context(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
  v_company public.companies;
  v_supervisor boolean;
begin
  select * into v_company from public.companies c where c.slug = p_slug;
  if not found then
    return null;
  end if;
  v_supervisor := private.is_supervisor(v_company.id);
  if not v_supervisor and not exists (
    select 1 from public.company_members m where m.company_id = v_company.id and m.user_id = v_uid and m.is_active
  ) then
    return null;
  end if;
  return jsonb_build_object(
    'company', to_jsonb(v_company),
    'course', (select to_jsonb(co) from public.courses co where co.id = v_company.course_id),
    'sectors', coalesce((select jsonb_agg(to_jsonb(s) order by s.code) from public.sectors s where s.company_id = v_company.id), '[]'),
    'islands', coalesce((select jsonb_agg(to_jsonb(i) order by i.number) from public.islands i where i.company_id = v_company.id), '[]'),
    'warehouses', coalesce((select jsonb_agg(to_jsonb(w) order by w.code) from public.warehouses w where w.company_id = v_company.id), '[]'),
    'modules', coalesce((select jsonb_agg(to_jsonb(m) order by m.module_code) from public.company_modules m where m.company_id = v_company.id), '[]'),
    'approval_rules', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.min_amount)
        from public.approval_rules r where r.company_id = v_company.id and r.is_active
    ), '[]'),
    'roles', private.member_roles_json(v_company.id, v_uid),
    'permissions', to_jsonb(case when v_supervisor then '{}'::text[] else private.effective_permissions(v_company.id) end),
    'all', v_supervisor,
    'supervisor', v_supervisor
  );
end;
$$;
grant execute on function public.company_context(text) to authenticated;

-- ------------------------------------------------------------------ Maestros

-- Equivale a cmdSaveMaster: alta (sin id) o modificación (con id). Sólo se
-- aceptan las columnas editables de cada maestro; el resto se ignora.
create function public.master_save(p_kind text, p_company_id uuid, p_data jsonb)
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
                      'phone', 'email', 'contact_name', 'payment_terms_days', 'credit_limit', 'notes'];
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
grant execute on function public.master_save(text, uuid, jsonb) to authenticated;

-- Equivale a cmdSetMasterActive: los maestros se desactivan, nunca se borran.
create function public.master_set_active(p_kind text, p_company_id uuid, p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_label text;
  v_name_field text;
  v_actor private.actor;
  v_row jsonb;
  v_entity text;
begin
  case p_kind
    when 'customer' then v_table := 'customers'; v_label := 'cliente'; v_name_field := 'legal_name';
    when 'supplier' then v_table := 'suppliers'; v_label := 'proveedor'; v_name_field := 'legal_name';
    when 'product' then v_table := 'products'; v_label := 'producto'; v_name_field := 'name';
    else perform private.raise_business_error('DATO_INVALIDO', 'Tipo de maestro desconocido.');
  end case;
  v_actor := private.require_permission(p_company_id, p_kind || '.update');
  execute format('update public.%I t set is_active = $1 where t.id = $2 and t.company_id = $3 returning to_jsonb(t)', v_table)
     into v_row using p_active, p_id, p_company_id;
  if v_row is null then
    perform private.raise_business_error('DATO_INVALIDO', format('El %s no existe.', v_label));
  end if;
  v_entity := (v_row ->> 'code') || ' ' || (v_row ->> v_name_field);
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, p_kind, p_id,
    v_entity, format('%s el %s %s', case when p_active then 'Activó' else 'Desactivó' end, v_label, v_entity));
end;
$$;
grant execute on function public.master_set_active(text, uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------------ Panel docente

create function public.member_assign_role(p_company_id uuid, p_user_id uuid, p_role text, p_sector_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_member uuid;
begin
  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'El usuario no existe.');
  end if;
  if not exists (select 1 from public.roles r where r.code = p_role) then
    perform private.raise_business_error('DATO_INVALIDO', 'El rol no existe.');
  end if;
  if p_sector_id is not null and not exists (
    select 1 from public.sectors s where s.company_id = p_company_id and s.id = p_sector_id
  ) then
    perform private.raise_business_error('DATO_INVALIDO', 'El sector no existe en esta empresa.');
  end if;
  select m.id into v_member from public.company_members m where m.company_id = p_company_id and m.user_id = p_user_id;
  if v_member is null then
    insert into public.company_members (company_id, user_id) values (p_company_id, p_user_id) returning id into v_member;
  end if;
  if exists (
    select 1 from public.member_roles mr
     where mr.member_id = v_member and mr.role_code = p_role and mr.sector_id is not distinct from p_sector_id
  ) then
    perform private.raise_business_error('DATO_INVALIDO', 'Esa asignación ya existe.');
  end if;
  insert into public.member_roles (company_id, member_id, role_code, sector_id)
  values (p_company_id, v_member, p_role, p_sector_id);
  perform private.log_audit(p_company_id, v_actor, 'ASSIGN_ROLE', 'member_role', v_member, private.full_name(p_user_id),
    format('Asignó el rol %s (%s) a %s',
      (select r.name from public.roles r where r.code = p_role),
      coalesce((select s.name from public.sectors s where s.id = p_sector_id), '—'),
      private.full_name(p_user_id)));
end;
$$;
grant execute on function public.member_assign_role(uuid, uuid, text, uuid) to authenticated;

create function public.member_remove_role(p_company_id uuid, p_member_role_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_mr public.member_roles;
  v_user uuid;
begin
  select * into v_mr from public.member_roles mr where mr.id = p_member_role_id and mr.company_id = p_company_id;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La asignación no existe.');
  end if;
  select m.user_id into v_user from public.company_members m where m.id = v_mr.member_id;
  if v_mr.role_code = 'DOCENTE' and v_user = (select auth.uid()) then
    perform private.raise_business_error('DATO_INVALIDO', 'No podés quitarte tu propio rol de supervisor.');
  end if;
  delete from public.member_roles where id = p_member_role_id;
  perform private.log_audit(p_company_id, v_actor, 'REMOVE_ROLE', 'member_role', v_mr.member_id, private.full_name(v_user),
    format('Quitó el rol %s a %s', (select r.name from public.roles r where r.code = v_mr.role_code), private.full_name(v_user)));
end;
$$;
grant execute on function public.member_remove_role(uuid, uuid) to authenticated;

create function public.company_set_module(p_company_id uuid, p_module text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_name text;
begin
  select mo.name into v_name from public.modules mo where mo.code = p_module and mo.is_lockable;
  if v_name is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Ese módulo no se puede bloquear.');
  end if;
  insert into public.company_modules (company_id, module_code, is_enabled, updated_at, updated_by)
  values (p_company_id, p_module, p_enabled, now(), (select auth.uid()))
  on conflict (company_id, module_code) do update
    set is_enabled = excluded.is_enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  perform private.log_audit(p_company_id, v_actor, 'SETTINGS', 'company_module', p_company_id, v_name,
    format('%s el módulo %s', case when p_enabled then 'Habilitó' else 'Bloqueó' end, v_name));
end;
$$;
grant execute on function public.company_set_module(uuid, text, boolean) to authenticated;

-- Control interno: separación de funciones y stock negativo.
create function public.company_update_settings(p_company_id uuid, p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_before jsonb;
  v_after jsonb;
begin
  select c.settings into v_before from public.companies c where c.id = p_company_id for update;
  select v_before || coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_after
    from jsonb_each(p_settings)
   where key in ('sod_enabled', 'allow_negative_stock') and jsonb_typeof(value) = 'boolean';
  update public.companies set settings = v_after where id = p_company_id;
  perform private.log_audit(p_company_id, v_actor, 'SETTINGS', 'company', p_company_id,
    (select c.legal_name from public.companies c where c.id = p_company_id),
    'Cambió la configuración de control interno de la empresa', null, null, null,
    private.diff(v_before, v_after, array['sod_enabled', 'allow_negative_stock']));
end;
$$;
grant execute on function public.company_update_settings(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------ Administración escolar

create function public.course_create(p_academic_year int, p_name text, p_orientation text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_school_admin();
  v_name text := trim(coalesce(p_name, ''));
  v_id uuid;
begin
  if v_name = '' then
    perform private.raise_business_error('DATO_INVALIDO', 'Ingresá el nombre del curso (por ejemplo, "5.º A").');
  end if;
  if p_academic_year is null or p_academic_year not between 2020 and 2100 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá un año lectivo válido.');
  end if;
  if exists (select 1 from public.courses c where c.academic_year = p_academic_year and lower(c.name) = lower(v_name)) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe un curso "%s" en %s.', v_name, p_academic_year));
  end if;
  insert into public.courses (academic_year, name, orientation)
  values (p_academic_year, v_name, trim(coalesce(p_orientation, '')))
  returning id into v_id;
  perform private.log_audit(null, v_actor, 'CREATE', 'course', v_id, format('%s (%s)', v_name, p_academic_year),
    format('Dio de alta el curso %s (%s)', v_name, p_academic_year));
  return v_id;
end;
$$;
grant execute on function public.course_create(int, text, text) to authenticated;

-- Equivale a cmdUpdateSchoolSettings.
create function public.school_settings_update(p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_school_admin();
  v_official text := trim(coalesce(p_settings ->> 'official_name', ''));
  v_short text := trim(coalesce(p_settings ->> 'short_name', ''));
  v_email text := trim(coalesce(p_settings ->> 'contact_email', ''));
  v_minutes numeric := (p_settings ->> 'session_timeout_minutes')::numeric;
  v_before jsonb;
  v_after jsonb;
  v_keys text[] := array['official_name', 'short_name', 'city', 'province', 'contact_email', 'session_timeout_minutes'];
begin
  if length(v_official) < 3 then
    perform private.raise_business_error('DATO_INVALIDO', 'Ingresá el nombre oficial de la escuela.');
  end if;
  if length(v_short) not between 2 and 30 then
    perform private.raise_business_error('DATO_INVALIDO', 'El nombre corto debe tener entre 2 y 30 caracteres (por ejemplo, "ENS N.º 9").');
  end if;
  if v_email <> '' and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El email de contacto no es válido.');
  end if;
  if v_minutes is null or v_minutes <> trunc(v_minutes) or (v_minutes <> 0 and v_minutes not between 5 and 240) then
    perform private.raise_business_error('DATO_INVALIDO', 'El cierre por inactividad va de 5 a 240 minutos (o 0 para no cerrar la sesión).');
  end if;
  select to_jsonb(s) into v_before from public.school_settings s where s.id = 1 for update;
  update public.school_settings
     set official_name = v_official, short_name = v_short,
         city = trim(coalesce(p_settings ->> 'city', '')), province = trim(coalesce(p_settings ->> 'province', '')),
         contact_email = v_email, session_timeout_minutes = v_minutes::int,
         updated_at = now(), updated_by = (select auth.uid())
   where id = 1
  returning to_jsonb(school_settings) into v_after;
  if private.diff(v_before, v_after, v_keys) <> '{}'::jsonb then
    perform private.log_audit(null, v_actor, 'SETTINGS', 'school_settings', null, v_official,
      'Cambió los datos de la escuela', null, null, null, private.diff(v_before, v_after, v_keys));
  end if;
end;
$$;
grant execute on function public.school_settings_update(jsonb) to authenticated;

-- ------------------------------------------------------------------ Perfil propio

-- La contraseña la cambia Supabase Auth; esto libera el cambio obligatorio y lo audita.
create function public.profile_password_changed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
begin
  update public.profiles set must_change_password = false where id = v_uid;
  perform private.log_audit(null,
    row(v_uid, private.full_name(v_uid), (select p.app_role from public.profiles p where p.id = v_uid), null, '—')::private.actor,
    'CHANGE_PASSWORD', 'profile', v_uid, private.full_name(v_uid), 'Cambió su contraseña');
end;
$$;
grant execute on function public.profile_password_changed() to authenticated;
