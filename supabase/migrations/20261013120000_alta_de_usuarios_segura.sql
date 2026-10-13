-- 16. Alta de usuarios segura. Reemplaza la versión de 20261011_fix_handle_new_user,
-- que tomaba los datos del perfil (rol incluido) de raw_user_meta_data cuando
-- faltaban los del servidor, y activaba cuentas sin datos válidos.
--
-- Reglas:
-- 1. El perfil y su rol salen SÓLO de raw_app_meta_data, que escribe el servidor
--    (Edge Function "admin-users" o SQL de soporte). raw_user_meta_data, que el
--    propio usuario puede elegir al registrarse, nunca se lee.
-- 2. Una cuenta sin esos datos (por ejemplo, creada a mano desde el panel de
--    Supabase) nace PENDIENTE: inactiva, como estudiante y sin empresas. No puede
--    hacer nada.
-- 3. Cuando el servidor carga los datos en raw_app_meta_data, el perfil pendiente
--    se completa y se activa solo. A un usuario que el docente desactivó no lo
--    reactiva ningún cambio en sus metadatos.

alter table public.profiles add column setup_pending boolean not null default false;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_app_meta_data, '{}');
  v_username text := lower(btrim(coalesce(v_meta ->> 'username', '')));
  v_complete boolean := v_username ~ '^[a-z0-9._-]{3,30}$';
begin
  insert into public.profiles (id, username, first_name, last_name, app_role, is_active, must_change_password, setup_pending)
  values (
    new.id,
    case
      when v_complete then v_username
      -- Usuario provisorio desde el email (jgomez@… → jgomez), único y válido.
      else private.unique_username(regexp_replace(lower(split_part(coalesce(new.email, ''), '@', 1)), '[^a-z0-9._-]', '', 'g'), '{}')
    end,
    btrim(coalesce(v_meta ->> 'first_name', '')),
    btrim(coalesce(v_meta ->> 'last_name', '')),
    case when v_complete then coalesce(v_meta ->> 'app_role', 'ESTUDIANTE') else 'ESTUDIANTE' end,
    v_complete,
    coalesce((v_meta ->> 'must_change_password')::boolean, true),
    not v_complete
  );
  return new;
end;
$$;

-- Completa un perfil pendiente cuando el servidor carga sus datos. Sólo el
-- servidor puede escribir raw_app_meta_data, y sólo actúa sobre perfiles
-- pendientes: nunca reactiva a alguien desactivado.
create function private.complete_pending_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_app_meta_data, '{}');
  v_username text := lower(btrim(coalesce(v_meta ->> 'username', '')));
begin
  if v_username ~ '^[a-z0-9._-]{3,30}$' then
    update public.profiles p
       set username = v_username,
           first_name = btrim(coalesce(v_meta ->> 'first_name', p.first_name)),
           last_name = btrim(coalesce(v_meta ->> 'last_name', p.last_name)),
           app_role = coalesce(v_meta ->> 'app_role', 'ESTUDIANTE'),
           must_change_password = coalesce((v_meta ->> 'must_change_password')::boolean, true),
           is_active = true,
           setup_pending = false
     where p.id = new.id and p.setup_pending;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_app_metadata after update of raw_app_meta_data on auth.users
  for each row when (new.raw_app_meta_data is distinct from old.raw_app_meta_data)
  execute function private.complete_pending_profile();
