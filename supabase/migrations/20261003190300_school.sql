-- 4. Escuela: configuración (una sola fila), perfiles y cursos (DATABASE.md §4).

create table public.school_settings (
  id smallint primary key default 1 check (id = 1),
  official_name text not null,
  short_name text not null,
  logo_path text,
  city text not null default '',
  province text not null default '',
  contact_email text not null default '',
  timezone text not null default 'America/Argentina/Buenos_Aires',
  -- Minutos sin actividad antes de cerrar la sesión (computadoras compartidas); 0 = no se cierra.
  session_timeout_minutes int not null default 15
    check (session_timeout_minutes = 0 or session_timeout_minutes between 5 and 240),
  features jsonb not null default '{}',
  service_info jsonb not null default '{}', -- datos del contrato: sólo SUPERADMIN
  updated_at timestamptz,
  updated_by uuid
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9._-]{3,30}$'),
  first_name text not null,
  last_name text not null,
  app_role text not null default 'ESTUDIANTE' check (app_role in ('SUPERADMIN', 'ADMIN', 'DOCENTE', 'ESTUDIANTE')),
  is_active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
);

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  academic_year int not null check (academic_year between 2020 and 2100),
  name text not null check (length(trim(name)) > 0),
  orientation text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
);
create unique index courses_year_name_key on public.courses (academic_year, lower(name));

create trigger profiles_audit before insert or update on public.profiles
  for each row execute function private.set_audit_fields();
create trigger courses_audit before insert or update on public.courses
  for each row execute function private.set_audit_fields();

-- ------------------------------------------------------------------ Alta de usuarios
-- El perfil nace con el usuario de Auth. Las cuentas las crea el servidor (Edge
-- Function "admin-users"): el rol de la aplicación sale SÓLO de
-- raw_app_meta_data, que un usuario no puede escribir; de raw_user_meta_data
-- (editable por el propio usuario al registrarse) jamás se toma un rol. Sin
-- usuario válido el alta falla: un registro público sin datos no crea perfil.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_app_meta_data, '{}');
begin
  insert into public.profiles (id, username, first_name, last_name, app_role, must_change_password)
  values (
    new.id,
    lower(trim(v_meta ->> 'username')),
    trim(coalesce(v_meta ->> 'first_name', '')),
    trim(coalesce(v_meta ->> 'last_name', '')),
    coalesce(v_meta ->> 'app_role', 'ESTUDIANTE'),
    coalesce((v_meta ->> 'must_change_password')::boolean, true)
  );
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ------------------------------------------------------------------ Funciones de identidad
-- Toda decisión exige un perfil ACTIVO en ese momento, no sólo al ingresar:
-- si el docente desactiva a un estudiante, pierde el acceso en el próximo pedido.

create function private.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.app_role from public.profiles p where p.id = (select auth.uid()) and p.is_active
$$;

create function private.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select coalesce(private.current_app_role() = 'SUPERADMIN', false) $$;

-- ADMIN es la administración de la escuela (docentes, cursos, datos de la
-- escuela): no opera dentro de las empresas simuladas.
create function private.is_school_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select coalesce(private.current_app_role() in ('ADMIN', 'SUPERADMIN'), false) $$;

grant execute on function private.current_app_role() to authenticated;
grant execute on function private.is_superadmin() to authenticated;
grant execute on function private.is_school_admin() to authenticated;

-- ------------------------------------------------------------------ Seguridad
alter table public.school_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.courses enable row level security;
revoke all on table public.school_settings, public.profiles, public.courses from anon, authenticated;

-- school_settings: sin acceso directo (se lee con my_context y public_school_info).
-- profiles: su política necesita las membresías (migración de empresas).
-- Los cursos no son datos sensibles: cualquier usuario activo los consulta.
grant select on table public.courses to authenticated;
create policy courses_select on public.courses for select to authenticated
  using ((select private.current_app_role()) is not null);
