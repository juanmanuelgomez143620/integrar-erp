-- 1. Esquemas y utilidades base (DATABASE.md §17).
--
-- public  → tablas de negocio (sólo lectura con RLS) y funciones RPC.
-- private → funciones internas: permisos, transiciones, stock, auditoría.
--           No se expone a la API ni a los roles de la aplicación.

create schema if not exists private;
revoke all on schema private from public;
-- Las políticas RLS se evalúan con los permisos de quien consulta, así que
-- "authenticated" necesita usar el esquema para invocar las funciones
-- auxiliares de permisos (que se habilitan una por una). PostgREST no expone
-- "private": nadie puede llamarlas desde la API.
grant usage on schema private to authenticated;

-- Ninguna función nueva queda ejecutable por cualquiera: cada RPC otorga
-- explícitamente el permiso a "authenticated" (o a "anon" si es pública).
-- PUBLIC tiene EXECUTE por defecto a nivel global (no se revoca por esquema).
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- ------------------------------------------------------------------ Errores de negocio
-- Código estable en DETAIL, mensaje para el estudiante y pista pedagógica
-- opcional (ARCHITECTURE.md §7.4). PostgREST los entrega como
-- { code: 'P0001', message, details, hint }.
create function private.raise_business_error(p_code text, p_message text, p_hint text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_hint is null then
    raise exception using errcode = 'P0001', message = p_message, detail = p_code;
  end if;
  raise exception using errcode = 'P0001', message = p_message, detail = p_code, hint = p_hint;
end;
$$;

-- ------------------------------------------------------------------ Columnas de registro
-- created_* al insertar y updated_* al modificar, con el usuario de la sesión.
create function private.set_audit_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, now());
    new.created_by := coalesce(new.created_by, (select auth.uid()));
  end if;
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

-- Una fila nunca cambia de empresa (DATABASE.md §11.4).
create function private.prevent_company_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id then
    perform private.raise_business_error('DATO_INVALIDO', 'Un registro no puede cambiar de empresa.');
  end if;
  return new;
end;
$$;

-- Tablas de sólo inserción: auditoría y kardex (DATABASE.md §14.1, invariante 8).
create function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.raise_business_error('INMUTABLE', format('Los registros de %s no se modifican ni se borran.', tg_table_name));
  return null;
end;
$$;
