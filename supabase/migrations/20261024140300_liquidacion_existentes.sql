-- 53. Las empresas creadas antes de la Fase 6b reciben la cuenta de la mano de obra
-- directa real (5.1.03.01, si ya tienen plan de cuentas) y las reglas del asiento de
-- sueldos (UPGRADES[14] de src/lib/mock/db.ts). Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    if exists (select 1 from public.accounts a where a.company_id = v_company) then
      perform private.insert_base_chart(v_company);
    end if;
    perform private.insert_base_posting_rules(v_company);
  end loop;
end;
$$;
