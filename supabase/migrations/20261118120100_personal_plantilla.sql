-- 116. La empresa crece (Fase 9a, docs/FASE_9_LA_EMPRESA_CRECE.md): la plantilla que ya existía
-- suma las categorías y los legajos de la demo que le falten, por número, y con ella las empresas
-- que se creen después (que arman su apertura, con los fondos nuevos, al crearse). Las empresas de
-- los cursos ya creadas no cambian. Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c where c.is_template order by c.created_at, c.id loop
    perform private.insert_demo_job_categories(v_company);
    perform private.insert_demo_employees(v_company);
  end loop;
end;
$$;
