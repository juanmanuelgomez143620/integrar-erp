-- 15. Cuentas de usuario (MVP.md, H-21, H-25 y H-26). Las contraseñas viven en
-- Supabase Auth, que sólo se administra con la clave de servicio: la Edge
-- Function "admin-users" crea las cuentas y cambia contraseñas. Estas funciones
-- —que esa función llama con la sesión de quien opera— validan con los mismos
-- mensajes que el motor simulado, eligen los nombres de usuario y dejan la
-- membresía y la auditoría. Ninguna recibe contraseñas.
--
-- Paso a paso: *_check / students_plan validan sin escribir; la Edge Function
-- crea o modifica la cuenta en Auth; *_register / member_password_reset
-- registran el resultado. Si Auth falla, no queda nada a medias en la base.

-- ------------------------------------------------------------------ Nombres de usuario

create function private.strip_accents(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(coalesce(p_text, ''), 'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇáàäâãéèëêíìïîóòöôõúùüûñç',
                                         'AAAAAEEEEIIIIOOOOOUUUUNCaaaaaeeeeiiiiooooouuuunc')
$$;

-- "Juan Manuel", "Gómez Paz" → "jgomez" (baseUsername en src/lib/domain/students.ts).
create function private.base_username(p_first_name text, p_last_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
    lower(
      left(private.strip_accents(btrim(coalesce(p_first_name, ''))), 1)
      || private.strip_accents(split_part(regexp_replace(btrim(coalesce(p_last_name, '')), '\s+', ' ', 'g'), ' ', 1))
    ),
    '[^a-z0-9]', '', 'g')
$$;

-- Primer usuario libre: jgomez, jgomez2, jgomez3… (uniqueUsername), contra los
-- usuarios existentes y los ya elegidos en la misma alta.
create function private.unique_username(p_base text, p_taken text[])
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_root text := coalesce(nullif(p_base, ''), 'estudiante');
  v_taken text[] := coalesce(p_taken, '{}');
  v_n int := 2;
begin
  if length(v_root) < 3 then
    v_root := rpad(v_root, 3, '0');
  end if;
  v_root := left(v_root, 26);
  if not (v_root = any (v_taken)) and not exists (select 1 from public.profiles p where p.username = v_root) then
    return v_root;
  end if;
  while (v_root || v_n) = any (v_taken) or exists (select 1 from public.profiles p where p.username = v_root || v_n) loop
    v_n := v_n + 1;
  end loop;
  return v_root || v_n;
end;
$$;

-- Datos de una persona nueva (cmdCreateStudent, cmdCreateTeacher): devuelve el usuario normalizado.
create function private.check_new_person(p_first_name text, p_last_name text, p_username text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
begin
  if v_username !~ '^[a-z0-9._-]{3,30}$' then
    perform private.raise_business_error('DATO_INVALIDO',
      'El usuario debe tener entre 3 y 30 caracteres: letras, números, punto o guion.');
  end if;
  if exists (select 1 from public.profiles p where p.username = v_username) then
    perform private.raise_business_error('DATO_INVALIDO', format('El usuario %s ya existe.', v_username));
  end if;
  if length(btrim(coalesce(p_first_name, ''))) < 2 or length(btrim(coalesce(p_last_name, ''))) < 2 then
    perform private.raise_business_error('DATO_INVALIDO', 'Ingresá nombre y apellido.');
  end if;
  return v_username;
end;
$$;

-- ------------------------------------------------------------------ Estudiantes

-- Alta individual, paso 1: valida (el docente elige usuario y contraseña inicial).
create function public.student_check(p_company_id uuid, p_first_name text, p_last_name text, p_username text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_supervisor(p_company_id);
  return private.check_new_person(p_first_name, p_last_name, p_username);
end;
$$;

-- Alta masiva, paso 1: valida toda la lista antes de crear a nadie y elige
-- usuarios únicos (cmdCreateStudentsBulk). Devuelve [{first_name, last_name, username}].
create function public.students_plan(p_company_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_max constant int := 60; -- MAX_BULK_STUDENTS
  v_rows jsonb := case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]' end;
  v_row jsonb;
  v_i int := 0;
  v_taken text[] := '{}';
  v_username text;
  v_out jsonb := '[]';
begin
  perform private.require_supervisor(p_company_id);
  if jsonb_array_length(v_rows) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Pegá al menos un estudiante.');
  end if;
  if jsonb_array_length(v_rows) > v_max then
    perform private.raise_business_error('DATO_INVALIDO', format('Se pueden dar de alta hasta %s estudiantes por vez.', v_max));
  end if;
  for v_row in select * from jsonb_array_elements(v_rows) loop
    v_i := v_i + 1;
    if length(btrim(coalesce(v_row ->> 'first_name', ''))) < 2 or length(btrim(coalesce(v_row ->> 'last_name', ''))) < 2 then
      perform private.raise_business_error('DATO_INVALIDO',
        format('Fila %s: el apellido y el nombre deben tener al menos 2 letras.', v_i));
    end if;
  end loop;
  for v_row in select * from jsonb_array_elements(v_rows) loop
    v_username := private.unique_username(private.base_username(v_row ->> 'first_name', v_row ->> 'last_name'), v_taken);
    v_taken := v_taken || v_username;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'first_name', btrim(v_row ->> 'first_name'), 'last_name', btrim(v_row ->> 'last_name'), 'username', v_username));
  end loop;
  return v_out;
end;
$$;

-- Paso final de cualquier alta de estudiantes: las cuentas ya existen en Auth
-- (su perfil nació con ellas); se incorporan a la empresa y se audita a
-- nombre del docente. Sólo cuentas de estudiante recién creadas, que todavía
-- no participan en ninguna empresa.
create function public.students_register(p_company_id uuid, p_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company_id);
  v_user uuid;
  v_profile public.profiles;
begin
  foreach v_user in array coalesce(p_user_ids, '{}') loop
    select * into v_profile from public.profiles p where p.id = v_user;
    if not found or v_profile.app_role <> 'ESTUDIANTE'
       or exists (select 1 from public.company_members m where m.user_id = v_user) then
      perform private.raise_business_error('DATO_INVALIDO', 'La cuenta no corresponde a un estudiante nuevo.');
    end if;
    insert into public.company_members (company_id, user_id, job_title) values (p_company_id, v_user, '');
    perform private.log_audit(p_company_id, v_actor, 'CREATE', 'profile', v_user, private.full_name(v_user),
      format('Dio de alta al estudiante %s (%s)', private.full_name(v_user), v_profile.username));
  end loop;
end;
$$;

-- ------------------------------------------------------------------ Contraseñas

-- Restablecer la contraseña de un integrante (cmdResetPassword). Sólo de
-- estudiantes: un docente no puede tomar la cuenta de otro docente ni de
-- soporte por compartir una empresa.
create function private.check_password_reset(p_company uuid, p_user uuid)
returns private.actor
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_supervisor(p_company);
begin
  if not exists (select 1 from public.company_members m where m.company_id = p_company and m.user_id = p_user) then
    perform private.raise_business_error('DATO_INVALIDO', 'El usuario no participa en esta empresa.');
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user) then
    perform private.raise_business_error('DATO_INVALIDO', 'El usuario no existe.');
  end if;
  if (select p.app_role from public.profiles p where p.id = p_user) <> 'ESTUDIANTE' then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo se puede restablecer la contraseña de un estudiante.');
  end if;
  return v_actor;
