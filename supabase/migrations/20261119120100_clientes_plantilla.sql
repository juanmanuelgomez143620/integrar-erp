-- 119. La empresa crece (Fase 9b.1, docs/FASE_9_LA_EMPRESA_CRECE.md): la plantilla que ya existía
-- suma los proveedores y los clientes de la demo que le falten, por código (los del banco de
-- contribuyentes ficticios), y el padrón del fisco los incluye; con ella, las empresas que se creen
-- después. Las empresas de los cursos ya creadas no cambian. Idempotente.

do $$
declare
  v_company uuid;
begin
  for v_company in select c.id from public.companies c where c.is_template order by c.created_at, c.id loop
    perform private.insert_demo_partners(v_company);
    perform private.insert_padron(v_company);
  end loop;
end;
$$;
