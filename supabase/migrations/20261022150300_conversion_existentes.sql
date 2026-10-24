-- 47. Fase 5b: las empresas que ya existían (la plantilla y las de los cursos)
-- reciben las cuentas de la conversión aplicada (las del plan básico que les
-- faltan) y su regla de imputación, y los centros de trabajo y las horas de la
-- demo en las listas de esos productos (como el paso v12 → v13 del simulador).
do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c order by c.created_at loop
    if exists (select 1 from public.accounts a where a.company_id = v_company) then
      perform private.insert_base_chart(v_company);
    end if;
    perform private.insert_base_posting_rules(v_company);
    perform private.insert_demo_work_centers(v_company);
    perform private.insert_demo_bom_operations(v_company);
  end loop;
end;
$$;
