-- 97. Fase 8d.1 (docs/FASE_8_BANCO_Y_FISCO.md §4): las empresas que ya existían (la plantilla y las
-- de los cursos) reciben su padrón del fisco simulado: la empresa y sus proveedores y clientes con un
-- CUIT válido (UPGRADES[27] de src/lib/mock/db.ts). Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.insert_padron(v_company);
  end loop;
end;
$$;
