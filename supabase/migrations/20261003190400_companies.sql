-- 5. Empresas simuladas, estructura, membresías y permisos efectivos
-- (DATABASE.md §4, §5 y §11.1). Las reglas son las del motor simulado, que es
-- la especificación ejecutable: effectivePermissions, requirePermission y
-- actorFor en src/lib/mock/engine.ts.

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  course_id uuid references public.courses (id),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  legal_name text not null,
  trade_name text not null default '',
  tax_id text not null,
  vat_condition text not null default 'RESPONSABLE_INSCRIPTO'
    check (vat_condition in ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL')),
  activity text not null default '',
  address_line text not null default '',
  city text not null default '',
  province text not null default '',
  start_date date,
  simulation_date date, -- fecha de negocio simulada (null = hoy)
  is_template boolean not null default false,
  status text not null default 'ACTIVA' check (status in ('ACTIVA', 'ARCHIVADA')),
  settings jsonb not null default '{"sod_enabled": true, "allow_negative_stock": false}',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
);

create table public.islands (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  number int not null,
  name text not null,
  unique (company_id, number),
  unique (company_id, id)
);

create table public.sectors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null,
  name text not null,
  island_id uuid,
  unique (company_id, code),
  unique (company_id, id),
  foreign key (company_id, island_id) references public.islands (company_id, id)
);

create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null,
  name text not null,
  is_active boolean not null default true,
  unique (company_id, code),
  unique (company_id, id)
);

create table public.company_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  job_title text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, user_id),
  unique (company_id, id)
);
create index company_members_user_idx on public.company_members (user_id);

create table public.member_roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  member_id uuid not null,
  role_code text not null references public.roles (code),
  sector_id uuid,
  foreign key (company_id, member_id) references public.company_members (company_id, id) on delete cascade,
  foreign key (company_id, sector_id) references public.sectors (company_id, id),
  unique nulls not distinct (member_id, role_code, sector_id)
);
create index member_roles_member_idx on public.member_roles (member_id);

create table public.company_modules (
  company_id uuid not null references public.companies (id) on delete cascade,
  module_code text not null references public.modules (code),
  is_enabled boolean not null default true,
  updated_at timestamptz,
  updated_by uuid,
  primary key (company_id, module_code)
);

-- Reglas de aprobación: estructura de la empresa (se copian con la plantilla).
create table public.approval_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  doc_type text not null references public.document_types (code),
  level int not null default 1,
  min_amount numeric(14, 2) not null default 0,
  max_amount numeric(14, 2), -- null = sin tope
  approver_role text not null references public.roles (code),
  require_different_user boolean not null default true, -- separación de funciones
  description text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, id),
  check (max_amount is null or max_amount >= min_amount)
);

create trigger companies_audit before insert or update on public.companies
  for each row execute function private.set_audit_fields();
create trigger company_members_audit before insert or update on public.company_members
  for each row execute function private.set_audit_fields();
create trigger approval_rules_audit before insert or update on public.approval_rules
  for each row execute function private.set_audit_fields();

do $$
declare
  t text;
begin
  foreach t in array array['islands', 'sectors', 'warehouses', 'company_members', 'member_roles', 'company_modules', 'approval_rules'] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.prevent_company_change()',
      t || '_same_company', t
    );
  end loop;
end;
$$;

-- ------------------------------------------------------------------ Permisos efectivos

