-- 124. Las zonas de reparto (Fase 9c.1, docs/FASE_9_LA_EMPRESA_CRECE.md): la plantilla que ya existía
-- recibe las zonas de la demo que le falten y cada cliente suyo sin zona, la de la demo (por código);
-- con ella, las empresas que se creen después. Las empresas de los cursos ya creadas no cambian:
-- Logística puede crear sus zonas. Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c where c.is_template order by c.created_at, c.id loop
    perform private.insert_demo_zones(v_company);
    perform private.assign_demo_zones(v_company);
  end loop;
end;
$$;
