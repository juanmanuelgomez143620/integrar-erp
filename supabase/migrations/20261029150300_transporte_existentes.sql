-- 75. Las empresas creadas antes de la Fase 7c (también la plantilla, que ya existía) reciben
-- los transportistas y el camión propio de la demo (UPGRADES[19] de src/lib/mock/db.ts).
-- Idempotente: no repite un código ni un dominio que la empresa ya tenga.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at, c.id loop
    perform private.insert_demo_carriers(v_company);
    perform private.insert_demo_vehicles(v_company);
  end loop;
end;
$$;