-- Roles del usuario en la empresa (integrante activo con perfil activo).
create function private.my_role_codes(p_company uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select mr.role_code
    from public.company_members m
    join public.member_roles mr on mr.company_id = m.company_id and mr.member_id = m.id
   where m.company_id = p_company
     and m.user_id = (select auth.uid())
     and m.is_active
     and private.current_app_role() is not null
$$;

-- SUPERADMIN (el proveedor) y el rol DOCENTE son supervisores: todos los permisos.
create function private.is_supervisor(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_superadmin()
      or exists (
        select 1 from private.my_role_codes(p_company) as rc (code)
          join public.roles r on r.code = rc.code
         where r.is_supervisor
      )
$$;

-- El núcleo nunca se bloquea; sin fila en company_modules, el módulo está habilitado.
create function private.module_enabled(p_company uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select not mo.is_lockable
         or coalesce((select cm.is_enabled from public.company_modules cm
                       where cm.company_id = p_company and cm.module_code = p_module), true)
       from public.modules mo where mo.code = p_module),
    true
  )
$$;

create function private.has_permission(p_company uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_supervisor(p_company)
      or exists (
        select 1 from private.my_role_codes(p_company) as rc (code)
          join public.role_permissions rp on rp.role_code = rc.code and rp.permission_code = p_permission
          join public.permissions pe on pe.code = rp.permission_code
         where private.module_enabled(p_company, pe.module_code)
      )
$$;

-- Para RLS: conjuntos que se evalúan una vez por consulta (DATABASE.md §11.1).
create function private.my_companies()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.companies c where private.is_superadmin()
  union
  select m.company_id from public.company_members m
   where m.user_id = (select auth.uid()) and m.is_active and private.current_app_role() is not null
$$;

create function private.companies_with_permission(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.companies c where private.is_superadmin()
  union
  select m.company_id
    from public.company_members m
    join public.member_roles mr on mr.company_id = m.company_id and mr.member_id = m.id
    join public.roles r on r.code = mr.role_code
   where m.user_id = (select auth.uid())
     and m.is_active
     and private.current_app_role() is not null
     and (
       r.is_supervisor
       or exists (
         select 1 from public.role_permissions rp
           join public.permissions pe on pe.code = rp.permission_code
          where rp.role_code = r.code
            and rp.permission_code = p_permission
            and private.module_enabled(m.company_id, pe.module_code)
       )
     )
$$;

create function private.supervised_companies()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.companies c where private.is_superadmin()
  union
  select m.company_id
    from public.company_members m
    join public.member_roles mr on mr.company_id = m.company_id and mr.member_id = m.id
    join public.roles r on r.code = mr.role_code and r.is_supervisor
   where m.user_id = (select auth.uid()) and m.is_active and private.current_app_role() is not null
$$;

-- Perfiles visibles: el propio, los de las empresas donde participa y, para la
-- administración escolar, todos (nombre, apellido y usuario: nada más).
create function private.visible_profile_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) where private.current_app_role() is not null
  union
  select p.id from public.profiles p where private.is_school_admin()
  union
  select m.user_id from public.company_members m where m.company_id in (select private.my_companies())
$$;

grant execute on function private.my_companies() to authenticated;
grant execute on function private.companies_with_permission(text) to authenticated;
grant execute on function private.supervised_companies() to authenticated;
grant execute on function private.visible_profile_ids() to authenticated;

-- ------------------------------------------------------------------ Actor y exigencias
-- Quién actúa, con qué rol y desde qué sector: queda en la auditoría.
create type private.actor as (user_id uuid, name text, role_code text, sector_id uuid, sector_name text);

create function private.full_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.first_name || ' ' || p.last_name from public.profiles p where p.id = p_user), 'Sistema')
$$;

create function private.require_active_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    perform private.raise_business_error('SIN_SESION', 'Tu sesión terminó. Volvé a ingresar.');
  end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.is_active) then
    perform private.raise_business_error('USUARIO_INACTIVO', 'Tu usuario está desactivado. Consultá a tu docente.');
  end if;
  return v_uid;
end;
$$;

-- Mismo orden que actorFor: el rol preferido; si no, un rol (no supervisor)
-- que tenga el permiso usado; si no, el de supervisor; si no, SUPERADMIN; si
-- no, el primero.
create function private.actor_for(p_company uuid, p_permission text default null, p_prefer_role text default null)
returns private.actor
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_app_role text;
  v_role record;