end;
$$;

create function public.member_password_check(p_company_id uuid, p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.check_password_reset(p_company_id, p_user_id);
end;
$$;

-- Después de cambiarla en Auth: obliga a elegir una nueva al ingresar y lo audita.
create function public.member_password_reset(p_company_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.check_password_reset(p_company_id, p_user_id);
begin
  update public.profiles set must_change_password = true where id = p_user_id;
  perform private.log_audit(p_company_id, v_actor, 'RESET_PASSWORD', 'profile', p_user_id, private.full_name(p_user_id),
    format('Restableció la contraseña de %s', private.full_name(p_user_id)));
end;
$$;

-- ------------------------------------------------------------------ Docentes

create function public.teacher_check(p_first_name text, p_last_name text, p_username text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_school_admin();
  return private.check_new_person(p_first_name, p_last_name, p_username);
end;
$$;

create function public.teacher_register(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_school_admin();
  v_profile public.profiles;
begin
  select * into v_profile from public.profiles p where p.id = p_user_id;
  if not found or v_profile.app_role <> 'DOCENTE' then
    perform private.raise_business_error('DATO_INVALIDO', 'La cuenta no corresponde a un docente.');
  end if;
  perform private.log_audit(null, v_actor, 'CREATE', 'profile', p_user_id, private.full_name(p_user_id),
    format('Dio de alta al docente %s (%s)', private.full_name(p_user_id), v_profile.username));
end;
$$;

-- Directorio de usuarios de la escuela: sólo la administración escolar (no se
-- expone a estudiantes ni a docentes de otras empresas).
create function public.users_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  if not private.is_school_admin() then
    perform private.raise_business_error('SIN_PERMISO', 'Sólo la administración de la escuela puede ver esto.');
  end if;
  return coalesce((
    select jsonb_agg(private.public_profile_json(p.id)
                     order by private.sort_key(p.last_name) collate "C", private.sort_key(p.first_name) collate "C",
                              p.username collate "C")
      from public.profiles p
  ), '[]');
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'users_list()',
    'student_check(uuid, text, text, text)', 'students_plan(uuid, jsonb)', 'students_register(uuid, uuid[])',
    'member_password_check(uuid, uuid)', 'member_password_reset(uuid, uuid)',
    'teacher_check(text, text, text)', 'teacher_register(uuid)'
  ] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
