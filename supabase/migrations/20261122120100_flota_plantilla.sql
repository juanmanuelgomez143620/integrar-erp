-- 126. La flota (Fase 9c.2, docs/FASE_9_LA_EMPRESA_CRECE.md): la plantilla que ya existía suma los
-- transportistas y los vehículos propios de la demo que le falten, por código (un tercer flete, un
-- segundo camión y dos furgones); con ella, las empresas que se creen después, que arman su apertura
-- con los rodados nuevos. Las empresas de los cursos ya creadas no cambian. Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c where c.is_template order by c.created_at, c.id loop
    perform private.insert_demo_carriers(v_company);
    perform private.insert_demo_vehicles(v_company);
  end loop;
end;
$$;