begin
  if v_uid is null then
    return row(null, 'Sistema', 'SISTEMA', null, '—')::private.actor;
  end if;
  select p.app_role into v_app_role from public.profiles p where p.id = v_uid;
  if v_app_role is null then
    perform private.raise_business_error('SIN_SESION', 'La sesión no es válida. Volvé a ingresar.');
  end if;
  select mr.role_code, mr.sector_id, coalesce(s.name, '—') as sector_name,
         (p_prefer_role is not null and mr.role_code = p_prefer_role) as preferred,
         (p_permission is not null and not r.is_supervisor and exists (
            select 1 from public.role_permissions rp
             where rp.role_code = mr.role_code and rp.permission_code = p_permission)) as grants,
         r.is_supervisor
    into v_role
    from public.company_members m
    join public.member_roles mr on mr.company_id = m.company_id and mr.member_id = m.id
    join public.roles r on r.code = mr.role_code
    left join public.sectors s on s.company_id = mr.company_id and s.id = mr.sector_id
   where m.company_id = p_company and m.user_id = v_uid and m.is_active
   order by 4 desc, 5 desc, r.is_supervisor desc, r.sort
   limit 1;
  if found and (v_role.preferred or v_role.grants or v_role.is_supervisor or v_app_role <> 'SUPERADMIN') then
    return row(v_uid, private.full_name(v_uid), v_role.role_code, v_role.sector_id, v_role.sector_name)::private.actor;
  end if;
  return row(v_uid, private.full_name(v_uid), v_app_role, null, '—')::private.actor;
end;
$$;

create function private.roles_with_permission(p_permission text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(string_agg(r.name, ', ' order by r.sort), 'Docente')
    from public.roles r
    join public.role_permissions rp on rp.role_code = r.code
   where rp.permission_code = p_permission
$$;

create function private.require_permission(p_company uuid, p_permission text)
returns private.actor
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_module text;
begin
  perform private.require_active_user();
  if not private.has_permission(p_company, p_permission) then
    select pe.module_code into v_module from public.permissions pe where pe.code = p_permission;
    if v_module is not null and not private.module_enabled(p_company, v_module) then
      perform private.raise_business_error(
        'MODULO_BLOQUEADO',
        format('El módulo "%s" está bloqueado por el docente.', (select mo.name from public.modules mo where mo.code = v_module))
      );
    end if;
    perform private.raise_business_error(
      'SIN_PERMISO',
      format('Tu rol no tiene permiso para esta acción. Corresponde a: %s.', private.roles_with_permission(p_permission)),
      'Cada sector tiene funciones propias. Pedí la intervención del sector que corresponde.'
    );
  end if;
  return private.actor_for(p_company, p_permission);
end;
$$;

create function private.require_supervisor(p_company uuid)
returns private.actor
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  if not private.is_supervisor(p_company) then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo el docente o la administración de la escuela pueden hacer esto.');
  end if;
  return private.actor_for(p_company);
end;
$$;

create function private.require_school_admin()
returns private.actor
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_active_user();
begin
  if not private.is_school_admin() then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo la administración de la escuela puede hacer esto.');
  end if;
  return row(v_uid, private.full_name(v_uid), private.current_app_role(), null, '—')::private.actor;
end;
$$;

-- ------------------------------------------------------------------ Seguridad
-- Sólo lectura filtrada por RLS: toda escritura pasa por funciones RPC.
do $$
declare
  t text;
begin
  foreach t in array array[
    'companies', 'islands', 'sectors', 'warehouses', 'company_members', 'member_roles', 'company_modules', 'approval_rules'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end;
$$;

grant select on table public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated
  using (id in (select private.visible_profile_ids()));

create policy companies_select on public.companies for select to authenticated
  using (id in (select private.my_companies()));
create policy islands_select on public.islands for select to authenticated
  using (company_id in (select private.my_companies()));
create policy sectors_select on public.sectors for select to authenticated
  using (company_id in (select private.my_companies()));
create policy warehouses_select on public.warehouses for select to authenticated
  using (company_id in (select private.my_companies()));
create policy company_modules_select on public.company_modules for select to authenticated
  using (company_id in (select private.my_companies()));
create policy approval_rules_select on public.approval_rules for select to authenticated
  using (company_id in (select private.my_companies()));
-- Integrantes y roles: los propios, o todos los de la empresa para el docente.
create policy company_members_select on public.company_members for select to authenticated
  using (user_id = (select auth.uid()) or company_id in (select private.supervised_companies()));
create policy member_roles_select on public.member_roles for select to authenticated
  using (
    company_id in (select private.supervised_companies())
    or exists (
      select 1 from public.company_members m
       where m.id = member_roles.member_id and m.user_id = (select auth.uid())
    )
  );
