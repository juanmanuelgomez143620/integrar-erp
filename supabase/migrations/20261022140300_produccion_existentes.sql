-- 43. Fase 5a: las empresas que ya existían (la plantilla y las de los cursos)
-- reciben las reglas de imputación del consumo de producción y de la producción
-- terminada, y las listas de materiales de los muebles de la demo si tienen esos
-- productos y todavía no tienen lista (como el paso v11 → v12 del simulador).
do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at loop
    perform private.insert_base_posting_rules(v_company);
    perform private.insert_demo_boms(v_company);
  end loop;
end;
$$;
