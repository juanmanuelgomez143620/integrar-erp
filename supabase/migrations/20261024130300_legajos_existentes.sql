-- 49. Las empresas creadas antes de la Fase 6a (también la plantilla, que ya existía)
-- reciben las categorías del personal que les falten y, si todavía no tienen legajos,
-- el personal de la demo, con sus sectores y centros de trabajo por código
-- (UPGRADES[13] de src/lib/mock/db.ts). Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.insert_demo_job_categories(v_company);
    perform private.insert_demo_employees(v_company);
  end loop;
end;
$$;
