-- 61. Las empresas creadas antes de la Fase 7a reciben las reglas de los asientos del IVA y
-- de su pago (UPGRADES[16] de src/lib/mock/db.ts). Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.insert_base_posting_rules(v_company);
  end loop;
end;
$$;
