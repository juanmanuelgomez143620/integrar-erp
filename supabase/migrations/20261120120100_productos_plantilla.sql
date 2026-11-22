-- 121. La empresa crece (Fase 9b.2, docs/FASE_9_LA_EMPRESA_CRECE.md): la plantilla que ya existía
-- suma los productos de la demo que le falten (las líneas de dormitorio, oficina y escolar, y living
-- con tapicería, con sus materiales), el centro de trabajo de tapicería, las listas de materiales y
-- sus horas, la categoría y los legajos de tapicería, y el inventario inicial de los productos que
-- nunca tuvieron stock; con ella, las empresas que se creen después. Las empresas de los cursos ya
-- creadas no cambian. Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c where c.is_template order by c.created_at, c.id loop
    perform private.insert_demo_products(v_company);
    perform private.insert_demo_work_centers(v_company);
    perform private.insert_demo_boms(v_company);
    perform private.insert_demo_bom_operations(v_company);
    perform private.insert_demo_job_categories(v_company);
    perform private.insert_demo_employees(v_company);
    perform private.post_demo_initial_stock(v_company);
    perform private.scan_stock_alerts(v_company);
  end loop;
end;
$$;
