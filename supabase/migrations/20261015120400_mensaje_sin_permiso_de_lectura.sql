-- 20. Igual que antes, con un mensaje que entiende un estudiante cuando abre
-- el enlace de una pantalla de otro sector (assertPerm en queries.ts).
create or replace function private.require_read(p_company uuid, p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_active_user();
  if p_permission is null or not private.has_permission(p_company, p_permission) then
    perform private.raise_business_error('SIN_PERMISO', 'Tu rol no tiene acceso a esta información.');
  end if;
end;
$$;
